import { randomBytes, timingSafeEqual } from 'node:crypto';

import { AgentError } from './errors.js';

export function requireDesktopToken(authorization: string | undefined, expected: string): void {
  if (!authorization?.startsWith('Bearer ')) {
    throw new AgentError({
      code: 'AUTH_REQUIRED',
      message: 'Desktop認証が必要です。',
      status: 401,
      action: 'REAUTHENTICATE',
    });
  }

  const presented = Buffer.from(authorization.slice('Bearer '.length));
  const expectedBuffer = Buffer.from(expected);
  if (presented.length !== expectedBuffer.length || !timingSafeEqual(presented, expectedBuffer)) {
    throw new AgentError({
      code: 'AUTH_INVALID',
      message: 'Desktop認証情報が無効です。',
      status: 401,
      action: 'REAUTHENTICATE',
    });
  }
}

interface StoredTicket {
  readonly expiresAt: number;
}

export class WsTicketStore {
  readonly #tickets = new Map<string, StoredTicket>();

  issue(ttlMs = 30_000): { ticket: string; expiresAt: string } {
    const ticket = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + ttlMs;
    this.#tickets.set(ticket, { expiresAt });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  consume(ticket: string | undefined): boolean {
    if (!ticket) {
      return false;
    }
    const stored = this.#tickets.get(ticket);
    this.#tickets.delete(ticket);
    return stored !== undefined && stored.expiresAt >= Date.now();
  }
}
