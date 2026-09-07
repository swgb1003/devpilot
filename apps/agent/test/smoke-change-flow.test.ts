import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { ActivityStore } from '../src/activity-store.js';
import { ChangeService } from '../src/change-service.js';
import type {
  AiProposalProvider,
  CodexFixContext,
  CodexProposal,
} from '../src/codex-cli-provider.js';
import { ScreenshotArtifactStore } from '../src/device-controller.js';
import { FixRequestService } from '../src/fix-request-service.js';
import { ProjectSessionService } from '../src/project-session-service.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fixtureSource = join(repoRoot, 'fixtures', 'sample_flutter_app');

/**
 * Deterministic stand-in for {@link CodexCliProvider}: rewrites the sample app's
 * greeting seed so the change flow has a real, bounded patch to carry end to
 * end without invoking the `codex` CLI.
 */
const fakeAi: AiProposalProvider = {
  propose(context: CodexFixContext): Promise<CodexProposal> {
    const target = context.files.find((file) => file.path === 'lib/main.dart');
    assert.ok(target, 'sample app context is missing lib/main.dart');
    const after = target.content.replace("String _greeting = 'Hello';", "String _greeting = 'Hi';");
    assert.notEqual(after, target.content, 'fake patch did not change lib/main.dart');
    return Promise.resolve({
      summary: 'Seed the greeting with "Hi" instead of "Hello".',
      risks: [],
      files: [{ path: 'lib/main.dart', content: after }],
    });
  },
};

// The Flutter-backed validation gate (`dart format` + `flutter analyze` on a
// staged copy) only runs when the caller has a toolchain ready — set the flag
// after `flutter pub get` in fixtures/sample_flutter_app. The default CI path
// stays deterministic and Flutter-free.
const withFlutter = process.env.DEVPILOT_SMOKE_WITH_FLUTTER === '1';

test('Point & Fix change flow carries a fake Codex patch through apply and revert', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'devpilot-smoke-'));
  const databasePath = join(directory, 'devpilot.sqlite3');
  const projectRoot = join(directory, 'sample_flutter_app');
  cpSync(fixtureSource, projectRoot, { recursive: true });
  const mainDart = join(projectRoot, 'lib', 'main.dart');
  const originalMain = readFileSync(mainDart, 'utf8');

  const activities = new ActivityStore(databasePath);
  const screenshots = new ScreenshotArtifactStore();
  const projectSessions = new ProjectSessionService(databasePath, activities);
  const fixRequests = new FixRequestService(databasePath, activities, screenshots, projectSessions);
  const changes = new ChangeService(databasePath, activities, fixRequests, projectSessions, fakeAi);
  context.after(() => {
    changes.close();
    fixRequests.close();
    projectSessions.close();
    activities.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const project = projectSessions.register(projectRoot);

  // Seed the running session and the approved fix request the phone would have
  // produced from a screenshot annotation.
  const sessionId = randomUUID();
  const fixRequestId = randomUUID();
  const seed = new DatabaseSync(databasePath);
  seed
    .prepare(
      'INSERT INTO sessions (id,project_id,state,device_id,started_at,ended_at,detail) VALUES (?,?,?,?,?,?,?)',
    )
    .run(sessionId, project.id, 'running', 'emulator-5554', new Date().toISOString(), null, 'seed');
  seed
    .prepare(
      `INSERT INTO fix_requests
        (id,session_id,screenshot_id,instruction,annotation_json,client_request_id,idempotency_key,state,created_at,approved_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      fixRequestId,
      sessionId,
      randomUUID(),
      'ボタンの上の挨拶文を「Hi」にして',
      JSON.stringify({ kind: 'rectangle', x: 0.1, y: 0.1, width: 0.5, height: 0.1 }),
      randomUUID(),
      randomUUID().replaceAll('-', ''),
      'approved',
      new Date().toISOString(),
      new Date().toISOString(),
    );
  seed.close();

  const proposed = await changes.generate(fixRequestId);
  assert.equal(proposed.state, 'proposed');
  assert.deepEqual(
    proposed.files.map((file) => file.path),
    ['lib/main.dart'],
  );

  const review = changes.reviewFile(proposed.id, 'lib/main.dart');
  assert.match(review.diff, /Hello/);
  assert.match(review.diff, /Hi/);

  changes.selectFiles(proposed.id, ['lib/main.dart']);

  if (withFlutter) {
    const validated = await changes.validate(proposed.id);
    assert.equal(validated.validation.state, 'passed', validated.validation.detail);
  } else {
    const bypass = new DatabaseSync(databasePath);
    bypass
      .prepare(
        "UPDATE change_sets SET validation_state='passed', validation_detail='validation gate not exercised' WHERE id=?",
      )
      .run(proposed.id);
    bypass.close();
  }

  const applied = await changes.apply(proposed.id);
  assert.equal(applied.state, 'applied');
  assert.match(readFileSync(mainDart, 'utf8'), /String _greeting = 'Hi';/);

  // Reconnect resync: a phone that dropped its WebSocket during apply re-reads
  // the change set over HTTP and must see the terminal state, not the stale one.
  const afterApplyReread = changes.get(proposed.id);
  assert.equal(afterApplyReread.state, 'applied');
  assert.ok(afterApplyReread.appliedAt);

  const reverted = changes.revert(proposed.id);
  assert.equal(reverted.state, 'reverted');
  assert.equal(readFileSync(mainDart, 'utf8'), originalMain);
  assert.equal(changes.get(proposed.id).state, 'reverted');

  const kinds = activities.list(50).map((activity) => activity.kind);
  assert.ok(kinds.includes('change.proposed'));
  assert.ok(kinds.includes('change.applied'));
  assert.ok(kinds.includes('change.reverted'));
});
