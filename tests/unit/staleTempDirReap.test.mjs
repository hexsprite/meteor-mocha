// Unit tests for fo-fxz1c: reaping orphaned meteor-test-run* temp dirs on
// daemon startup, and stopDaemon actually verifying termination instead of
// assuming it. Every killed daemon orphaned a ~300MB build dir under the OS
// tmpdir with nothing to reap it (24 dirs / 5GB measured in one session), and
// `daemon stop` printed "Daemon stopped" while 8 children stayed alive,
// holding the port through the next cold start.
//
// Both are stubbed rather than exercised against a real daemon or a real
// tmpdir, matching the precedent in the parent repo's
// scripts/stopStaleDaemon.test.ts: a process table (or here, a fake
// filesystem / fake process-liveness check) is cheap and repeatable, a real
// spawned daemon is not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { reapStaleTempDirs, waitForTermination } = require('../../package/bin/test-run');

function fakeFs(files) {
  const removed = [];
  return {
    removed,
    readdirSync: () => Object.keys(files),
    statSync: (p) => {
      const name = p.split('/').pop();
      if (!(name in files)) throw new Error('ENOENT');
      return { mtime: new Date(files[name]) };
    },
    rmSync: (p) => {
      removed.push(p);
    },
  };
}

test('reapStaleTempDirs removes only meteor-test-run* dirs older than the threshold', () => {
  const now = 1_000_000;
  const maxAgeMs = 10_000;
  const fsImpl = fakeFs({
    'meteor-test-runOLD123': now - maxAgeMs - 1,
    'meteor-test-runFRESH456': now - 1,
    'some-other-tool-dir': now - maxAgeMs - 1,
  });

  const reaped = reapStaleTempDirs({
    tmpDir: '/tmp',
    maxAgeMs,
    now: () => now,
    fsImpl,
    quiet: true,
  });

  assert.deepEqual(reaped, ['/tmp/meteor-test-runOLD123']);
  assert.deepEqual(fsImpl.removed, ['/tmp/meteor-test-runOLD123']);
});

test('reapStaleTempDirs keeps dirs newer than the threshold and non-matching dirs', () => {
  const now = 1_000_000;
  const maxAgeMs = 10_000;
  const fsImpl = fakeFs({
    'meteor-test-runFRESH': now - 1,
    'unrelated-dir': now - maxAgeMs - 1,
  });

  const reaped = reapStaleTempDirs({
    tmpDir: '/tmp',
    maxAgeMs,
    now: () => now,
    fsImpl,
    quiet: true,
  });

  assert.deepEqual(reaped, []);
  assert.deepEqual(fsImpl.removed, []);
});

test('waitForTermination reports success once the pid dies and the port clears', async () => {
  let aliveCalls = 0;
  let boundCalls = 0;
  const result = await waitForTermination({
    pid: 123,
    pollMs: 1,
    timeoutMs: 10,
    isAlive: () => {
      aliveCalls++;
      return aliveCalls < 3; // dies on the 3rd check
    },
    portBoundPids: () => {
      boundCalls++;
      return boundCalls < 2 ? [123] : []; // clears on the 2nd check
    },
    sleep: () => Promise.resolve(),
  });

  assert.equal(result.stopped, true);
  assert.deepEqual(result.alivePids, []);
});

test('waitForTermination reports the still-alive pids when nothing dies within the timeout', async () => {
  const result = await waitForTermination({
    pid: 123,
    pollMs: 1,
    timeoutMs: 5,
    isAlive: () => true,
    portBoundPids: () => [123, 456],
    sleep: () => Promise.resolve(),
  });

  assert.equal(result.stopped, false);
  assert.deepEqual(result.alivePids, [123, 456]);
});
