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
const { reapStaleTempDirs, waitForTermination, stopDaemon, isDirInUse } = require('../../package/bin/test-run');

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

// lsof's exit code is not the "found something" signal: a `+D` recursive
// scan exits 1 on an unrelated permission-denied subdirectory even when it
// printed real rows for the path actually being asked about — observed live
// against a running daemon's own mongod-held dir. execFileSync throws on
// that nonzero exit, but the thrown error still carries `.stdout`.
test('isDirInUse reads stdout even when the lsof call "fails" (nonzero exit) with real rows', () => {
  const inUse = isDirInUse('/tmp/whatever', {
    execFileSyncImpl: () => {
      const err = new Error('Command failed');
      err.stdout = 'COMMAND PID USER FD TYPE ...\nmongod 1 user 15u REG ...\n';
      throw err;
    },
  });
  assert.equal(inUse, true);
});

test('isDirInUse reads false from a nonzero exit with no rows (nothing has it open)', () => {
  const inUse = isDirInUse('/tmp/whatever', {
    execFileSyncImpl: () => {
      const err = new Error('Command failed');
      err.stdout = '';
      throw err;
    },
  });
  assert.equal(inUse, false);
});

// pullfrog round 2 on PR #1510: a probe that could not COMPLETE (missing
// binary, timeout) must not read the same as one that completed and found
// nothing — the prior version mapped both to "unused," which could delete a
// directory the probe never actually got to check.
test('isDirInUse fails closed (reports in-use) when the lsof binary is missing', () => {
  const inUse = isDirInUse('/tmp/whatever', {
    execFileSyncImpl: () => {
      const err = new Error('spawn lsof ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
  });
  assert.equal(inUse, true);
});

test('isDirInUse fails closed (reports in-use) when the lsof call times out', () => {
  const inUse = isDirInUse('/tmp/whatever', {
    execFileSyncImpl: () => {
      const err = new Error('Command timed out');
      err.signal = 'SIGTERM';
      throw err;
    },
  });
  assert.equal(inUse, true);
});

test('reapStaleTempDirs leaves a stale-by-age dir alone when a live process still has it open', () => {
  // A daemon in another worktree can sit idle (no test runs) for longer than
  // maxAgeMs while still owning its dir — age alone must not authorize
  // deletion (pullfrog finding on PR #1510).
  const now = 1_000_000;
  const maxAgeMs = 10_000;
  const fsImpl = fakeFs({
    'meteor-test-runLIVE': now - maxAgeMs - 1,
    'meteor-test-runDEAD': now - maxAgeMs - 1,
  });

  const reaped = reapStaleTempDirs({
    tmpDir: '/tmp',
    maxAgeMs,
    now: () => now,
    fsImpl,
    isInUse: (p) => p.endsWith('LIVE'),
    quiet: true,
  });

  assert.deepEqual(reaped, ['/tmp/meteor-test-runDEAD']);
  assert.deepEqual(fsImpl.removed, ['/tmp/meteor-test-runDEAD']);
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

// pullfrog finding on PR #1510: stopDaemon computed a stopped/failed result
// but discarded it, so `daemon stop` always exited 0 and `daemon restart`
// would start a replacement even when the prior process was confirmed still
// alive. Both branches (tracked pid, and the port-based fallback) are
// covered via full dependency injection — no real process involved.
test('stopDaemon returns true when the tracked pid is confirmed stopped', async () => {
  const stopped = await stopDaemon(true, {
    readPid: () => 999,
    isProcessRunning: () => true,
    terminateProcess: () => {},
    removePid: () => {},
    waitForTermination: async () => ({ stopped: true, alivePids: [] }),
  });
  assert.equal(stopped, true);
});

test('stopDaemon returns false when the tracked pid is still alive after the timeout', async () => {
  const stopped = await stopDaemon(true, {
    readPid: () => 999,
    isProcessRunning: () => true,
    terminateProcess: () => {},
    removePid: () => {},
    waitForTermination: async () => ({ stopped: false, alivePids: [999] }),
  });
  assert.equal(stopped, false);
});

test('stopDaemon (port fallback path) returns false when killed pids do not clear', async () => {
  const stopped = await stopDaemon(true, {
    readPid: () => null,
    isProcessRunning: () => false,
    removePid: () => {},
    execSync: () => '4242\n',
    waitForTermination: async () => ({ stopped: false, alivePids: [4242] }),
  });
  assert.equal(stopped, false);
});
