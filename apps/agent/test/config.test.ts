import assert from 'node:assert/strict';
import test from 'node:test';

import { loadAgentConfig } from '../src/config.ts';

test('loadAgentConfig resolves a safe loopback configuration', () => {
  const config = loadAgentConfig(
    {
      DEVPILOT_AGENT_PORT: '49001',
      DEVPILOT_DESKTOP_TOKEN: 'x'.repeat(32),
      DEVPILOT_DATA_DIR: '.agent-test-data',
    },
    'C:\\workspace',
  );

  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 49_001);
  assert.equal(config.activityRetentionDays, 30);
  assert.match(config.databasePath, /agent-test-data[\\/]devpilot\.sqlite3$/);
});

test('loadAgentConfig rejects a non-loopback bind', () => {
  assert.throws(
    () =>
      loadAgentConfig({
        DEVPILOT_AGENT_HOST: '0.0.0.0',
        DEVPILOT_DESKTOP_TOKEN: 'x'.repeat(32),
      }),
    /only permits.*127\.0\.0\.1/,
  );
});
