// Unit tests for derivePassFailCounts (fo-4xum).
//
// Regression target: .stats.failures returned null whenever [BENCH] stdout
// pollution broke the mocha JSON parse, and there was no top-level field
// callers could rely on instead -- .llm_failures_total was the only reliable
// count, and nothing agents or humans would think to check first.
// derivePassFailCounts is what backs the new top-level .passed/.failed
// fields, always as integers, never null.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { derivePassFailCounts, summarizeFailures, finalizeJsonOutput } = require('../../package/bin/test-run');

test('reads passed/failed straight off stats when both are numbers', () => {
  const output = { stats: { tests: 10, passes: 8, failures: 2, pending: 0 } };
  const failureSummary = summarizeFailures([{ title: 'a' }, { title: 'b' }]);

  assert.deepEqual(derivePassFailCounts(output, failureSummary), { passed: 8, failed: 2 });
});

test('falls back to the failures array total when stats.failures is missing', () => {
  const output = { stats: { tests: 10, passes: 8, pending: 0 } }; // no failures field
  const failureSummary = summarizeFailures([{ title: 'a' }, { title: 'b' }]);

  assert.equal(derivePassFailCounts(output, failureSummary).failed, 2);
});

test('derives passed from tests - failed - pending when stats.passes is missing', () => {
  const output = { stats: { tests: 10, failures: 2, pending: 1 } }; // no passes field
  const failureSummary = summarizeFailures([{ title: 'a' }, { title: 'b' }]);

  assert.equal(derivePassFailCounts(output, failureSummary).passed, 7);
});

test('never returns null: no stats object at all', () => {
  const failureSummary = summarizeFailures(undefined);

  assert.deepEqual(derivePassFailCounts({}, failureSummary), { passed: 0, failed: 0 });
});

test('never returns null: stats present but empty', () => {
  const failureSummary = summarizeFailures([]);

  assert.deepEqual(derivePassFailCounts({ stats: {} }, failureSummary), { passed: 0, failed: 0 });
});

test('derived passed never goes negative when stats disagree with the failures array', () => {
  const output = { stats: { tests: 1, pending: 0 } }; // no passes/failures fields
  const failureSummary = summarizeFailures([{ title: 'a' }, { title: 'b' }, { title: 'c' }]);

  const { passed, failed } = derivePassFailCounts(output, failureSummary);
  assert.equal(failed, 3);
  assert.equal(passed, 0); // 1 - 3 clamps to 0, not -2
});

// The above cases only exercise derivePassFailCounts directly -- they'd stay
// green even if finalizeJsonOutput never wired .passed/.failed onto the
// public JSON payload. These go through the actual public contract.
test('finalizeJsonOutput exposes top-level passed/failed for a passing result', () => {
  const output = { success: true, stats: { tests: 3, passes: 3, failures: 0, pending: 0 }, failures: [] };

  const result = finalizeJsonOutput(output);

  assert.equal(result.passed, 3);
  assert.equal(result.failed, 0);
});

test('finalizeJsonOutput exposes top-level passed/failed for a failing result', () => {
  const output = {
    success: false,
    stats: { tests: 3, passes: 1, failures: 2, pending: 0 },
    failures: [{ title: 'a' }, { title: 'b' }],
  };

  const result = finalizeJsonOutput(output);

  assert.equal(result.passed, 1);
  assert.equal(result.failed, 2);
});
