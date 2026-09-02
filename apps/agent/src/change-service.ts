import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import type { ChangeSet, ChangeValidation, ChangeValidationState, ProposedFileChange } from '@devpilot/contracts';

import { ActivityStore } from './activity-store.js';
import { CodexCliProvider, type CodexContextFile } from './codex-cli-provider.js';
import { AgentError } from './errors.js';
import { FixRequestService } from './fix-request-service.js';
import { ProjectSessionService } from './project-session-service.js';

interface ChangeSetRow {
  readonly id: string;
  readonly fix_request_id: string;
  readonly state: 'proposed' | 'applied' | 'reverted' | 'conflicted';
  readonly summary: string;
  readonly risks_json: string;
  readonly created_at: string;
  readonly applied_at: string | null;
  readonly validation_state: ChangeValidationState;
  readonly validation_detail: string | null;
  readonly validated_at: string | null;
}

interface ChangeFileRow {
  readonly change_set_id: string;
  readonly path: string;
  readonly before_sha256: string;
  readonly after_sha256: string;
  readonly before_content: string;
  readonly after_content: string;
  readonly additions: number;
  readonly deletions: number;
}

interface SourceFile extends CodexContextFile {
  readonly absolutePath: string;
  readonly beforeSha256: string;
}

export class ChangeService {
  readonly #database: DatabaseSync;

  constructor(
    databasePath: string,
    private readonly activities: ActivityStore,
    private readonly fixRequests: FixRequestService,
    private readonly projectSessions: ProjectSessionService,
    private readonly codex = new CodexCliProvider(),
  ) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec('PRAGMA busy_timeout = 5000;');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS change_sets (
        id TEXT PRIMARY KEY,
        fix_request_id TEXT NOT NULL,
        state TEXT NOT NULL,
        summary TEXT NOT NULL,
        risks_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        applied_at TEXT,
        validation_state TEXT NOT NULL DEFAULT 'not_run',
        validation_detail TEXT,
        validated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS change_set_files (
        change_set_id TEXT NOT NULL,
        path TEXT NOT NULL,
        before_sha256 TEXT NOT NULL,
        after_sha256 TEXT NOT NULL,
        before_content TEXT NOT NULL,
        after_content TEXT NOT NULL,
        additions INTEGER NOT NULL,
        deletions INTEGER NOT NULL,
        PRIMARY KEY (change_set_id, path)
      );
    `);
    this.#ensureColumn('validation_state', "TEXT NOT NULL DEFAULT 'not_run'");
    this.#ensureColumn('validation_detail', 'TEXT');
    this.#ensureColumn('validated_at', 'TEXT');
  }

  async generate(fixRequestId: string): Promise<ChangeSet> {
    const request = this.fixRequests.get(fixRequestId);
    if (request.state !== 'approved') {
      throw invalid('修正案を生成する前に、スマートフォンで修正指示を承認してください。');
    }
    const project = this.projectSessions.projectForSession(request.sessionId);
    const sourceFiles = listExistingDartFiles(project.rootPath);
    if (!sourceFiles.length) {
      throw rejected('登録されたプロジェクト内に編集可能な lib/**/*.dart が見つかりません。');
    }
    const proposal = await this.codex.propose({
      instruction: request.instruction,
      annotation: request.annotation,
      projectName: project.name,
      files: sourceFiles.map(({ path, content }) => ({ path, content })),
    });
    const changed = validateProposal(proposal.files, sourceFiles);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.#database.prepare(
      `INSERT INTO change_sets
       (id,fix_request_id,state,summary,risks_json,created_at,applied_at,validation_state,validation_detail,validated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, request.id, 'proposed', proposal.summary.trim(), JSON.stringify(proposal.risks), createdAt, null, 'not_run', null, null);
    const insertFile = this.#database.prepare(
      `INSERT INTO change_set_files
        (change_set_id,path,before_sha256,after_sha256,before_content,after_content,additions,deletions)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    for (const file of changed) {
      insertFile.run(id, file.path, file.beforeSha256, sha256(file.afterContent), file.beforeContent, file.afterContent, file.additions, file.deletions);
    }
    const result = this.get(id);
    this.activities.append({
      kind: 'change.proposed', severity: 'success', message: 'Codex による修正案を生成しました。適用前の確認が必要です。',
      metadata: { changeSetId: id, fixRequestId: request.id, fileCount: result.files.length },
    });
    return result;
  }

  get(id: string): ChangeSet {
    const row = this.#row(id);
    const files = this.#files(id);
    return toChangeSet(row, files);
  }

  latestForFixRequest(fixRequestId: string): ChangeSet | undefined {
    const row = this.#database.prepare(
      'SELECT id,fix_request_id,state,summary,risks_json,created_at,applied_at,validation_state,validation_detail,validated_at FROM change_sets WHERE fix_request_id=? ORDER BY created_at DESC LIMIT 1',
    ).get(fixRequestId) as ChangeSetRow | undefined;
    return row ? toChangeSet(row, this.#files(row.id)) : undefined;
  }

  async validate(id: string): Promise<ChangeSet> {
    const row = this.#row(id);
    if (row.state !== 'proposed') throw conflict('未適用の修正案だけを検証できます。');
    const request = this.fixRequests.get(row.fix_request_id);
    const root = realpathSync(this.projectSessions.projectForSession(request.sessionId).rootPath);
    const stage = mkdtempSync(join(tmpdir(), 'devpilot-analyze-'));
    try {
      // Existing projects can already contain analyzer warnings. A proposal is
      // safe when it does not introduce any additional issues, even if the
      // project has pre-existing findings that are unrelated to this change.
      const baseline = await this.projectSessions.analyzeProject(root);
      copyProjectForAnalysis(root, stage);
      for (const file of this.#files(id)) {
        writeFileSync(safeProjectFile(stage, file.path), file.after_content, 'utf8');
      }
      const analysis = await this.projectSessions.analyzeProject(stage);
      const checkedAt = new Date().toISOString();
      const hasNoNewIssues =
        baseline.issueCount !== undefined &&
        analysis.issueCount !== undefined &&
        analysis.issueCount <= baseline.issueCount;
      const passed = analysis.passed || hasNoNewIssues;
      const detail = passed && !analysis.passed
        ? `既存の flutter analyze 指摘（${baseline.issueCount}件）から増えていません（修正案: ${analysis.issueCount}件）。`
        : analysis.detail;
      this.#database.prepare(
        'UPDATE change_sets SET validation_state=?, validation_detail=?, validated_at=? WHERE id=?',
      ).run(passed ? 'passed' : 'failed', detail, checkedAt, id);
      const result = this.get(id);
      this.activities.append({
        kind: 'job.updated', severity: passed ? 'success' : 'error',
        message: passed ? '修正案の flutter analyze 検証に成功しました。' : '修正案の flutter analyze 検証に失敗しました。適用はブロックされます。',
        metadata: { changeSetId: id, passed, baselineIssues: baseline.issueCount, proposalIssues: analysis.issueCount },
      });
      return result;
    } finally {
      rmSync(stage, { recursive: true, force: true, maxRetries: 2 });
    }
  }

  async apply(id: string): Promise<ChangeSet> {
    const row = this.#row(id);
    if (row.state === 'applied') return this.get(id);
    if (row.state !== 'proposed') throw conflict('この修正案は適用できる状態ではありません。');
    if (row.validation_state !== 'passed') {
      throw rejected('修正案を適用する前に flutter analyze の検証を成功させてください。');
    }
    const request = this.fixRequests.get(row.fix_request_id);
    const requestProject = this.projectSessions.projectForSession(request.sessionId);
    const rootPath = requestProject.rootPath;
    const root = realpathSync(rootPath);
    const files = this.#files(id);
    for (const file of files) {
      const absolutePath = safeProjectFile(root, file.path);
      if (!isRegularFile(absolutePath) || sha256(readFileSync(absolutePath, 'utf8')) !== file.before_sha256) {
        this.#database.prepare("UPDATE change_sets SET state = 'conflicted' WHERE id = ?").run(id);
        throw conflict(`修正対象 ${file.path} は案の生成後に変更されています。再度修正案を生成してください。`);
      }
    }
    for (const file of files) {
      writeFileSync(safeProjectFile(root, file.path), file.after_content, 'utf8');
    }
    const appliedAt = new Date().toISOString();
    this.#database.prepare("UPDATE change_sets SET state = 'applied', applied_at = ? WHERE id = ?").run(appliedAt, id);
    const hotReloaded = this.projectSessions.hotReloadProject(requestProject.id);
    const result = this.get(id);
    this.activities.append({
      kind: 'change.applied', severity: 'success', message: hotReloaded ? '修正案を適用し、Flutter ホットリロードを要求しました。' : '承認された Dart 修正案をプロジェクトへ適用しました。Flutter は再起動してください。',
      metadata: { changeSetId: id, fixRequestId: request.id, fileCount: files.length, hotReloaded },
    });
    return result;
  }

  revert(id: string): ChangeSet {
    const row = this.#row(id);
    if (row.state === 'reverted') return this.get(id);
    if (row.state !== 'applied') throw conflict('適用済みの修正案だけをロールバックできます。');
    const request = this.fixRequests.get(row.fix_request_id);
    const root = realpathSync(this.projectSessions.projectForSession(request.sessionId).rootPath);
    const files = this.#files(id);
    for (const file of files) {
      const absolutePath = safeProjectFile(root, file.path);
      if (!isRegularFile(absolutePath) || sha256(readFileSync(absolutePath, 'utf8')) !== file.after_sha256) {
        throw conflict(`修正対象 ${file.path} は適用後に変更されています。安全のためロールバックを中止しました。`);
      }
    }
    for (const file of files) {
      writeFileSync(safeProjectFile(root, file.path), file.before_content, 'utf8');
    }
    this.#database.prepare("UPDATE change_sets SET state = 'reverted' WHERE id = ?").run(id);
    const result = this.get(id);
    this.activities.append({
      kind: 'change.reverted', severity: 'warning', message: '適用済み修正案を、保存済みの適用前内容へロールバックしました。',
      metadata: { changeSetId: id, fixRequestId: request.id, fileCount: files.length },
    });
    return result;
  }

  close(): void {
    this.#database.close();
  }

  #row(id: string): ChangeSetRow {
    const row = this.#database.prepare('SELECT * FROM change_sets WHERE id = ?').get(id) as ChangeSetRow | undefined;
    if (!row) throw new AgentError({ code: 'REQUEST_INVALID', message: '修正案が見つかりません。', status: 404, action: 'CHECK_REQUEST' });
    return row;
  }

  #files(id: string): ChangeFileRow[] {
    return this.#database.prepare('SELECT * FROM change_set_files WHERE change_set_id = ? ORDER BY path').all(id) as unknown as ChangeFileRow[];
  }

  #ensureColumn(name: string, definition: string): void {
    const columns = this.#database.prepare('PRAGMA table_info(change_sets)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.#database.exec(`ALTER TABLE change_sets ADD COLUMN ${name} ${definition};`);
    }
  }
}

function copyProjectForAnalysis(root: string, stage: string): void {
  cpSync(join(root, 'lib'), join(stage, 'lib'), { recursive: true, dereference: false });
  // Asset declarations in pubspec.yaml are checked by `flutter analyze`.
  // Keep the project's asset tree in the isolated validation copy so valid
  // existing assets are not reported as proposal-induced warnings.
  const assets = join(root, 'assets');
  if (existsSync(assets)) {
    cpSync(assets, join(stage, 'assets'), { recursive: true, dereference: false });
  }
  for (const file of ['pubspec.yaml', 'pubspec.lock', 'analysis_options.yaml']) {
    const source = join(root, file);
    if (existsSync(source)) copyFileSync(source, join(stage, file));
  }
  const packageConfig = join(root, '.dart_tool', 'package_config.json');
  if (existsSync(packageConfig)) {
    mkdirSync(join(stage, '.dart_tool'), { recursive: true });
    copyFileSync(packageConfig, join(stage, '.dart_tool', 'package_config.json'));
  }
}

function listExistingDartFiles(rootPath: string): SourceFile[] {
  const root = realpathSync(rootPath);
  const lib = join(root, 'lib');
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(absolutePath);
      if (entry.isFile() && entry.name.endsWith('.dart')) paths.push(absolutePath);
    }
  };
  try { visit(lib); } catch { return []; }
  const ordered = paths.sort((left, right) => left.endsWith(`${sep}main.dart`) ? -1 : right.endsWith(`${sep}main.dart`) ? 1 : left.localeCompare(right)).slice(0, 80);
  let characters = 0;
  const files: SourceFile[] = [];
  for (const absolutePath of ordered) {
    const content = readFileSync(absolutePath, 'utf8');
    // Do not pass a Dart file containing a likely credential to the provider.
    // Excluding it is safer than replacing a value in a complete-file proposal.
    if (containsLikelySecret(content)) continue;
    if (characters + content.length > 600_000) break;
    const path = relative(root, absolutePath).replaceAll('\\', '/');
    files.push({ path, content, absolutePath, beforeSha256: sha256(readFileSync(absolutePath, 'utf8')) });
    characters += content.length;
  }
  return files;
}

function validateProposal(proposed: readonly CodexContextFile[], sourceFiles: readonly SourceFile[]): Array<SourceFile & { readonly beforeContent: string; readonly afterContent: string; readonly additions: number; readonly deletions: number }> {
  if (!proposed.length || proposed.length > 10) throw rejected('修正案の変更ファイル数が許可上限を超えています。');
  const byPath = new Map(sourceFiles.map((file) => [file.path, file]));
  const result: Array<SourceFile & { beforeContent: string; afterContent: string; additions: number; deletions: number }> = [];
  const seen = new Set<string>();
  let totalChangedLines = 0;
  for (const candidate of proposed) {
    const path = candidate.path.replaceAll('\\', '/');
    const source = byPath.get(path);
    if (!source || !path.startsWith('lib/') || !path.endsWith('.dart') || seen.has(path)) {
      throw rejected('Codex が許可されていないファイルを変更しようとしました。');
    }
    if (candidate.content.includes('\uFFFD') || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(candidate.content)) {
      throw rejected('修正案に文字化けまたは許可されない制御文字が含まれています。');
    }
    seen.add(path);
    const counts = lineChanges(source.content, candidate.content);
    totalChangedLines += counts.additions + counts.deletions;
    result.push({ ...source, beforeContent: source.content, afterContent: candidate.content, ...counts });
  }
  if (totalChangedLines === 0) throw rejected('修正案に実際の変更が含まれていません。');
  if (totalChangedLines > 800) throw rejected('修正案の差分が 800 行の上限を超えています。');
  return result;
}

function safeProjectFile(root: string, relativePath: string): string {
  if (!relativePath.startsWith('lib/') || !relativePath.endsWith('.dart') || relativePath.includes('..')) throw rejected('許可されていない修正先です。');
  const absolutePath = resolve(root, relativePath);
  if (!absolutePath.toLowerCase().startsWith(`${root.toLowerCase()}${sep}`.toLowerCase())) throw rejected('プロジェクト外のファイルは変更できません。');
  return absolutePath;
}

function isRegularFile(path: string): boolean {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

function lineChanges(before: string, after: string): { readonly additions: number; readonly deletions: number } {
  const a = before.split(/\r?\n/); const b = after.split(/\r?\n/);
  if (a.length * b.length > 1_000_000) return { additions: b.length, deletions: a.length };
  const previous = new Uint16Array(b.length + 1);
  const current = new Uint16Array(b.length + 1);
  for (const left of a) {
    for (let index = 1; index <= b.length; index += 1) current[index] = left === b[index - 1] ? previous[index - 1]! + 1 : Math.max(previous[index]!, current[index - 1]!);
    previous.set(current); current.fill(0);
  }
  const common = previous[b.length]!;
  return { additions: b.length - common, deletions: a.length - common };
}

function containsLikelySecret(value: string): boolean {
  return /(?:api[_-]?key|token|secret|password)\s*[:=]\s*['"][^'"]+/i.test(value);
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function invalid(message: string): AgentError { return new AgentError({ code: 'REQUEST_INVALID', message, status: 400, action: 'CHECK_REQUEST' }); }
function rejected(message: string): AgentError { return new AgentError({ code: 'CHANGE_SCOPE_REJECTED', message, status: 422, action: 'CHECK_REQUEST' }); }
function conflict(message: string): AgentError { return new AgentError({ code: 'CHANGE_CONFLICT', message, status: 409, action: 'RETRY' }); }

function toChangeSet(row: ChangeSetRow, files: readonly ChangeFileRow[]): ChangeSet {
  let risks: string[] = [];
  try { risks = JSON.parse(row.risks_json) as string[]; } catch { risks = []; }
  const mapped: ProposedFileChange[] = files.map((file) => ({ path: file.path, beforeSha256: file.before_sha256, afterSha256: file.after_sha256, additions: file.additions, deletions: file.deletions }));
  const validation: ChangeValidation = {
    state: row.validation_state ?? 'not_run',
    ...(row.validated_at ? { checkedAt: row.validated_at } : {}),
    ...(row.validation_detail ? { detail: row.validation_detail } : {}),
  };
  return { id: row.id, fixRequestId: row.fix_request_id, state: row.state, summary: row.summary, risks, files: mapped, validation, createdAt: row.created_at, ...(row.applied_at ? { appliedAt: row.applied_at } : {}) };
}
