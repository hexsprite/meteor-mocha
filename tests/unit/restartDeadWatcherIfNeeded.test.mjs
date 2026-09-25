// Unit tests for restartDeadWatcherIfNeeded, the decide-and-act step behind
// the dead-watcher auto-restart (fo-pi0kl).
//
// shouldRestartDeadWatcher (deadWatcherRestart.test.mjs) proves the decision
// is right. It does not prove anything CALLS that decision: a direct-call
// unit test on the predicate still passes even if the `if
// (shouldRestartDeadWatcher(...))` block is deleted from the caller — that
// exact failure mode (a unit test green against a build where nothing wires
// the thing up) has bitten this repo before. These tests drive
// restartDeadWatcherIfNeeded — the function runTests() actually calls — with
// injected fakes for stop/start/recheck, and assert on what those fakes
// observed: call counts, order, and arguments. A test here fails only if the
// wiring itself is broken, not just the predicate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { restartDeadWatcherIfNeeded } = require('../../package/bin/test-run');

const DEAD_WATCHER = { stale: true, building: false, missing: false };
const REBUILD_IN_FLIGHT = { stale: true, building: true, missing: false };
const MISSING_TARGET = { stale: true, building: false, missing: true };
const RECHECKED_FRESH = { stale: false };
const RECHECKED_STILL_STALE = { stale: true, building: false, missing: false, builtAt: 111 };

// The real `wait` is a 1s pause between stop and start — inject an instant
// one so these stay pure/cheap like their neighbours, not a slow suite.
const instantWait = async () => {};

test('dead watcher: stop then start, each once, returns the rechecked freshness', async (t) => {
  const calls = [];
  const stop = t.mock.fn(async () => { calls.push('stop'); });
  const start = t.mock.fn(async () => { calls.push('start'); return true; });
  const recheck = t.mock.fn(async () => RECHECKED_FRESH);

  const result = await restartDeadWatcherIfNeeded(DEAD_WATCHER, { stop, start, recheck, wait: instantWait });

  assert.deepEqual(calls, ['stop', 'start'], 'stop must run, then start, in that order');
  assert.equal(stop.mock.callCount(), 1);
  assert.equal(start.mock.callCount(), 1);
  assert.equal(recheck.mock.callCount(), 1);
  assert.equal(result, RECHECKED_FRESH);
});

test('rebuild in flight (building: true): neither stop nor start runs, verdict passes through untouched', async (t) => {
  const stop = t.mock.fn(async () => {});
  const start = t.mock.fn(async () => true);
  const recheck = t.mock.fn(async () => RECHECKED_FRESH);

  const result = await restartDeadWatcherIfNeeded(REBUILD_IN_FLIGHT, { stop, start, recheck });

  assert.equal(stop.mock.callCount(), 0);
  assert.equal(start.mock.callCount(), 0);
  assert.equal(recheck.mock.callCount(), 0);
  assert.equal(result, REBUILD_IN_FLIGHT);
});

test('missing target: neither stop nor start runs, verdict passes through untouched', async (t) => {
  const stop = t.mock.fn(async () => {});
  const start = t.mock.fn(async () => true);
  const recheck = t.mock.fn(async () => RECHECKED_FRESH);

  const result = await restartDeadWatcherIfNeeded(MISSING_TARGET, { stop, start, recheck });

  assert.equal(stop.mock.callCount(), 0);
  assert.equal(start.mock.callCount(), 0);
  assert.equal(recheck.mock.callCount(), 0);
  assert.equal(result, MISSING_TARGET);
});

test('restart does not clear it: stop and start each run once (not twice), the still-stale recheck is returned', async (t) => {
  const stop = t.mock.fn(async () => {});
  const start = t.mock.fn(async () => true);
  const recheck = t.mock.fn(async () => RECHECKED_STILL_STALE);

  const result = await restartDeadWatcherIfNeeded(DEAD_WATCHER, { stop, start, recheck, wait: instantWait });

  assert.equal(stop.mock.callCount(), 1);
  assert.equal(start.mock.callCount(), 1);
  assert.equal(result, RECHECKED_STILL_STALE, 'caller must see the still-stale verdict, not the pre-restart one');
});

test('startDaemon reports failure: recheck never runs, original verdict is returned', async (t) => {
  const stop = t.mock.fn(async () => {});
  const start = t.mock.fn(async () => ({ started: false, error: 'startup_timeout' }));
  const recheck = t.mock.fn(async () => RECHECKED_FRESH);

  const result = await restartDeadWatcherIfNeeded(DEAD_WATCHER, { stop, start, recheck, wait: instantWait });

  assert.equal(stop.mock.callCount(), 1);
  assert.equal(start.mock.callCount(), 1);
  assert.equal(recheck.mock.callCount(), 0, 'a failed restart must not be treated as a reason to recheck');
  assert.equal(result, DEAD_WATCHER);
});
