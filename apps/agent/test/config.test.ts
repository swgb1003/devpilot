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

test('loadAgentConfig accepts Tailscale pairing hosts and wireless ADB targets', () => {
  const config = loadAgentConfig(
    {
      DEVPILOT_DESKTOP_TOKEN: 'x'.repeat(32),
      DEVPILOT_PAIRING_EXTRA_HOSTS: '100.101.102.103, 192.168.1.9 , 100.101.102.103',
      DEVPILOT_ADB_CONNECT_TARGETS: '100.64.5.6:5555,phone.local:5555',
    },
    'C:\\workspace',
  );

  assert.deepEqual(config.pairingExtraHosts, ['100.101.102.103', '192.168.1.9']);
  assert.deepEqual(config.adbConnectTargets, ['100.64.5.6:5555', 'phone.local:5555']);
});

test('loadAgentConfig rejects a public pairing host and a malformed ADB target', () => {
  assert.throws(
    () =>
      loadAgentConfig({
        DEVPILOT_DESKTOP_TOKEN: 'x'.repeat(32),
        DEVPILOT_PAIRING_EXTRA_HOSTS: '8.8.8.8',
      }),
    /DEVPILOT_PAIRING_EXTRA_HOSTS/,
  );
  assert.throws(
    () =>
      loadAgentConfig({
        DEVPILOT_DESKTOP_TOKEN: 'x'.repeat(32),
        DEVPILOT_ADB_CONNECT_TARGETS: '100.64.5.6',
      }),
    /DEVPILOT_ADB_CONNECT_TARGETS/,
  );
});
