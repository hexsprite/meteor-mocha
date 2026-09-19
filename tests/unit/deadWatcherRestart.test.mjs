// Unit tests for shouldRestartDeadWatcher, the predicate behind the
// dead-watcher auto-restart (fo-pi0kl).
//
// Regression target: ensureDaemonFresh's stale verdict conflates two failure
// shapes. `building: true` means a rebuild fired and is still running (or
// wedged) — a different failure, refuse and report as before. `building:
// false` on a stale verdict means the watcher never reacted at all during the
// wait: it cannot recover on its own, and every later run would answer from a
// frozen bundle while still printing "Fresh run" (observed 2026-09-19, a
// watcher-dead daemon sat 26 minutes unnoticed). Only that shape earns one
// automatic restart. `missing` (target file gone) is a user error, never a
// restart. `alreadyAttempted` is the loop guard — a restart that doesn't
// clear the condition must report and exit, not restart again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldRestartDeadWatcher } = require('../../package/bin/test-run');

test('dead watcher, first attempt: restart', () => {
  assert.equal(
    shouldRestartDeadWatcher({ stale: true, building: false, missing: false }, false),
    true,
  );
});

test('rebuild in flight/wedged (building: true): no restart, different failure', () => {
  assert.equal(
    shouldRestartDeadWatcher({ stale: true, building: true, missing: false }, false),
    false,
  );
});

test('missing target file: no restart, user error', () => {
  assert.equal(
    shouldRestartDeadWatcher({ stale: true, building: false, missing: true }, false),
    false,
  );
});

test('already attempted this invocation: no restart, loop guard', () => {
  assert.equal(
    shouldRestartDeadWatcher({ stale: true, building: false, missing: false }, true),
    false,
  );
});

test('not stale: no restart, nothing to fix', () => {
  assert.equal(
    shouldRestartDeadWatcher({ stale: false, building: false, missing: false }, false),
    false,
  );
});

test('already-attempted is checked before building/missing, so it cannot be bypassed', () => {
  // Even a shape that would otherwise qualify (stale, not building, not
  // missing) must still refuse once alreadyAttempted is true.
  assert.equal(
    shouldRestartDeadWatcher({ stale: true, building: false, missing: false }, true),
    false,
  );
});
