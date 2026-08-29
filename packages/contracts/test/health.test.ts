import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentHealth, protocolVersion } from '../src/index.ts';

test('creates the M0 health contract', () => {
  const health = createAgentHealth('0.1.0');

  assert.equal(health.name, 'devpilot-agent');
  assert.equal(health.protocolVersion, protocolVersion);
  assert.equal(health.status, 'ready');
  assert.match(health.occurredAt, /^\d{4}-\d{2}-\d{2}T/);
});
