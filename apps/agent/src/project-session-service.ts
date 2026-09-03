import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type {
  AndroidDevice,
  DevSession,
  DevSessionState,
  RegisteredProject,
  SessionPreflight,
} from '@devpilot/contracts';

import { ActivityStore } from './activity-store.js';
import { AgentError } from './errors.js';
import { runCommand } from './command.js';

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  status: 'ready' | 'action_required';
  created_at: string;
  updated_at: string;
}
interface SessionRow {
  id: string;
  project_id: string;
  state: DevSessionState;
  device_id: string;
  started_at: string;
  ended_at: string | null;
  detail: string | null;
}

function resolveFlutterExecutable(): string {
  const configured = process.env.DEVPILOT_FLUTTER_COMMAND;
  if (configured && (configured === 'flutter' || existsSync(configured))) {
    return configured;
  }
  const windowsSdk = 'C:\\src\\flutter\\bin\\flutter.bat';
  if (process.platform === 'win32' && existsSync(windowsSdk)) {
    return windowsSdk;
  }
  return process.platform === 'win32' ? 'flutter.bat' : 'flutter';
}

const flutterExecutable = resolveFlutterExecutable();

function resolveDartExecutable(): string {
  const configured = process.env.DEVPILOT_DART_COMMAND;
  if (configured && (configured === 'dart' || existsSync(configured))) {
    return configured;
  }
  if (process.platform === 'win32' && /\.bat$/i.test(flutterExecutable)) {
    const bundled = join(dirname(flutterExecutable), 'dart.bat');
    if (existsSync(bundled)) return bundled;
  }
  return process.platform === 'win32' ? 'dart.bat' : 'dart';
}

const dartExecutable = resolveDartExecutable();
const flutterEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  CI: 'true',
  FLUTTER_ALREADY_LOCKED: 'true',
  FLUTTER_SUPPRESS_ANALYTICS: 'true',
};

/** Android logcat pads process IDs, e.g. `W/Firestore( 4734): ...`. */
export function isFlutterRunReady(output: string): boolean {
  return /Flutter run key commands|A Dart VM Service|Syncing files to device|^[VDIWE]\/[^(]+\(\s*\d+\):/m.test(
    output.replaceAll('\r', ''),
  );
}

export class ProjectSessionService {
  readonly #database: DatabaseSync;
  readonly #activities: ActivityStore;
  readonly #processes = new Map<string, ChildProcess>();

  constructor(databasePath: string, activities: ActivityStore) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, state TEXT NOT NULL, device_id TEXT, started_at TEXT NOT NULL, ended_at TEXT, detail TEXT);
    `);
    this.#activities = activities;
    this.#recoverInterruptedSessions();
  }

  listProjects(): readonly RegisteredProject[] {
    return (
      this.#database
        .prepare(
          'SELECT id,name,root_path,status,created_at,updated_at FROM projects ORDER BY updated_at DESC',
        )
        .all() as unknown as ProjectRow[]
    ).map(toProject);
  }

  register(rootPath: string): RegisteredProject {
    const root = resolve(rootPath);
    const pubspec = join(root, 'pubspec.yaml');
    if (!existsSync(pubspec))
      throw invalid(
        '選択したフォルダに pubspec.yaml がありません。Flutterプロジェクトのルートを選択してください。',
      );
    const contents = readFileSync(pubspec, 'utf8');
    const name = /^name:\s*([^\s#]+)/m.exec(contents)?.[1] ?? basename(root);
    const existing = this.#database
      .prepare(
        'SELECT id,name,root_path,status,created_at,updated_at FROM projects WHERE root_path = ?',
      )
      .get(root) as ProjectRow | undefined;
    const now = new Date().toISOString();
    if (existing) {
      this.#database
        .prepare('UPDATE projects SET name=?, status=?, updated_at=? WHERE id=?')
        .run(name, 'ready', now, existing.id);
      return toProject({ ...existing, name, status: 'ready', updated_at: now });
    }
    const project: ProjectRow = {
      id: randomUUID(),
      name,
      root_path: root,
      status: 'ready',
      created_at: now,
      updated_at: now,
    };
    this.#database
      .prepare(
        'INSERT INTO projects (id,name,root_path,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        project.id,
        project.name,
        project.root_path,
        project.status,
        project.created_at,
        project.updated_at,
      );
    this.#activities.append({
      kind: 'project.registered',
      severity: 'success',
      message: `Flutterプロジェクト「${name}」を登録しました。`,
      metadata: { projectId: project.id },
    });
    return toProject(project);
  }

  async preflight(projectId: string): Promise<SessionPreflight> {
    const project = this.#project(projectId);
    const isFlutterProject = existsSync(join(project.root_path, 'pubspec.yaml'));
    const flutter = await runCommand(
      flutterExecutable,
      ['--version', '--suppress-analytics'],
      45_000,
      { environment: flutterEnvironment },
    );
    const devices = await this.devices();
    const git = await runCommand('git', ['status', '--porcelain'], 5_000, {
      environment: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    const issues: string[] = [];
    if (!isFlutterProject) issues.push('pubspec.yaml が見つかりません。');
    if (flutter.timedOut || flutter.exitCode !== 0) {
      const diagnostic = (flutter.stderr || flutter.stdout).trim().slice(0, 300);
      issues.push(
        `flutter --version を実行できません。Flutter SDKの設定を確認してください。${diagnostic ? ` (${diagnostic})` : ''}`,
      );
    }
    if (!devices.some((device) => device.isAuthorized))
      issues.push('authorized 状態のAndroid端末が見つかりません。');
    return {
      projectId,
      isFlutterProject,
      flutterAvailable: flutter.exitCode === 0 && !flutter.timedOut,
      devices,
      gitState: git.exitCode === 0 ? (git.stdout.trim() ? 'dirty' : 'clean') : 'unavailable',
      issues,
    };
  }

  async devices(): Promise<readonly AndroidDevice[]> {
    const result = await runCommand(flutterExecutable, ['devices', '--machine'], 15_000, {
      environment: flutterEnvironment,
    });
    if (result.exitCode === 0 && !result.timedOut) {
      try {
        const parsed = JSON.parse(result.stdout) as Array<{
          id?: string;
          name?: string;
          targetPlatform?: string;
          emulator?: boolean;
        }>;
        const devices = parsed
          .filter((item) => item.id && item.targetPlatform === 'android')
          .map((item) => ({
            id: item.id!,
            name: item.name ?? item.id!,
            platform: 'android',
            isAuthorized: true,
          }));
        if (devices.length) return devices;
      } catch {
        /* Fall through to ADB discovery. */
      }
    }
    const adb =
      process.platform === 'win32'
        ? `${process.env.LOCALAPPDATA ?? ''}\\Android\\Sdk\\platform-tools\\adb.exe`
        : 'adb';
    const adbResult = await runCommand(adb, ['devices', '-l'], 8_000);
    if (adbResult.exitCode !== 0 || adbResult.timedOut) return [];
    return adbResult.stdout
      .split(/\r?\n/)
      .slice(1)
      .flatMap((line) => {
        const match = /^(\S+)\s+(device|unauthorized)\b.*?(?:model:(\S+))?/.exec(line.trim());
        if (!match) return [];
        return [
          {
            id: match[1]!,
            name: match[3]?.replaceAll('_', ' ') ?? match[1]!,
            platform: 'android',
            isAuthorized: match[2] === 'device',
          },
        ];
      });
  }

  async analyzeProject(rootPath: string): Promise<{
    readonly passed: boolean;
    readonly detail: string;
    readonly issueCount: number | undefined;
  }> {
    const result = await runCommand(flutterExecutable, ['analyze'], 120_000, {
      environment: flutterEnvironment,
      cwd: rootPath,
    });
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join('\n')
      .replaceAll('\r', '')
      .trim()
      .slice(-6_000);
    const issueMatch = /(?:^|\n)(\d+) issues? found\./m.exec(output);
    return {
      passed: result.exitCode === 0 && !result.timedOut,
      issueCount:
        result.exitCode === 0 && !result.timedOut
          ? 0
          : issueMatch
            ? Number.parseInt(issueMatch[1]!, 10)
            : undefined,
      detail: result.timedOut
        ? 'flutter analyze がタイムアウトしました。'
        : output ||
          (result.exitCode === 0
            ? 'flutter analyze passed.'
            : `flutter analyze failed (code ${result.exitCode ?? 'unknown'}).`),
    };
  }

  async checkDartFormat(
    rootPath: string,
    paths: readonly string[],
  ): Promise<{ readonly passed: boolean; readonly detail: string }> {
    const result = await runCommand(
      dartExecutable,
      ['format', '--output=none', '--set-exit-if-changed', ...paths],
      60_000,
      { environment: flutterEnvironment, cwd: rootPath },
    );
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join('\n')
      .replaceAll('\r', '')
      .trim()
      .slice(-4_000);
    return {
      passed: result.exitCode === 0 && !result.timedOut,
      detail: result.timedOut
        ? 'dart format の確認がタイムアウトしました。'
        : output ||
          (result.exitCode === 0
            ? 'dart format passed.'
            : 'Dartコードの整形が必要です。修正案を作り直してください。'),
    };
  }

  async start(projectId: string, deviceId: string): Promise<DevSession> {
    const project = this.#project(projectId);
    const preflight = await this.preflight(projectId);
    if (preflight.issues.length) throw invalid(preflight.issues.join(' '));
    if (!preflight.devices.some((device) => device.id === deviceId && device.isAuthorized))
      throw invalid('選択したAndroid端末を確認できません。');
    for (const active of this.#database
      .prepare("SELECT id FROM sessions WHERE state IN ('starting','running')")
      .all() as Array<{ id: string }>)
      await this.stop(active.id);
    const now = new Date().toISOString();
    const row: SessionRow = {
      id: randomUUID(),
      project_id: projectId,
      device_id: deviceId,
      state: 'starting',
      started_at: now,
      ended_at: null,
      detail: 'flutter run を開始しています。',
    };
    this.#database
      .prepare(
        'INSERT INTO sessions (id,project_id,state,device_id,started_at,ended_at,detail) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        row.id,
        row.project_id,
        row.state,
        row.device_id,
        row.started_at,
        row.ended_at,
        row.detail,
      );
    const child = spawn(flutterExecutable, ['run', '-d', deviceId], {
      cwd: project.root_path,
      env: flutterEnvironment,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    this.#processes.set(row.id, child);
    let output = '';
    const recordOutput = (chunk: Buffer): void => {
      output = `${output}${chunk.toString('utf8')}`.slice(-8_000);
      const normalized = output.replaceAll('\r', '');
      const lastLines = normalized.split('\n').filter(Boolean).slice(-8).join('\n');
      console.log('[session:flutter]', {
        sessionId: row.id,
        output: chunk.toString('utf8').trim(),
      });
      // `flutter run` emits Android logcat lines only after the APK has been
      // installed and the target process has launched.  Some apps do not emit
      // the interactive-command banner or a Dart VM URL, so recognise that
      // runtime output as a successful launch as well.
      const ready = isFlutterRunReady(normalized);
      this.#setState(
        row.id,
        ready ? 'running' : 'starting',
        ready
          ? `Flutter開発セッションを実行中です。\n${lastLines}`
          : `Flutterを起動しています。\n${lastLines}`,
      );
    };
    child.stdout?.on('data', recordOutput);
    child.stderr?.on('data', recordOutput);
    child.once('spawn', () =>
      this.#setState(row.id, 'starting', 'Flutterアプリをビルドしています。'),
    );
    child.once('error', (error) => this.#setState(row.id, 'failed', error.message));
    child.once('exit', (code) => {
      if (this.#processes.delete(row.id)) {
        const diagnostic = output.replaceAll('\r', '').trim().slice(-4_000);
        this.#setState(
          row.id,
          code === 0 ? 'stopped' : 'failed',
          `flutter run が終了しました（code ${code ?? 'unknown'}）。${diagnostic ? `\n${diagnostic}` : ''}`,
        );
      }
    });
    this.#activities.append({
      kind: 'session.started',
      severity: 'success',
      message: `開発セッションを開始しました（${project.name}）。`,
      metadata: { sessionId: row.id, projectId, deviceId },
    });
    return toSession(row);
  }

  getSession(): DevSession | undefined {
    const row = this.#database
      .prepare(
        'SELECT id,project_id,state,device_id,started_at,ended_at,detail FROM sessions ORDER BY started_at DESC LIMIT 1',
      )
      .get() as SessionRow | undefined;
    return row ? toSession(row) : undefined;
  }

  projectForSession(sessionId: string): RegisteredProject {
    return toProject(this.#project(this.#session(sessionId).project_id));
  }

  async stop(sessionId: string): Promise<DevSession> {
    const current = this.#session(sessionId);
    this.#processes.get(sessionId)?.kill();
    this.#processes.delete(sessionId);
    this.#setState(sessionId, 'stopped', '開発セッションを終了しました。');
    this.#activities.append({
      kind: 'session.stopped',
      message: '開発セッションを終了しました。',
      metadata: { sessionId },
    });
    return {
      ...toSession(current),
      state: 'stopped',
      endedAt: new Date().toISOString(),
      detail: '開発セッションを終了しました。',
    };
  }

  hotReload(sessionId: string): boolean {
    const session = this.#session(sessionId);
    const child = this.#processes.get(sessionId);
    if (session.state !== 'running' || !child?.stdin?.writable) return false;
    child.stdin.write('r\n');
    this.#setState(sessionId, 'running', 'Flutter ホットリロードを要求しました。');
    this.#activities.append({
      kind: 'job.updated',
      severity: 'success',
      message: '実行中の Flutter 開発セッションへホットリロードを要求しました。',
      metadata: { sessionId },
    });
    return true;
  }

  /**
   * A FixRequest can outlive the Flutter process that created it.  When the
   * user reconnects after an Agent restart, reload the newest live session for
   * that project instead of incorrectly targeting the stale request session.
   */
  hotReloadProject(projectId: string): boolean {
    const candidates = this.#database
      .prepare(
        "SELECT id FROM sessions WHERE project_id = ? AND state = 'running' ORDER BY started_at DESC",
      )
      .all(projectId) as Array<{ id: string }>;
    for (const candidate of candidates) {
      if (this.hotReload(candidate.id)) return true;
    }
    return false;
  }

  close(): void {
    for (const [sessionId, child] of this.#processes) {
      // Remove the handle before terminating it: the exit handler must not try
      // to write to SQLite after this service has closed the database.
      this.#processes.delete(sessionId);
      child.kill();
      this.#setState(sessionId, 'stopped', 'Agent を終了したため、開発セッションを停止しました。');
      this.#activities.append({
        kind: 'session.stopped',
        severity: 'warning',
        message: 'Agent の終了に伴い Flutter 開発セッションを停止しました。',
        metadata: { sessionId, reason: 'agent_shutdown' },
      });
    }
    this.#database.close();
  }

  #recoverInterruptedSessions(): void {
    const interrupted = this.#database
      .prepare(
        "SELECT id,project_id,device_id,state FROM sessions WHERE state IN ('starting','running')",
      )
      .all() as Array<Pick<SessionRow, 'id' | 'project_id' | 'device_id' | 'state'>>;
    if (!interrupted.length) return;

    const endedAt = new Date().toISOString();
    const detail =
      'Agent の再起動を検出しました。以前の Flutter プロセスは再接続できないため、開発セッションを開始し直してください。';
    const update = this.#database.prepare(
      'UPDATE sessions SET state=?, detail=?, ended_at=? WHERE id=?',
    );
    for (const session of interrupted) {
      update.run('failed', detail, endedAt, session.id);
      this.#activities.append({
        kind: 'session.stopped',
        severity: 'warning',
        message: 'Agent 再起動後に中断された Flutter 開発セッションを復旧対象として記録しました。',
        metadata: {
          sessionId: session.id,
          projectId: session.project_id,
          deviceId: session.device_id,
          previousState: session.state,
          reason: 'agent_restart',
        },
      });
    }
  }

  #project(id: string): ProjectRow {
    const row = this.#database
      .prepare('SELECT id,name,root_path,status,created_at,updated_at FROM projects WHERE id=?')
      .get(id) as ProjectRow | undefined;
    if (!row) throw invalid('プロジェクトが見つかりません。');
    return row;
  }
  #session(id: string): SessionRow {
    const row = this.#database
      .prepare(
        'SELECT id,project_id,state,device_id,started_at,ended_at,detail FROM sessions WHERE id=?',
      )
      .get(id) as SessionRow | undefined;
    if (!row) throw invalid('開発セッションが見つかりません。');
    return row;
  }
  #setState(id: string, state: DevSessionState, detail: string): void {
    this.#database
      .prepare('UPDATE sessions SET state=?, detail=?, ended_at=? WHERE id=?')
      .run(
        state,
        detail,
        state === 'running' || state === 'starting' ? null : new Date().toISOString(),
        id,
      );
  }
}
function invalid(message: string): AgentError {
  return new AgentError({ code: 'REQUEST_INVALID', message, status: 400, action: 'CHECK_REQUEST' });
}
function toProject(row: ProjectRow): RegisteredProject {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function toSession(row: SessionRow): DevSession {
  return {
    id: row.id,
    projectId: row.project_id,
    deviceId: row.device_id,
    state: row.state,
    startedAt: row.started_at,
    ...(row.ended_at ? { endedAt: row.ended_at } : {}),
    ...(row.detail ? { detail: row.detail } : {}),
  };
}
