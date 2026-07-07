// Unit tests for the staleness-guard core (computeStaleBasis).
//
// Regression target: ensureDaemonFresh originally compared ONLY the targeted
// spec's mtime to the daemon's builtAt. That missed the common TDD loop —
// edit an implementation file under imports/ (or server//client/), then rerun
// the *same* spec without touching it. The spec's mtime stays <= builtAt, so
// the spec-only check reported "fresh" even when a wedged watcher was serving
// a bundle built before the impl edit: a confident pass/fail for code that is
// no longer what's on disk. The fix folds the newest project-source mtime into
// the comparison. These tests pin that contract so a future refactor can't
// silently drop the project mtime and re-open the hole.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeStaleBasis } = require('../../package/bin/test-run');

const BUILT_AT = 1000;

test('null (fresh) when neither spec nor project source is newer than builtAt', () => {
  assert.equal(
    computeStaleBasis({ targetMtime: 500, projectMtime: 900, builtAt: BUILT_AT }),
    null,
  );
});

test('returns the spec mtime when the targeted spec itself is newer', () => {
  assert.equal(
    computeStaleBasis({ targetMtime: 1500, projectMtime: 800, builtAt: BUILT_AT }),
    1500,
  );
});

test('THE BUG: returns the project mtime when an impl edit is newer but the spec is not', () => {
  // Spec untouched (older than the last build) but an implementation file under
  // imports/ was edited after the build. Spec-only logic returned null here and
  // lied "fresh"; folding in the project mtime now surfaces it for the wait/
  // stale check.
  assert.equal(
    computeStaleBasis({ targetMtime: 500, projectMtime: 1500, builtAt: BUILT_AT }),
    1500,
  );
});

test('prefers the spec mtime when both are newer and the spec is the newest', () => {
  assert.equal(
    computeStaleBasis({ targetMtime: 2000, projectMtime: 1500, builtAt: BUILT_AT }),
    2000,
  );
});

test('uses the project mtime when both are newer and the project is the newest', () => {
  assert.equal(
    computeStaleBasis({ targetMtime: 1200, projectMtime: 1800, builtAt: BUILT_AT }),
    1800,
  );
});

test('equality with builtAt counts as fresh (not-newer, mirrors <= semantics)', () => {
  assert.equal(
    computeStaleBasis({ targetMtime: BUILT_AT, projectMtime: BUILT_AT, builtAt: BUILT_AT }),
    null,
  );
});
