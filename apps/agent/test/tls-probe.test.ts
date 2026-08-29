import assert from 'node:assert/strict';
import test from 'node:test';

import { runLocalTlsProbe } from '../src/tls-probe.ts';

test('local TLS probe serves an HTTPS round trip with a SHA-256 fingerprint', async () => {
  const result = await runLocalTlsProbe();

  assert.equal(result.status, 'available');
  assert.equal(result.host, '127.0.0.1');
  assert.match(result.fingerprint256, /^[A-F0-9]{64}$/);
  assert.ok(result.latencyMs >= 0);
});
