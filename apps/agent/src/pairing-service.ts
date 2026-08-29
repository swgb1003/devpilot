import { randomBytes, randomUUID } from 'node:crypto';

import {
  protocolVersion,
  type DeviceTokens,
  type PairingChallenge,
  type PairingPendingDevice,
  type PairingQrPayload,
  type PairingState,
} from '@devpilot/contracts';

import { ActivityStore } from './activity-store.js';
import { AgentError } from './errors.js';
import { PairingStore } from './pairing-store.js';

export interface PairingEndpoint {
  readonly hostCandidates: readonly string[];
  readonly port: number;
  readonly fingerprint: string;
}

export class PairingService {
  constructor(
    private readonly store: PairingStore,
    private readonly activities: ActivityStore,
    private readonly endpoint: PairingEndpoint,
  ) {}

  createChallenge(now = new Date()): PairingChallenge {
    if (this.endpoint.hostCandidates.length === 0) {
      throw new AgentError({
        code: 'PAIRING_INVALID',
        message: '同一LANで利用できるPCのIPv4アドレスが見つかりません。',
        status: 503,
        retryable: true,
        action: 'OPEN_DETAILS',
      });
    }
    const expiresAt = new Date(now.getTime() + 120_000).toISOString();
    const qrPayload: PairingQrPayload = {
      scheme: 'devpilot',
      version: protocolVersion,
      pairingId: randomUUID(),
      hostCandidates: this.endpoint.hostCandidates,
      port: this.endpoint.port,
      nonce: randomBytes(32).toString('base64url'),
      expiresAt,
      serverPublicKeyFingerprint: this.endpoint.fingerprint,
    };
    const challenge = this.store.create(qrPayload);
    this.activities.append({
      kind: 'pairing.created',
      message: 'PC pairing QR challenge was created.',
      metadata: { pairingId: challenge.id, expiresAt, hostCount: qrPayload.hostCandidates.length },
    });
    return challenge;
  }

  confirm(
    pairingId: string,
    input: { readonly nonce: string; readonly displayName: string; readonly publicKey: string },
  ): { readonly state: PairingState; readonly confirmationTicket: string } {
    const device = validateDevice(input);
    const result = this.store.confirm(pairingId, input.nonce, device);
    this.activities.append({
      kind: 'pairing.confirmed',
      message: 'A mobile device is waiting for Desktop approval.',
      metadata: { pairingId, deviceName: device.displayName },
    });
    return result;
  }

  approve(pairingId: string): PairingState {
    const state = this.store.approve(pairingId);
    this.activities.append({
      kind: 'pairing.approved',
      severity: 'success',
      message: 'Desktop approved a mobile device pairing.',
      metadata: { pairingId, deviceName: state.device?.displayName ?? 'unknown' },
    });
    return state;
  }

  statusForDesktop(pairingId: string): PairingState {
    return this.store.getForDesktop(pairingId);
  }

  statusForMobile(
    pairingId: string,
    confirmationTicket: string,
  ): { readonly state: PairingState; readonly tokens?: DeviceTokens } {
    return this.store.consumeApproval(pairingId, confirmationTicket);
  }

  authenticate(token: string): { readonly deviceId: string } {
    return this.store.authenticate(token);
  }

  refresh(refreshToken: string): Omit<DeviceTokens, 'refreshToken' | 'refreshTokenExpiresAt'> {
    return this.store.refresh(refreshToken);
  }

  revoke(deviceId: string): void {
    this.store.revoke(deviceId);
    this.activities.append({
      kind: 'pairing.revoked',
      severity: 'warning',
      message: 'A mobile device was unpaired.',
      metadata: { pairingId: deviceId },
    });
  }

  close(): void {
    this.store.close();
  }
}

function validateDevice(value: {
  readonly nonce: string;
  readonly displayName: string;
  readonly publicKey: string;
}): PairingPendingDevice {
  if (
    typeof value.nonce !== 'string' ||
    value.nonce.length < 43 ||
    typeof value.displayName !== 'string' ||
    value.displayName.trim().length < 1 ||
    value.displayName.length > 80 ||
    typeof value.publicKey !== 'string' ||
    value.publicKey.length < 32 ||
    value.publicKey.length > 512
  ) {
    throw new AgentError({
      code: 'REQUEST_INVALID',
      message: '端末名または端末公開鍵の入力形式が正しくありません。',
      status: 400,
      action: 'CHECK_REQUEST',
    });
  }
  return { displayName: value.displayName.trim(), publicKey: value.publicKey };
}
