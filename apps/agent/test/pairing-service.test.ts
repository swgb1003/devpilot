import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { ActivityStore } from '../src/activity-store.ts';
import { AgentError } from '../src/errors.ts';
import { PairingService } from '../src/pairing-service.ts';
import { PairingStore } from '../src/pairing-store.ts';

function createService(): { readonly service: PairingService; readonly activities: ActivityStore } {
  const activities = new ActivityStore(':memory:');
  const service = new PairingService(new PairingStore(':memory:', randomBytes(32)), activities, {
    hostCandidates: ['192.168.10.20'],
    port: 47_831,
    fingerprint: 'sha256/ABCD',
  });
  return { service, activities };
}

test('M3 pairing challenge is one-time and delivers tokens only after Desktop approval', () => {
  const { service, activities } = createService();
  try {
    const challenge = service.createChallenge();
    assert.equal(challenge.status, 'awaiting_confirmation');
    assert.equal(challenge.qrPayload.hostCandidates[0], '192.168.10.20');
    assert.equal(challenge.qrPayload.nonce.length >= 43, true);

    const confirmed = service.confirm(challenge.id, {
      nonce: challenge.qrPayload.nonce,
      displayName: 'Pixel 9 Pro',
      publicKey: 'ed25519-public-key-material-000000000000000000',
    });
    assert.equal(confirmed.state.status, 'awaiting_approval');
    assert.equal(service.statusForDesktop(challenge.id).device?.displayName, 'Pixel 9 Pro');

    service.approve(challenge.id);
    const delivered = service.statusForMobile(challenge.id, confirmed.confirmationTicket);
    assert.equal(delivered.state.status, 'approved');
    assert.ok(delivered.tokens?.accessToken.startsWith('dpa_'));
    assert.ok(delivered.tokens?.refreshToken.startsWith('dpr_'));

    const authenticated = service.authenticate(delivered.tokens!.accessToken);
    assert.equal(authenticated.deviceId, challenge.id);
    const refreshed = service.refresh(delivered.tokens!.refreshToken);
    assert.ok(refreshed.accessToken.startsWith('dpa_'));

    assert.throws(
      () => service.statusForMobile(challenge.id, confirmed.confirmationTicket),
      (error: unknown) => error instanceof AgentError && error.code === 'PAIRING_INVALID',
    );

    service.revoke(challenge.id);
    assert.throws(
      () => service.authenticate(refreshed.accessToken),
      (error: unknown) => error instanceof AgentError && error.code === 'AUTH_INVALID',
    );
    assert.equal(
      activities.list().some((activity) => activity.kind === 'pairing.approved'),
      true,
    );
  } finally {
    service.close();
    activities.close();
  }
});

test('M3 pairing expires after five invalid nonce attempts', () => {
  const { service, activities } = createService();
  try {
    const challenge = service.createChallenge();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      assert.throws(
        () =>
          service.confirm(challenge.id, {
            nonce: 'invalid-nonce-value-that-is-long-enough-to-be-checked',
            displayName: 'Pixel 9 Pro',
            publicKey: 'ed25519-public-key-material-000000000000000000',
          }),
        (error: unknown) => error instanceof AgentError && error.code === 'PAIRING_INVALID',
      );
    }
    assert.throws(
      () =>
        service.confirm(challenge.id, {
          nonce: 'invalid-nonce-value-that-is-long-enough-to-be-checked',
          displayName: 'Pixel 9 Pro',
          publicKey: 'ed25519-public-key-material-000000000000000000',
        }),
      (error: unknown) => error instanceof AgentError && error.code === 'PAIRING_EXPIRED',
    );
  } finally {
    service.close();
    activities.close();
  }
});
