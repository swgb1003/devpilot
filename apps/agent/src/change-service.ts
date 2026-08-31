import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ChangeSet, ProposedFileChange } from '@devpilot/contracts';

import { ActivityStore } from './activity-store.js';
import { CodexCliProvider, type CodexContextFile } from './codex-cli-provider.js';
import { AgentError } from './errors.js';
import { FixRequestService } from './fix-request-service.js';
import { ProjectSessionService } from './project-session-service.js';

interface ChangeSetRow {
  readonly id: string;
  readonly fix_request_id: string;
  readonly state: 'proposed' | 'applied' | 'conflicted';
  readonly summary: string;
  readonly risks_json: string;
  readonly created_at: string;
  readonly applied_at: string | null;
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
        applied_at TEXT
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
      'INSERT INTO change_sets (id,fix_request_id,state,summary,risks_json,created_at,applied_at) VALUES (?,?,?,?,?,?,?)',
    ).run(id, request.id, 'proposed', proposal.summary.trim(), JSON.stringify(proposal.risks), createdAt, null);
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

  apply(id: string): ChangeSet {
    const row = this.#row(id);
    if (row.state === 'applied') return this.get(id);
    if (row.state !== 'proposed') throw conflict('この修正案は適用できる状態ではありません。');
    const request = this.fixRequests.get(row.fix_request_id);
    const rootPath = this.projectSessions.projectForSession(request.sessionId).rootPath;
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
    const result = this.get(id);
    this.activities.append({
      kind: 'change.applied', severity: 'success', message: '承認された Dart 修正案をプロジェクトへ適用しました。',
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
  return { id: row.id, fixRequestId: row.fix_request_id, state: row.state, summary: row.summary, risks, files: mapped, createdAt: row.created_at, ...(row.applied_at ? { appliedAt: row.applied_at } : {}) };
}
