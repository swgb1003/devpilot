import assert from 'node:assert/strict';
import test from 'node:test';

import { ActivityStore, agentSchemaVersion } from '../src/activity-store.ts';

test('ActivityStore migrates and returns newest activities first', () => {
  const store = new ActivityStore(':memory:');
  try {
    assert.equal(store.schemaVersion(), agentSchemaVersion);
    store.append({ kind: 'config.loaded', message: 'first' }, '2026-08-28T00:00:00.000Z');
    store.append(
      { kind: 'storage.migrated', severity: 'success', message: 'second' },
      '2026-08-28T00:00:01.000Z',
    );

    const activities = store.list();
    assert.equal(activities.length, 2);
    assert.equal(activities[0]?.message, 'second');
    assert.equal(activities[1]?.message, 'first');
  } finally {
    store.close();
  }
});

test('ActivityStore purges expired activity records', () => {
  const store = new ActivityStore(':memory:');
  try {
    store.append({ kind: 'user.note', message: 'expired' }, '2026-01-01T00:00:00.000Z');
    store.append({ kind: 'user.note', message: 'current' }, '2026-08-27T00:00:00.000Z');
    assert.equal(store.purgeOlderThan(30, new Date('2026-08-28T00:00:00.000Z')), 1);
    assert.deepEqual(
      store.list().map((activity) => activity.message),
      ['current'],
    );
  } finally {
    store.close();
  }
});
