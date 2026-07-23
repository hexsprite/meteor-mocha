// Unit tests for the wedged-empty-bundle detectors (classifyDaemonFullness +
// isWedgedEmptyResult).
//
// Regression target: the daemon has a failure mode ("Mode B") distinct from the
// staleness guard. A rebuild fires, builtAt refreshes (so ensureDaemonFresh
// passes), but the bundle comes back broken and mocha's suite tree collapses to
// 0. The daemon still reports status:ready, so a bare full run returned a
// clean-looking {tests:0, success:true} — a false all-clear indistinguishable
// from "all tests passed". These two pure predicates back the pre-run gate
// (Detector 1, via classifyDaemonFullness) and the post-run confirmation
// (Detector 2, via isWedgedEmptyResult using the daemon's new suitesTotal). The
// key contract: only an EXPLICIT suites:0 / suitesTotal:0 from a ready daemon is
// a wedge — missing/omitted data (older daemon) must never escalate to a wedge
// report, and a genuine no-match (suitesTotal>0, tests=0) must stay a no-match.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyDaemonFullness,
  isWedgedEmptyResult,
} = require('../../package/bin/test-run');

test('classifyDaemonFullness: loaded when suites > 0', () => {
  assert.equal(classifyDaemonFullness({ status: 'ready', suites: 146 }), 'loaded');
});

test('THE BUG: classifyDaemonFullness reports empty on a ready daemon with suites:0', () => {
  // A ready daemon that has collapsed to 0 suites is the wedge — this is the
  // reading the pre-run gate escalates on.
  assert.equal(classifyDaemonFullness({ status: 'ready', suites: 0 }), 'empty');
});

test('classifyDaemonFullness: unknown when suites is omitted (older daemon)', () => {
  // Must NOT be "empty" — we never escalate to a wedge report on missing data.
  assert.equal(classifyDaemonFullness({ status: 'ready' }), 'unknown');
});

test('classifyDaemonFullness: unknown on null health (no response)', () => {
  assert.equal(classifyDaemonFullness(null), 'unknown');
});

test('classifyDaemonFullness: unknown when suites is not a number', () => {
  assert.equal(classifyDaemonFullness({ suites: '146' }), 'unknown');
});

test('isWedgedEmptyResult: true when suitesTotal is explicitly 0', () => {
  assert.equal(isWedgedEmptyResult({ suitesTotal: 0, testsMatched: 0 }), true);
});

test('isWedgedEmptyResult: false for a genuine no-match (suitesTotal > 0)', () => {
  // 146 suites loaded, pattern matched nothing → real no-match, not a wedge.
  assert.equal(isWedgedEmptyResult({ suitesTotal: 146, testsMatched: 0 }), false);
});

test('isWedgedEmptyResult: false when suitesTotal is absent (older daemon)', () => {
  assert.equal(isWedgedEmptyResult({ failures: 0 }), false);
});

test('isWedgedEmptyResult: false on null/undefined payload', () => {
  assert.equal(isWedgedEmptyResult(null), false);
  assert.equal(isWedgedEmptyResult(undefined), false);
});
