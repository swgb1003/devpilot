import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type {
  DeviceTokens,
  PairingChallenge,
  PairingPendingDevice,
  PairingQrPayload,
  PairingState,
  PairingStatus,
} from '@devpilot/contracts';

import { AgentError } from './errors.js';

const accessTokenLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const refreshTokenLifetimeMs = 90 * 24 * 60 * 60 * 1000;
const maximumFailedAttempts = 5;

interface PairingRow {
  readonly id: string;
  readonly status: PairingStatus;
  readonly device_name: string | null;
  readonly public_key: string | null;
  readonly expires_at: string | null;
  readonly nonce_hash: string | null;
  readonly confirmation_ticket_hash: string | null;
  readonly delivery_ciphertext: string | null;
  readonly delivery_consumed_at: string | null;
  readonly failed_attempts: number;
}

interface TokenRow {
  readonly pairing_id: string;
  readonly expires_at: string;
  readonly revoked_at: string | null;
  readonly status: PairingStatus;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function encrypt(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

function decrypt(value: string, key: Buffer): string {
  const [ivPart, tagPart, ciphertextPart] = value.split('.');
  if (!ivPart || !tagPart || !ciphertextPart) {
    throw new Error('Stored token delivery cannot be decoded.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function asState(row: PairingRow): PairingState {
  return {
    id: row.id,
    status: row.status,
    expiresAt: row.expires_at ?? new Date(0).toISOString(),
    ...(row.device_name && row.public_key
      ? { device: { displayName: row.device_name, publicKey: row.public_key } }
      : {}),
  };
}

function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export class PairingStore {
  readonly #database: DatabaseSync;
  readonly #tokenKey: Buffer;

  constructor(databasePath: string, tokenKey: Buffer) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS pairings (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        device_name TEXT,
        public_key TEXT,
        token_hash TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        approved_at TEXT,
        revoked_at TEXT,
        nonce_hash TEXT,
        confirmation_ticket_hash TEXT,
        delivery_ciphertext TEXT,
        delivery_consumed_at TEXT,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS device_tokens (
        id TEXT PRIMARY KEY,
        pairing_id TEXT NOT NULL REFERENCES pairings(id),
        kind TEXT NOT NULL CHECK(kind IN ('access', 'refresh')),
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_device_tokens_pairing
        ON device_tokens(pairing_id, kind, revoked_at);
    `);
    this.#tokenKey = tokenKey;
  }

  create(qrPayload: PairingQrPayload): PairingChallenge {
    const now = new Date().toISOString();
    this.#database
      .prepare(
        `INSERT INTO pairings
          (id, status, created_at, expires_at, nonce_hash, failed_attempts, updated_at)
         VALUES (?, 'awaiting_confirmation', ?, ?, ?, 0, ?)`,
      )
      .run(qrPayload.pairingId, now, qrPayload.expiresAt, hash(qrPayload.nonce), now);
    return {
      id: qrPayload.pairingId,
      status: 'awaiting_confirmation',
      qrPayload,
      expiresAt: qrPayload.expiresAt,
    };
  }

  getForDesktop(pairingId: string, now = new Date()): PairingState {
    return asState(this.#requireCurrent(pairingId, now));
  }

  confirm(
    pairingId: string,
    nonce: string,
    device: PairingPendingDevice,
    now = new Date(),
  ): { readonly state: PairingState; readonly confirmationTicket: string } {
    const pairing = this.#requireCurrent(pairingId, now);
    if (pairing.status !== 'awaiting_confirmation') {
      throw this.#statusError(pairing.status);
    }

    if (!pairing.nonce_hash || !constantTimeEquals(hash(nonce), pairing.nonce_hash)) {
      const failedAttempts = pairing.failed_attempts + 1;
      const expires = failedAttempts >= maximumFailedAttempts;
      this.#database
        .prepare(
          `UPDATE pairings
           SET failed_attempts = ?, status = CASE WHEN ? THEN 'expired' ELSE status END,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(failedAttempts, expires ? 1 : 0, now.toISOString(), pairingId);
      if (expires) {
        throw this.#statusError('expired');
      }
      throw new AgentError({
        code: 'PAIRING_INVALID',
        message: 'QRコードの確認情報が一致しません。',
        status: 400,
        action: 'CHECK_REQUEST',
      });
    }

    const confirmationTicket = newToken('dpc');
    this.#database
      .prepare(
        `UPDATE pairings
         SET status = 'awaiting_approval', device_name = ?, public_key = ?,
             confirmation_ticket_hash = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        device.displayName,
        device.publicKey,
        hash(confirmationTicket),
        now.toISOString(),
        pairingId,
      );

    return {
      state: this.getForDesktop(pairingId, now),
      confirmationTicket,
    };
  }

  approve(pairingId: string, now = new Date()): PairingState {
    const pairing = this.#requireCurrent(pairingId, now);
    if (pairing.status !== 'awaiting_approval') {
      throw this.#statusError(pairing.status);
    }

    const accessTokenExpiresAt = new Date(now.getTime() + accessTokenLifetimeMs).toISOString();
    const refreshTokenExpiresAt = new Date(now.getTime() + refreshTokenLifetimeMs).toISOString();
    const tokens: DeviceTokens = {
      deviceId: pairingId,
      accessToken: newToken('dpa'),
      accessTokenExpiresAt,
      refreshToken: newToken('dpr'),
      refreshTokenExpiresAt,
    };
    const encryptedDelivery = encrypt(JSON.stringify(tokens), this.#tokenKey);
    const timestamp = now.toISOString();

    this.#database.exec('BEGIN IMMEDIATE;');
    try {
      this.#database
        .prepare(
          `UPDATE pairings
           SET status = 'approved', delivery_ciphertext = ?, delivery_consumed_at = NULL,
               approved_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(encryptedDelivery, timestamp, timestamp, pairingId);
      const insertToken = this.#database.prepare(
        `INSERT INTO device_tokens (id, pairing_id, kind, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      insertToken.run(
        randomUUID(),
        pairingId,
        'access',
        hash(tokens.accessToken),
        accessTokenExpiresAt,
        timestamp,
      );
      insertToken.run(
        randomUUID(),
        pairingId,
        'refresh',
        hash(tokens.refreshToken),
        refreshTokenExpiresAt,
        timestamp,
      );
      this.#database.exec('COMMIT;');
    } catch (error) {
      this.#database.exec('ROLLBACK;');
      throw error;
    }

    return this.getForDesktop(pairingId, now);
  }

  consumeApproval(
    pairingId: string,
    confirmationTicket: string,
    now = new Date(),
  ): {
    readonly state: PairingState;
    readonly tokens?: DeviceTokens;
  } {
    const pairing = this.#requireCurrent(pairingId, now);
    if (
      !pairing.confirmation_ticket_hash ||
      !constantTimeEquals(hash(confirmationTicket), pairing.confirmation_ticket_hash)
    ) {
      throw new AgentError({
        code: 'PAIRING_INVALID',
        message: 'このペアリングの確認情報は無効です。',
        status: 401,
        action: 'REAUTHENTICATE',
      });
    }
    if (pairing.status !== 'approved') {
      return { state: asState(pairing) };
    }
    if (pairing.delivery_consumed_at || !pairing.delivery_ciphertext) {
      throw new AgentError({
        code: 'PAIRING_REPLAYED',
        message: 'このペアリング用トークンはすでに受け取られています。',
        status: 409,
        action: 'REAUTHENTICATE',
      });
    }

    const tokens = JSON.parse(decrypt(pairing.delivery_ciphertext, this.#tokenKey)) as DeviceTokens;
    this.#database
      .prepare(
        `UPDATE pairings SET delivery_consumed_at = ?, delivery_ciphertext = NULL,
          confirmation_ticket_hash = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(now.toISOString(), now.toISOString(), pairingId);
    return { state: asState(pairing), tokens };
  }

  authenticate(accessToken: string, now = new Date()): { readonly deviceId: string } {
    const token = this.#database
      .prepare(
        `SELECT device_tokens.pairing_id, device_tokens.expires_at, device_tokens.revoked_at,
                pairings.status
         FROM device_tokens JOIN pairings ON pairings.id = device_tokens.pairing_id
         WHERE device_tokens.kind = 'access' AND device_tokens.token_hash = ?`,
      )
      .get(hash(accessToken)) as TokenRow | undefined;
    if (!token || token.revoked_at || token.status !== 'approved') {
      throw new AgentError({
        code: 'AUTH_INVALID',
        message: '端末認証情報が無効です。',
        status: 401,
        action: 'REAUTHENTICATE',
      });
    }
    if (new Date(token.expires_at).getTime() <= now.getTime()) {
      throw new AgentError({
        code: 'AUTH_TOKEN_EXPIRED',
        message: '端末認証情報の有効期限が切れました。',
        status: 401,
        action: 'REAUTHENTICATE',
      });
    }
    return { deviceId: token.pairing_id };
  }

  refresh(
    refreshToken: string,
    now = new Date(),
  ): Omit<DeviceTokens, 'refreshToken' | 'refreshTokenExpiresAt'> {
    const token = this.#database
      .prepare(
        `SELECT device_tokens.pairing_id, device_tokens.expires_at, device_tokens.revoked_at,
                pairings.status
         FROM device_tokens JOIN pairings ON pairings.id = device_tokens.pairing_id
         WHERE device_tokens.kind = 'refresh' AND device_tokens.token_hash = ?`,
      )
      .get(hash(refreshToken)) as TokenRow | undefined;
    if (!token || token.revoked_at || token.status !== 'approved') {
      throw new AgentError({
        code: 'AUTH_INVALID',
        message: '更新トークンが無効です。',
        status: 401,
        action: 'REAUTHENTICATE',
      });
    }
    if (new Date(token.expires_at).getTime() <= now.getTime()) {
      throw new AgentError({
        code: 'AUTH_TOKEN_EXPIRED',
        message: '更新トークンの有効期限が切れました。',
        status: 401,
        action: 'REAUTHENTICATE',
      });
    }
    const accessToken = newToken('dpa');
    const accessTokenExpiresAt = new Date(now.getTime() + accessTokenLifetimeMs).toISOString();
    this.#database
      .prepare(
        `INSERT INTO device_tokens (id, pairing_id, kind, token_hash, expires_at, created_at)
         VALUES (?, ?, 'access', ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        token.pairing_id,
        hash(accessToken),
        accessTokenExpiresAt,
        now.toISOString(),
      );
    return { deviceId: token.pairing_id, accessToken, accessTokenExpiresAt };
  }

  revoke(deviceId: string, now = new Date()): void {
    const timestamp = now.toISOString();
    this.#database.exec('BEGIN IMMEDIATE;');
    try {
      this.#database
        .prepare(
          `UPDATE pairings SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(timestamp, timestamp, deviceId);
      this.#database
        .prepare(
          `UPDATE device_tokens SET revoked_at = ? WHERE pairing_id = ? AND revoked_at IS NULL`,
        )
        .run(timestamp, deviceId);
      this.#database.exec('COMMIT;');
    } catch (error) {
      this.#database.exec('ROLLBACK;');
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }

  #requireCurrent(pairingId: string, now: Date): PairingRow {
    const pairing = this.#database
      .prepare(
        `SELECT id, status, device_name, public_key, expires_at, nonce_hash,
                confirmation_ticket_hash, delivery_ciphertext, delivery_consumed_at, failed_attempts
         FROM pairings WHERE id = ?`,
      )
      .get(pairingId) as PairingRow | undefined;
    if (!pairing) {
      throw new AgentError({
        code: 'PAIRING_INVALID',
        message: 'ペアリング要求が見つかりません。',
        status: 404,
        action: 'REAUTHENTICATE',
      });
    }
    if (
      pairing.status !== 'approved' &&
      pairing.status !== 'revoked' &&
      pairing.status !== 'denied' &&
      pairing.expires_at &&
      new Date(pairing.expires_at).getTime() <= now.getTime()
    ) {
      this.#database
        .prepare(`UPDATE pairings SET status = 'expired', updated_at = ? WHERE id = ?`)
        .run(now.toISOString(), pairingId);
      return { ...pairing, status: 'expired' };
    }
    return pairing;
  }

  #statusError(status: PairingStatus): AgentError {
    if (status === 'expired') {
      return new AgentError({
        code: 'PAIRING_EXPIRED',
        message: 'QRコードの有効期限が切れました。Desktopで新しいQRコードを表示してください。',
        status: 410,
        action: 'RETRY',
      });
    }
    if (status === 'approved') {
      return new AgentError({
        code: 'PAIRING_REPLAYED',
        message: 'このQRコードはすでに使用されています。',
        status: 409,
        action: 'REAUTHENTICATE',
      });
    }
    if (status === 'denied' || status === 'revoked') {
      return new AgentError({
        code: 'PAIRING_DENIED',
        message: 'このペアリングは承認されていません。',
        status: 403,
        action: 'REAUTHENTICATE',
      });
    }
    return new AgentError({
      code: 'PAIRING_PENDING',
      message: 'このペアリングは現在の状態では実行できません。',
      status: 409,
      action: 'RETRY',
    });
  }
}
