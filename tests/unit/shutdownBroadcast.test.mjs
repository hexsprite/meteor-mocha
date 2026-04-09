// Unit tests for the daemon shutdown broadcast path.
//
// Regression target: https://github.com/hexsprite/focuster/issues/892 — a
// daemon SIGTERM used to leave connected CLI clients hanging indefinitely.
// The fix (a) writes a daemon-shutdown SSE event to every tracked connection,
// (b) waits for those writes to drain, and (c) exits with a hard upper bound
// so a wedged socket can't stall the exit path.
//
// These tests exercise (a)–(c) directly without booting a Meteor server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { broadcastShutdown } from '../../package/shutdownBroadcast.js';

// Minimal fake SSE response object. Mirrors the surface area broadcastShutdown
// touches: write(), end(cb), and the 'error'/'close' events.
function makeFakeRes({ flushDelayMs = 0, writeThrows = false } = {}) {
  const res = new EventEmitter();
  res.writes = [];
  res.ended = false;
  res.write = (chunk) => {
    if (writeThrows) throw new Error('simulated write failure');
    res.writes.push(chunk);
    return true;
  };
  res.end = (cb) => {
    res.ended = true;
    if (typeof cb === 'function') {
      if (flushDelayMs > 0) setTimeout(cb, flushDelayMs);
      else setImmediate(cb);
    }
  };
  return res;
}

test('broadcasts a daemon-shutdown SSE event to every connection', async () => {
  const a = makeFakeRes();
  const b = makeFakeRes();
  const result = await broadcastShutdown({
    connections: [a, b],
    reason: 'SIGTERM',
  });

  assert.equal(result.notified, 2);
  assert.equal(result.drained, 2);
  assert.equal(result.timedOut, false);

  for (const res of [a, b]) {
    assert.equal(res.writes.length, 1);
    const payload = res.writes[0];
    assert.match(payload, /^data: /);
    const parsed = JSON.parse(payload.replace(/^data: /, '').trim());
    assert.equal(parsed.type, 'daemon-shutdown');
    assert.equal(parsed.reason, 'SIGTERM');
    assert.equal(res.ended, true);
  }
});

test('resolves immediately when there are no connected clients', async () => {
  const result = await broadcastShutdown({ connections: [], reason: 'SIGTERM' });
  assert.deepEqual(result, { notified: 0, drained: 0, timedOut: false });
});

test('waits for the end() callback to fire before resolving', async () => {
  const start = Date.now();
  const slow = makeFakeRes({ flushDelayMs: 80 });
  const result = await broadcastShutdown({
    connections: [slow],
    reason: 'SIGTERM',
  });
  const elapsed = Date.now() - start;
  assert.equal(result.drained, 1);
  assert.equal(result.timedOut, false);
  // Should have waited for the simulated flush, but not longer than needed.
  assert.ok(elapsed >= 70, `expected at least ~80ms wait, got ${elapsed}ms`);
  assert.ok(elapsed < 500, `should not have run to hard timeout, got ${elapsed}ms`);
});

test('enforces a hard upper bound when a socket never drains', async () => {
  // end() never calls its callback — simulates a wedged socket.
  const stuck = new EventEmitter();
  stuck.writes = [];
  stuck.write = (chunk) => { stuck.writes.push(chunk); return true; };
  stuck.end = () => {}; // Swallow callback forever.

  const start = Date.now();
  const result = await broadcastShutdown({
    connections: [stuck],
    reason: 'SIGTERM',
    hardTimeoutMs: 120,
  });
  const elapsed = Date.now() - start;

  assert.equal(result.notified, 1);
  assert.equal(result.drained, 0);
  assert.equal(result.timedOut, true);
  assert.ok(elapsed >= 100, `expected ~120ms timeout, got ${elapsed}ms`);
  // Data was still written before we gave up waiting.
  assert.equal(stuck.writes.length, 1);
});

test('tolerates a write() that throws (bad socket) without aborting the loop', async () => {
  const bad = makeFakeRes({ writeThrows: true });
  const good = makeFakeRes();
  let loggedOnce = false;
  const result = await broadcastShutdown({
    connections: [bad, good],
    reason: 'SIGTERM',
    logger: () => { loggedOnce = true; },
  });
  assert.equal(result.notified, 2);
  assert.equal(result.drained, 2);
  assert.equal(result.timedOut, false);
  assert.equal(loggedOnce, true, 'should have logged the write failure');
  // The good connection still got its payload.
  assert.equal(good.writes.length, 1);
});

test('treats an "error" event on the response as drained', async () => {
  const res = new EventEmitter();
  res.writes = [];
  res.write = (chunk) => { res.writes.push(chunk); return true; };
  res.end = () => {}; // Simulate a socket that will never flush…
  setImmediate(() => res.emit('error', new Error('socket reset')));

  const result = await broadcastShutdown({
    connections: [res],
    reason: 'SIGTERM',
    hardTimeoutMs: 500,
  });
  assert.equal(result.drained, 1);
  assert.equal(result.timedOut, false);
});
