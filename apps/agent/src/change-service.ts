import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import type {
  ChangeSet,
  ChangeFileReview,
  ChangeValidation,
  ChangeValidationState,
  ProposedFileChange,
} from '@devpilot/contracts';

import { ActivityStore } from './activity-store.js';
import {
  CodexCliProvider,
  type AiProposalProvider,
  type CodexContextFile,
} from './codex-cli-provider.js';
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
  readonly selected: number;
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
    private readonly codex: AiProposalProvider = new CodexCliProvider(),
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
        selected INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (change_set_id, path)
      );
    `);
    this.#ensureColumn('validation_state', "TEXT NOT NULL DEFAULT 'not_run'");
    this.#ensureColumn('validation_detail', 'TEXT');
    this.#ensureColumn('validated_at', 'TEXT');
    this.#ensureFileColumn('selected', 'INTEGER NOT NULL DEFAULT 1');
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
      files: proposalContextFiles(sourceFiles, request.instruction).map(({ path, content }) => ({
        path,
        content,
      })),
    });
    const changed = validateProposal(proposal.files, sourceFiles);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.#database
      .prepare(
        `INSERT INTO change_sets
       (id,fix_request_id,state,summary,risks_json,created_at,applied_at,validation_state,validation_detail,validated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        request.id,
        'proposed',
        proposal.summary.trim(),
        JSON.stringify(proposal.risks),
        createdAt,
        null,
        'not_run',
        null,
        null,
      );
    const insertFile = this.#database.prepare(
      `INSERT INTO change_set_files
        (change_set_id,path,before_sha256,after_sha256,before_content,after_content,additions,deletions,selected)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    for (const file of changed) {
      insertFile.run(
        id,
        file.path,
        file.beforeSha256,
        sha256(file.afterContent),
        file.beforeContent,
        file.afterContent,
        file.additions,
        file.deletions,
        1,
      );
    }
    const result = this.get(id);
    this.activities.append({
      kind: 'change.proposed',
      severity: 'success',
      message: 'Codex による修正案を生成しました。適用前の確認が必要です。',
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
    const row = this.#database
      .prepare(
        'SELECT id,fix_request_id,state,summary,risks_json,created_at,applied_at,validation_state,validation_detail,validated_at FROM change_sets WHERE fix_request_id=? ORDER BY created_at DESC LIMIT 1',
      )
      .get(fixRequestId) as ChangeSetRow | undefined;
    return row ? toChangeSet(row, this.#files(row.id)) : undefined;
  }

  reviewFile(id: string, path: string): ChangeFileReview {
    const file = this.#files(id).find((candidate) => candidate.path === path);
    if (!file) throw invalid('指定された修正ファイルが見つかりません。');
    return {
      path: file.path,
      beforeSha256: file.before_sha256,
      afterSha256: file.after_sha256,
      additions: file.additions,
      deletions: file.deletions,
      selected: file.selected === 1,
      diff: reviewDiff(file.before_content, file.after_content),
    };
  }

  selectFiles(id: string, paths: readonly string[]): ChangeSet {
    const row = this.#row(id);
    if (row.state !== 'proposed') throw conflict('適用前の修正案だけを選択し直せます。');
    const files = this.#files(id);
    const selected = new Set(paths);
    if (
      !selected.size ||
      selected.size > files.length ||
      [...selected].some((path) => !files.some((file) => file.path === path))
    ) {
      throw invalid('少なくとも1つの修正ファイルを選択してください。');
    }
    this.#database.exec('BEGIN');
    try {
      this.#database
        .prepare('UPDATE change_set_files SET selected=0 WHERE change_set_id=?')
        .run(id);
      const markSelected = this.#database.prepare(
        'UPDATE change_set_files SET selected=1 WHERE change_set_id=? AND path=?',
      );
      for (const path of selected) markSelected.run(id, path);
      this.#database
        .prepare(
          'UPDATE change_sets SET validation_state=?, validation_detail=NULL, validated_at=NULL WHERE id=?',
        )
        .run('not_run', id);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return this.get(id);
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
      const proposalFiles = this.#selectedFiles(id);
      for (const file of proposalFiles) {
        writeFileSync(safeProjectFile(stage, file.path), file.after_content, 'utf8');
      }
      const format = await this.projectSessions.checkDartFormat(
        stage,
        proposalFiles.map((file) => file.path),
      );
      const analysis = format.passed ? await this.projectSessions.analyzeProject(stage) : undefined;
      const checkedAt = new Date().toISOString();
      const hasNoNewIssues =
        analysis !== undefined &&
        baseline.issueCount !== undefined &&
        analysis.issueCount !== undefined &&
        analysis.issueCount <= baseline.issueCount;
      const passed = format.passed && (analysis?.passed == true || hasNoNewIssues);
      const detail = !format.passed
        ? format.detail
        : passed && !analysis!.passed
          ? `既存の flutter analyze 指摘（${baseline.issueCount}件）から増えていません（修正案: ${analysis.issueCount}件）。`
          : analysis!.detail;
      this.#database
        .prepare(
          'UPDATE change_sets SET validation_state=?, validation_detail=?, validated_at=? WHERE id=?',
        )
        .run(passed ? 'passed' : 'failed', detail, checkedAt, id);
      const result = this.get(id);
      this.activities.append({
        kind: 'job.updated',
        severity: passed ? 'success' : 'error',
        message: passed
          ? '修正案の flutter analyze 検証に成功しました。'
          : '修正案の flutter analyze 検証に失敗しました。適用はブロックされます。',
        metadata: {
          changeSetId: id,
          passed,
          formatPassed: format.passed,
          baselineIssues: baseline.issueCount,
          proposalIssues: analysis?.issueCount,
        },
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
    const files = this.#selectedFiles(id);
    for (const file of files) {
      const absolutePath = safeProjectFile(root, file.path);
      if (
        !isRegularFile(absolutePath) ||
        sha256(readFileSync(absolutePath, 'utf8')) !== file.before_sha256
      ) {
        this.#database.prepare("UPDATE change_sets SET state = 'conflicted' WHERE id = ?").run(id);
        throw conflict(
          `修正対象 ${file.path} は案の生成後に変更されています。再度修正案を生成してください。`,
        );
      }
    }
    for (const file of files) {
      writeFileSync(safeProjectFile(root, file.path), file.after_content, 'utf8');
    }
    const appliedAt = new Date().toISOString();
    this.#database
      .prepare("UPDATE change_sets SET state = 'applied', applied_at = ? WHERE id = ?")
      .run(appliedAt, id);
    const hotReloaded = this.projectSessions.hotReloadProject(requestProject.id);
    const result = this.get(id);
    this.activities.append({
      kind: 'change.applied',
      severity: 'success',
      message: hotReloaded
        ? '修正案を適用し、Flutter ホットリロードを要求しました。'
        : '承認された Dart 修正案をプロジェクトへ適用しました。Flutter は再起動してください。',
      metadata: { changeSetId: id, fixRequestId: request.id, fileCount: files.length, hotReloaded },
    });
    return result;
  }

  revert(id: string): ChangeSet {
    const row = this.#row(id);
    if (row.state === 'reverted') return this.get(id);
    if (row.state !== 'applied') throw conflict('適用済みの修正案だけをロールバックできます。');
    const request = this.fixRequests.get(row.fix_request_id);
    const project = this.projectSessions.projectForSession(request.sessionId);
    const root = realpathSync(project.rootPath);
    const files = this.#selectedFiles(id);
    for (const file of files) {
      const absolutePath = safeProjectFile(root, file.path);
      if (
        !isRegularFile(absolutePath) ||
        sha256(readFileSync(absolutePath, 'utf8')) !== file.after_sha256
      ) {
        throw conflict(
          `修正対象 ${file.path} は適用後に変更されています。安全のためロールバックを中止しました。`,
        );
      }
    }
    for (const file of files) {
      writeFileSync(safeProjectFile(root, file.path), file.before_content, 'utf8');
    }
    this.#database.prepare("UPDATE change_sets SET state = 'reverted' WHERE id = ?").run(id);
    const hotReloaded = this.projectSessions.hotReloadProject(project.id);
    const result = this.get(id);
    this.activities.append({
      kind: 'change.reverted',
      severity: 'warning',
      message: hotReloaded
        ? '適用済み修正案をロールバックし、Flutter ホットリロードを要求しました。'
        : '適用済み修正案を、保存済みの適用前内容へロールバックしました。Flutter は再起動してください。',
      metadata: { changeSetId: id, fixRequestId: request.id, fileCount: files.length, hotReloaded },
    });
    return result;
  }

  close(): void {
    this.#database.close();
  }

  #row(id: string): ChangeSetRow {
    const row = this.#database.prepare('SELECT * FROM change_sets WHERE id = ?').get(id) as
      ChangeSetRow | undefined;
    if (!row)
      throw new AgentError({
        code: 'REQUEST_INVALID',
        message: '修正案が見つかりません。',
        status: 404,
        action: 'CHECK_REQUEST',
      });
    return row;
  }

  #files(id: string): ChangeFileRow[] {
    return this.#database
      .prepare('SELECT * FROM change_set_files WHERE change_set_id = ? ORDER BY path')
      .all(id) as unknown as ChangeFileRow[];
  }

  #ensureColumn(name: string, definition: string): void {
    const columns = this.#database.prepare('PRAGMA table_info(change_sets)').all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === name)) {
      this.#database.exec(`ALTER TABLE change_sets ADD COLUMN ${name} ${definition};`);
    }
  }

  #ensureFileColumn(name: string, definition: string): void {
    const columns = this.#database.prepare('PRAGMA table_info(change_set_files)').all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === name)) {
      this.#database.exec(`ALTER TABLE change_set_files ADD COLUMN ${name} ${definition};`);
    }
  }

  #selectedFiles(id: string): ChangeFileRow[] {
    return this.#files(id).filter((file) => file.selected === 1);
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
  try {
    visit(lib);
  } catch {
    return [];
  }
  const ordered = paths
    .sort((left, right) =>
      left.endsWith(`${sep}main.dart`)
        ? -1
        : right.endsWith(`${sep}main.dart`)
          ? 1
          : left.localeCompare(right),
    )
    .slice(0, 80);
  let characters = 0;
  const files: SourceFile[] = [];
  for (const absolutePath of ordered) {
    const content = readFileSync(absolutePath, 'utf8');
    // Do not pass a Dart file containing a likely credential to the provider.
    // Excluding it is safer than replacing a value in a complete-file proposal.
    if (containsLikelySecret(content)) continue;
    if (characters + content.length > 600_000) break;
    const path = relative(root, absolutePath).replaceAll('\\', '/');
    files.push({
      path,
      content,
      absolutePath,
      beforeSha256: sha256(readFileSync(absolutePath, 'utf8')),
    });
    characters += content.length;
  }
  return files;
}

/**
 * A visual correction normally belongs to a screen or widget, not every
 * service in the application.  Constrain the first-pass context so Codex can
 * respond promptly, while retaining main.dart and any file whose source or
 * name explicitly matches the instruction.  The complete source list remains
 * available for proposal validation, so a generated change is still checked
 * against the on-disk version before it can be applied.
 */
function proposalContextFiles(
  sourceFiles: readonly SourceFile[],
  instruction: string,
): SourceFile[] {
  const keywords =
    instruction
      .toLocaleLowerCase()
      .match(/[a-z0-9_]{3,}|[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]{2,}/gu)
      ?.filter((word) => !['してください', 'について', 'ポイント', 'ボタン'].includes(word)) ?? [];
  const uniqueKeywords = [...new Set(keywords)].slice(0, 12);
  const score = (file: SourceFile): number => {
    const path = file.path.toLocaleLowerCase();
    const content = file.content.toLocaleLowerCase();
    let value = file.path === 'lib/main.dart' ? 10_000 : 0;
    if (path.startsWith('lib/screens/')) value += 200;
    if (path.startsWith('lib/widgets/')) value += 160;
    for (const keyword of uniqueKeywords) {
      if (path.includes(keyword)) value += 2_000;
      if (content.includes(keyword)) value += 1_000;
    }
    return value;
  };
  const ordered = [...sourceFiles].sort(
    (left, right) => score(right) - score(left) || left.path.localeCompare(right.path),
  );
  const files: SourceFile[] = [];
  let characters = 0;
  for (const file of ordered) {
    if (files.length >= 18) break;
    // Always include the first candidate, even if an individual source file
    // is unusually large; otherwise a project could have no usable context.
    if (files.length > 0 && characters + file.content.length > 160_000) continue;
    files.push(file);
    characters += file.content.length;
  }
  return files;
}

function validateProposal(
  proposed: readonly CodexContextFile[],
  sourceFiles: readonly SourceFile[],
): Array<
  SourceFile & {
    readonly beforeContent: string;
    readonly afterContent: string;
    readonly additions: number;
    readonly deletions: number;
  }
> {
  if (!proposed.length || proposed.length > 10)
    throw rejected('修正案の変更ファイル数が許可上限を超えています。');
  const byPath = new Map(sourceFiles.map((file) => [file.path, file]));
  const result: Array<
    SourceFile & {
      beforeContent: string;
      afterContent: string;
      additions: number;
      deletions: number;
    }
  > = [];
  const seen = new Set<string>();
  let totalChangedLines = 0;
  for (const candidate of proposed) {
    const path = candidate.path.replaceAll('\\', '/');
    const source = byPath.get(path);
    if (!source || !path.startsWith('lib/') || !path.endsWith('.dart') || seen.has(path)) {
      throw rejected('Codex が許可されていないファイルを変更しようとしました。');
    }
    if (
      candidate.content.includes('\uFFFD') ||
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(candidate.content)
    ) {
      throw rejected('修正案に文字化けまたは許可されない制御文字が含まれています。');
    }
    seen.add(path);
    const counts = lineChanges(source.content, candidate.content);
    totalChangedLines += counts.additions + counts.deletions;
    result.push({
      ...source,
      beforeContent: source.content,
      afterContent: candidate.content,
      ...counts,
    });
  }
  if (totalChangedLines === 0) throw rejected('修正案に実際の変更が含まれていません。');
  if (totalChangedLines > 800) throw rejected('修正案の差分が 800 行の上限を超えています。');
  return result;
}

function safeProjectFile(root: string, relativePath: string): string {
  if (
    !relativePath.startsWith('lib/') ||
    !relativePath.endsWith('.dart') ||
    relativePath.includes('..')
  )
    throw rejected('許可されていない修正先です。');
  const absolutePath = resolve(root, relativePath);
  if (!absolutePath.toLowerCase().startsWith(`${root.toLowerCase()}${sep}`.toLowerCase()))
    throw rejected('プロジェクト外のファイルは変更できません。');
  return absolutePath;
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function lineChanges(
  before: string,
  after: string,
): { readonly additions: number; readonly deletions: number } {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  if (a.length * b.length > 1_000_000) return { additions: b.length, deletions: a.length };
  const previous = new Uint16Array(b.length + 1);
  const current = new Uint16Array(b.length + 1);
  for (const left of a) {
    for (let index = 1; index <= b.length; index += 1)
      current[index] =
        left === b[index - 1]
          ? previous[index - 1]! + 1
          : Math.max(previous[index]!, current[index - 1]!);
    previous.set(current);
    current.fill(0);
  }
  const common = previous[b.length]!;
  return { additions: b.length - common, deletions: a.length - common };
}

function reviewDiff(before: string, after: string): string {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  // The proposal limit keeps this matrix small in normal use. For unusually
  // large files, show a bounded replacement review rather than risking an
  // unbounded response to a mobile client.
  if (beforeLines.length * afterLines.length > 1_000_000) {
    return boundedReplacementDiff(beforeLines, afterLines);
  }
  const width = afterLines.length + 1;
  const table = new Uint16Array((beforeLines.length + 1) * width);
  for (let left = 1; left <= beforeLines.length; left += 1) {
    for (let right = 1; right <= afterLines.length; right += 1) {
      table[left * width + right] =
        beforeLines[left - 1] === afterLines[right - 1]
          ? table[(left - 1) * width + right - 1]! + 1
          : Math.max(table[(left - 1) * width + right]!, table[left * width + right - 1]!);
    }
  }
  const lines: string[] = [];
  let left = beforeLines.length;
  let right = afterLines.length;
  while (left > 0 || right > 0) {
    if (left > 0 && right > 0 && beforeLines[left - 1] === afterLines[right - 1]) {
      left -= 1;
      right -= 1;
    } else if (
      right > 0 &&
      (left === 0 || table[left * width + right - 1]! >= table[(left - 1) * width + right]!)
    ) {
      lines.push(`+ ${right}: ${afterLines[right - 1]}`);
      right -= 1;
    } else {
      lines.push(`- ${left}: ${beforeLines[left - 1]}`);
      left -= 1;
    }
  }
  return limitReviewLines(lines.reverse());
}

function boundedReplacementDiff(before: readonly string[], after: readonly string[]): string {
  const lines = [
    ...before.slice(0, 160).map((line, index) => `- ${index + 1}: ${line}`),
    ...after.slice(0, 160).map((line, index) => `+ ${index + 1}: ${line}`),
  ];
  return `${limitReviewLines(lines)}\n… 大きなファイルのため、差分を先頭160行ずつに省略しました。`;
}

function limitReviewLines(lines: readonly string[]): string {
  const limit = 360;
  if (lines.length <= limit) return lines.join('\n');
  return `${lines.slice(0, limit).join('\n')}\n… ${lines.length - limit}行を省略しました。`;
}

function containsLikelySecret(value: string): boolean {
  return /(?:api[_-]?key|token|secret|password)\s*[:=]\s*['"][^'"]+/i.test(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function invalid(message: string): AgentError {
  return new AgentError({ code: 'REQUEST_INVALID', message, status: 400, action: 'CHECK_REQUEST' });
}
function rejected(message: string): AgentError {
  return new AgentError({
    code: 'CHANGE_SCOPE_REJECTED',
    message,
    status: 422,
    action: 'CHECK_REQUEST',
  });
}
function conflict(message: string): AgentError {
  return new AgentError({ code: 'CHANGE_CONFLICT', message, status: 409, action: 'RETRY' });
}

function toChangeSet(row: ChangeSetRow, files: readonly ChangeFileRow[]): ChangeSet {
  let risks: string[] = [];
  try {
    risks = JSON.parse(row.risks_json) as string[];
  } catch {
    risks = [];
  }
  const mapped: ProposedFileChange[] = files.map((file) => ({
    path: file.path,
    beforeSha256: file.before_sha256,
    afterSha256: file.after_sha256,
    additions: file.additions,
    deletions: file.deletions,
    selected: file.selected === 1,
  }));
  const validation: ChangeValidation = {
    state: row.validation_state ?? 'not_run',
    ...(row.validated_at ? { checkedAt: row.validated_at } : {}),
    ...(row.validation_detail ? { detail: row.validation_detail } : {}),
  };
  return {
    id: row.id,
    fixRequestId: row.fix_request_id,
    state: row.state,
    summary: row.summary,
    risks,
    files: mapped,
    validation,
    createdAt: row.created_at,
    ...(row.applied_at ? { appliedAt: row.applied_at } : {}),
  };
}
