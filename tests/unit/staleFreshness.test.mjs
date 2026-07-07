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
const { computeStaleBasis, isMissingExactTarget } = require('../../package/bin/test-run');

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

test('unstattable target (partial -f pattern): project mtime still guards', () => {
  // When `-f Foo.app-spec.ts` / a bare positional filename can't be statted,
  // ensureDaemonFresh passes targetMtime=0. A stale project must NOT be waved
  // through as fresh just because the spec path didn't resolve — the guard has
  // to lean on the project mtime. Regression for the codex finding that the
  // catch branch returned stale:false and blinded the guard on this workflow.
  assert.equal(
    computeStaleBasis({ targetMtime: 0, projectMtime: 1500, builtAt: BUILT_AT }),
    1500,
  );
});

test('unstattable target with a fresh project stays fresh', () => {
  assert.equal(
    computeStaleBasis({ targetMtime: 0, projectMtime: 800, builtAt: BUILT_AT }),
    null,
  );
});

test('equality with builtAt counts as fresh (not-newer, mirrors <= semantics)', () => {
  assert.equal(
    computeStaleBasis({ targetMtime: BUILT_AT, projectMtime: BUILT_AT, builtAt: BUILT_AT }),
    null,
  );
});

// isMissingExactTarget — a deleted/renamed concrete spec path must be treated
// as a hard stale (the daemon may still hold the removed spec), while a bare
// partial filename is a legitimate suite-match pattern that falls back to the
// project mtime. Regression for the codex finding that an unstattable exact
// target was waved through as fresh.
test('exact path with a separator is a missing target (hard stale)', () => {
  assert.equal(isMissingExactTarget('imports/api/foo/FullSync.app-spec.ts'), true);
});

test('nested relative path counts as an exact target', () => {
  assert.equal(isMissingExactTarget('tests/e2e/login.spec.ts'), true);
});

test('bare filename is a partial pattern, not a missing exact target', () => {
  assert.equal(isMissingExactTarget('FullSync.app-spec.ts'), false);
});

test('bare pattern without a separator is not an exact target', () => {
  assert.equal(isMissingExactTarget('FullSync'), false);
});
