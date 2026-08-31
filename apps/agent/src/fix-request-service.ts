import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type { FixAnnotation, FixRequest, FixRequestState } from '@devpilot/contracts';

import { ActivityStore } from './activity-store.js';
import { ScreenshotArtifactStore } from './device-controller.js';
import { AgentError } from './errors.js';
import { ProjectSessionService } from './project-session-service.js';

interface FixRequestRow {
  readonly id: string;
  readonly session_id: string;
  readonly screenshot_id: string;
  readonly instruction: string;
  readonly annotation_json: string;
  readonly client_request_id: string;
  readonly idempotency_key: string;
  readonly state: FixRequestState;
  readonly created_at: string;
  readonly approved_at: string | null;
}

export interface CreateFixRequestInput {
  readonly sessionId: string;
  readonly screenshotId: string;
  readonly instruction: string;
  readonly annotation: FixAnnotation;
  readonly clientRequestId: string;
  readonly idempotencyKey: string;
}

export class FixRequestService {
  readonly #database: DatabaseSync;

  constructor(
    databasePath: string,
    private readonly activities: ActivityStore,
    private readonly screenshots: ScreenshotArtifactStore,
    private readonly projectSessions: ProjectSessionService,
  ) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec('PRAGMA busy_timeout = 5000;');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS fix_requests (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        screenshot_id TEXT NOT NULL,
        instruction TEXT NOT NULL,
        annotation_json TEXT NOT NULL,
        client_request_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        approved_at TEXT
      );
    `);
  }

  create(input: CreateFixRequestInput): FixRequest {
    validateInput(input);
    const existing = this.#database
      .prepare('SELECT * FROM fix_requests WHERE idempotency_key = ?')
      .get(input.idempotencyKey) as FixRequestRow | undefined;
    if (existing) return toFixRequest(existing);

    const session = this.projectSessions.getSession();
    if (!session || session.id !== input.sessionId || session.state !== 'running') {
      throw invalid('実行中の開発セッションに対してのみ修正指示を作成できます。');
    }
    const screenshot = this.screenshots.metadata(input.screenshotId);
    if (!screenshot || screenshot.sessionId !== input.sessionId) {
      throw invalid('選択元のスクリーンショットが見つからないか、有効期限が切れています。もう一度対象箇所を選択してください。');
    }

    const row: FixRequestRow = {
      id: randomUUID(),
      session_id: input.sessionId,
      screenshot_id: input.screenshotId,
      instruction: input.instruction.trim(),
      annotation_json: JSON.stringify(input.annotation),
      client_request_id: input.clientRequestId,
      idempotency_key: input.idempotencyKey,
      state: 'awaiting_approval',
      created_at: new Date().toISOString(),
      approved_at: null,
    };
    this.#database
      .prepare(
        `INSERT INTO fix_requests
          (id,session_id,screenshot_id,instruction,annotation_json,client_request_id,idempotency_key,state,created_at,approved_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id,
        row.session_id,
        row.screenshot_id,
        row.instruction,
        row.annotation_json,
        row.client_request_id,
        row.idempotency_key,
        row.state,
        row.created_at,
        row.approved_at,
      );
    this.activities.append({
      kind: 'fix_request.created',
      severity: 'success',
      message: 'Point & Fixの修正指示を確認待ちとして作成しました。',
      metadata: { fixRequestId: row.id, sessionId: row.session_id, screenshotId: row.screenshot_id },
    });
    return toFixRequest(row);
  }

  approve(id: string): FixRequest {
    const row = this.#row(id);
    if (row.state === 'approved') return toFixRequest(row);
    if (row.state !== 'awaiting_approval') {
      throw invalid('この修正指示は承認できる状態ではありません。');
    }
    const approvedAt = new Date().toISOString();
    this.#database
      .prepare("UPDATE fix_requests SET state = 'approved', approved_at = ? WHERE id = ?")
      .run(approvedAt, id);
    const approved: FixRequestRow = { ...row, state: 'approved', approved_at: approvedAt };
    this.activities.append({
      kind: 'fix_request.approved',
      severity: 'success',
      message: '既存Dartファイルだけを変更対象とする修正指示を承認しました。',
      metadata: { fixRequestId: id, sessionId: row.session_id },
    });
    return toFixRequest(approved);
  }

  close(): void {
    this.#database.close();
  }

  #row(id: string): FixRequestRow {
    const row = this.#database.prepare('SELECT * FROM fix_requests WHERE id = ?').get(id) as
      | FixRequestRow
      | undefined;
    if (!row) {
      throw new AgentError({
        code: 'FIX_REQUEST_NOT_FOUND',
        message: '修正指示が見つかりません。',
        status: 404,
        action: 'CHECK_REQUEST',
      });
    }
    return row;
  }
}

function toFixRequest(row: FixRequestRow): FixRequest {
  return {
    id: row.id,
    sessionId: row.session_id,
    screenshotId: row.screenshot_id,
    instruction: row.instruction,
    annotation: JSON.parse(row.annotation_json) as FixAnnotation,
    requestedCapabilities: ['edit_existing_dart', 'hot_reload'],
    clientRequestId: row.client_request_id,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    createdAt: row.created_at,
    ...(row.approved_at ? { approvedAt: row.approved_at } : {}),
  };
}

function validateInput(input: CreateFixRequestInput): void {
  if (
    !isUuid(input.clientRequestId) ||
    typeof input.idempotencyKey !== 'string' ||
    input.idempotencyKey.length < 16 ||
    input.idempotencyKey.length > 128 ||
    typeof input.instruction !== 'string' ||
    input.instruction.trim().length < 1 ||
    input.instruction.trim().length > 2_000 ||
    !isAnnotation(input.annotation)
  ) {
    throw invalid('修正指示、対象位置、再送キーの入力を確認してください。');
  }
}

function isAnnotation(value: FixAnnotation): boolean {
  if (!isUnit(value.x) || !isUnit(value.y)) return false;
  if (value.kind === 'point') return true;
  return isUnit(value.width) && isUnit(value.height) && value.width >= 0.02 && value.height >= 0.02;
}

function isUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function invalid(message: string): AgentError {
  return new AgentError({ code: 'REQUEST_INVALID', message, status: 400, action: 'CHECK_REQUEST' });
}
