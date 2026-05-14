// Unit tests for the daemon startup-timeout env-var resolver.
//
// Regression target: the daemon's per-attempt startup budget used to be a
// hard-coded 120s. On large full-app codebases, cold builds reliably
// exceeded that and produced startup-timeout × 3 → startup-abandoned with
// empty error_lines — a "deadlock" symptom that was actually just a too-
// tight budget. The fix replaces the constant with a soft budget (default
// 240s) plus a hard ceiling (default 600s), both env-overridable, with a
// progress-stall fallback in between.
//
// resolvePositiveMsEnv is the shared parser used by both budgets. These
// tests pin its contract so a regression in the parsing rules (e.g.
// accepting 0, NaN, or negative values) can't silently re-introduce the
// original bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// The CLI lives at package/bin/test-run with no extension; createRequire
// lets us pull it in as a CommonJS module from this ESM test file.
const require = createRequire(import.meta.url);
const { resolvePositiveMsEnv } = require('../../package/bin/test-run');

test('returns the fallback when the env var is unset', () => {
  assert.equal(resolvePositiveMsEnv(undefined, 240000), 240000);
});

test('returns the fallback when the env var is empty', () => {
  assert.equal(resolvePositiveMsEnv('', 240000), 240000);
});

test('returns the fallback for non-numeric input', () => {
  assert.equal(resolvePositiveMsEnv('abc', 240000), 240000);
});

test('returns the fallback for zero (no-positive-progress guard)', () => {
  assert.equal(resolvePositiveMsEnv('0', 240000), 240000);
});

test('returns the fallback for negative values', () => {
  assert.equal(resolvePositiveMsEnv('-50', 240000), 240000);
});

test('returns the parsed value for a positive integer string', () => {
  assert.equal(resolvePositiveMsEnv('360000', 240000), 360000);
});

test('parses a leading integer and ignores trailing junk (parseInt behavior)', () => {
  // parseInt('300000ms', 10) returns 300000, so this is accepted. Documented
  // here so a future "strict" rewrite that breaks this stays intentional.
  assert.equal(resolvePositiveMsEnv('300000ms', 240000), 300000);
});

test('handles very large values without overflow', () => {
  assert.equal(resolvePositiveMsEnv('3600000', 240000), 3600000);
});
