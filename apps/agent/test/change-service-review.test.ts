import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { ActivityStore } from '../src/activity-store.js';
import { ChangeService } from '../src/change-service.js';

test('file selection resets validation and review exposes a bounded line diff', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'devpilot-change-review-'));
  const databasePath = join(directory, 'devpilot.sqlite3');
  const activities = new ActivityStore(databasePath);
  const changes = new ChangeService(databasePath, activities, undefined as never, undefined as never);
  context.after(() => {
    changes.close();
    activities.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const database = new DatabaseSync(databasePath);
  const changeSetId = randomUUID();
  database
    .prepare(
      `INSERT INTO change_sets
       (id,fix_request_id,state,summary,risks_json,created_at,validation_state,validation_detail)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      changeSetId,
      randomUUID(),
      'proposed',
      'Review fixture',
      '[]',
      '2026-09-03T00:00:00.000Z',
      'passed',
      'Previously checked',
    );
  const insert = database.prepare(
    `INSERT INTO change_set_files
     (change_set_id,path,before_sha256,after_sha256,before_content,after_content,additions,deletions,selected)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  insert.run(changeSetId, 'lib/one.dart', 'before-1', 'after-1', 'final color = red;', 'final color = blue;', 1, 1, 1);
  insert.run(changeSetId, 'lib/two.dart', 'before-2', 'after-2', 'void old() {}', 'void next() {}', 1, 1, 1);
  database.close();

  const selected = changes.selectFiles(changeSetId, ['lib/two.dart']);
  assert.equal(selected.validation.state, 'not_run');
  assert.deepEqual(selected.files.filter((file) => file.selected).map((file) => file.path), ['lib/two.dart']);

  const review = changes.reviewFile(changeSetId, 'lib/one.dart');
  assert.match(review.diff, /- 1: final color = red;/);
  assert.match(review.diff, /\+ 1: final color = blue;/);
  assert.equal(review.selected, false);
});
