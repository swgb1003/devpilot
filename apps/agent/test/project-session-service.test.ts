import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { ActivityStore } from '../src/activity-store.js';
import {
  isFlutterRunReady,
  ProjectSessionService,
} from '../src/project-session-service.js';

test('recognises Android logcat output with a padded process ID as Flutter running', () => {
  assert.equal(
    isFlutterRunReady('W/Firestore( 4734): Stream closed with status: UNAVAILABLE'),
    true,
  );
  assert.equal(isFlutterRunReady('Flutterをビルドしています。'), false);
});

test('Agent restart marks persisted active sessions as failed and gives a recovery trail', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'devpilot-session-recovery-'));
  const databasePath = join(directory, 'devpilot.sqlite3');

  const activities = new ActivityStore(databasePath);
  const sessionId = randomUUID();
  const projectId = randomUUID();
  const seeded = new DatabaseSync(databasePath);
  seeded
    .prepare(
      'INSERT INTO projects (id,name,root_path,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    )
    .run(
      projectId,
      'recovery_fixture',
      directory,
      'ready',
      '2026-09-03T00:00:00.000Z',
      '2026-09-03T00:00:00.000Z',
    );
  seeded
    .prepare(
      'INSERT INTO sessions (id,project_id,state,device_id,started_at,ended_at,detail) VALUES (?,?,?,?,?,?,?)',
    )
    .run(sessionId, projectId, 'running', 'device-123', '2026-09-03T00:00:00.000Z', null, null);
  seeded.close();

  const sessions = new ProjectSessionService(databasePath, activities);
  context.after(() => {
    sessions.close();
    activities.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const recovered = sessions.getSession();
  assert.equal(recovered?.id, sessionId);
  assert.equal(recovered?.state, 'failed');
  assert.ok(recovered?.endedAt);
  assert.match(recovered?.detail ?? '', /再起動/);
  assert.ok(
    activities.list().some((activity) => activity.metadata.reason === 'agent_restart'),
    'the restart recovery must be visible in Activity',
  );
});
