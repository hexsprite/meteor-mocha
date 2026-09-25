// Unit tests for stopDaemon's PID-reuse guard (fo-pi0kl).
//
// pidfileIdentityVerified and looksLikeDaemonProcess prove the decisions are
// right in isolation. They do not prove stopDaemon actually consults them
// before group-signalling — a direct-call test on either predicate stays
// green even if the `if (pidfileIdentityVerified(...))` check is deleted
// from stopDaemon (the exact wiring gap this repo has been bitten by
// before). The "wiring" tests below drive stopDaemon itself with injected
// fakes and assert on what those fakes observed, so a failure there means
// the wiring is broken, not just a predicate.
//
// Background: .meteor/local/test-daemon.pid is not self-identifying — see
// stop-stale-daemon.sh in the parent repo — and the kernel reuses PIDs.
// stopDaemon used to trust "pidfile says N, N is alive" and then
// process-group-signal N. restartDeadWatcherIfNeeded now calls stopDaemon
// automatically, with no human confirming intent, so a reused pidfile PID
// could signal an unrelated process group.
//
// The fix has two tiers. A port LISTENER is authoritative, but a raw pid
// match is the wrong comparison: startDaemon spawns the pidfile pid
// (`npm run test:daemon`) with `detached: true`, so it becomes a process
// group leader, and the process that actually binds the port is its
// grandchild — a DIFFERENT pid that never appears in the pidfile. Confirmed
// live: pidfile pid 22175, listener pid 22237, three levels apart in the
// same process tree, both sharing pgid 22175. A raw-pid identity check
// (`portHolderPids.includes(pidfilePid)`) is false for every healthy daemon,
// by construction — the "verified" branch was unreachable, so stopDaemon
// ALWAYS fell to the unverified fallback below, which SIGTERMs each port
// holder individually rather than by group. Worse: the old lookup
// (`lsof -ti:<port>`, no `-sTCP:LISTEN`) also matched CLIENT sockets on that
// port, and this harness's own test-runner process is one — its
// health()/fileMap() helpers fetch the daemon in-process. That let the
// "unverifiable, kill every port holder" fallback SIGTERM the test runner
// itself mid-suite (fo-pi0kl: the observed `signal: 'SIGTERM'` file-level
// failure, no assertion, no test name — the process died, not a test).
//
// The fix: compare process GROUPS, not pids. `getPortHolderPids` now scopes
// to `-sTCP:LISTEN` so a client socket is never even a candidate. Trust the
// pidfile pid only when some listener shares its pgid — true for a real
// daemon's own descendants, false for an unrelated client or a
// kernel-recycled pid. With NO listener at all (a crashed daemon whose
// listener already dropped, or nothing running), absence of a listener is
// absence of evidence, not evidence of identity — an earlier version of
// this fix trusted the pidfile PID blindly in that case, which is exactly
// the scenario stop-stale-daemon.sh says is the common one (no daemon
// running, a leftover pidfile, PID recycled onto someone else's process).
// The fallback there is the pidfile PID's own command line: it must look
// like `npm run test:daemon` (per startDaemon's spawn call) or it is never
// trusted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stopDaemon, pidfileIdentityVerified, looksLikeDaemonProcess } = require('../../package/bin/test-run');

test('predicate: a listener sharing the pidfile pid\'s process group is trusted regardless of command line', () => {
  // The real shape: pidfile pid is the group leader (its own pgid), the
  // listener is some other pid but inherits that same pgid.
  assert.equal(pidfileIdentityVerified(4242, [9999, 4242], null), true);
});

test('predicate: a listener in a DIFFERENT process group vetoes the pidfile pid regardless of command line', () => {
  assert.equal(pidfileIdentityVerified(4242, [111], 'npm run test:daemon'), false);
});

test('predicate: the pidfile pid itself as a listener group id (own pgid) is trusted', () => {
  // startDaemon's spawn makes the pidfile pid its own group leader, so its
  // pgid literally equals its pid when nothing renumbers it.
  assert.equal(pidfileIdentityVerified(4242, [4242], null), true);
});

test('predicate: pidfile group id unknown (ps failed) vetoes even with a listener present', () => {
  assert.equal(pidfileIdentityVerified(null, [4242], 'npm run test:daemon'), false);
});

test('predicate: no listener, command line looks like the daemon — trusted', () => {
  assert.equal(pidfileIdentityVerified(4242, [], 'npm run test:daemon'), true);
});

test('predicate: no listener, command line does not look like the daemon — vetoed', () => {
  assert.equal(pidfileIdentityVerified(4242, [], 'node some-unrelated-script.js'), false);
});

test('predicate: no listener, command line unreadable (null) — vetoed, not trusted by default', () => {
  assert.equal(pidfileIdentityVerified(4242, [], null), false);
});

test('looksLikeDaemonProcess: matches the npm script name', () => {
  assert.equal(looksLikeDaemonProcess('npm run test:daemon'), true);
});

test('looksLikeDaemonProcess: a bare unrelated command does not match', () => {
  assert.equal(looksLikeDaemonProcess('node server.js'), false);
});

test('looksLikeDaemonProcess: null (ps failed / pid already gone) does not match', () => {
  assert.equal(looksLikeDaemonProcess(null), false);
});

test('wiring: a listener sharing the pidfile pid\'s group is group-signalled and cleared', async (t) => {
  const killGroup = t.mock.fn();
  const killPid = t.mock.fn();
  const clearPidFile = t.mock.fn();
  const getCommandLine = t.mock.fn(() => 'npm run test:daemon');
  // pidfile pid is the group leader; the listener is a different pid in the
  // same family and inherits its pgid — a raw pid match would miss this.
  const getGroupId = (pid) => (pid === 4242 || pid === 5555 ? 4242 : null);

  await stopDaemon(true, {
    readPidFile: () => 4242,
    isRunning: () => true,
    getPortHolders: () => [5555],
    getCommandLine,
    getGroupId,
    killGroup,
    killPid,
    clearPidFile,
  });

  assert.equal(killGroup.mock.callCount(), 1);
  assert.equal(killGroup.mock.calls[0].arguments[0], 4242, 'group-signals the PIDFILE pid, which IS the group leader');
  assert.equal(killPid.mock.callCount(), 0, 'must not also signal individually');
  assert.equal(clearPidFile.mock.callCount(), 1);
  assert.equal(getCommandLine.mock.callCount(), 0, 'a matched listener never needs a command-line check');
});

test('wiring: the exact observed shape — pidfile 22175, listener 22237, same pgid — verifies and group-signals', async (t) => {
  // The live shape this bug was diagnosed against: `npm run test:daemon`
  // (pidfile pid, detached group leader) execs down to a grandchild that
  // actually binds the port. Both share the leader's pgid.
  const killGroup = t.mock.fn();
  const killPid = t.mock.fn();
  const clearPidFile = t.mock.fn();
  const getGroupId = (pid) => (pid === 22175 || pid === 22237 ? 22175 : null);

  await stopDaemon(true, {
    readPidFile: () => 22175,
    isRunning: () => true,
    getPortHolders: () => [22237],
    getGroupId,
    killGroup,
    killPid,
    clearPidFile,
  });

  assert.equal(killGroup.mock.callCount(), 1);
  assert.equal(killGroup.mock.calls[0].arguments[0], 22175);
  assert.equal(killPid.mock.callCount(), 0);
  assert.equal(clearPidFile.mock.callCount(), 1);
});

test('wiring: same pid shape (22175/22237) but a DIFFERENT pgid must never be signalled', async (t) => {
  // Negative of the above: the listener exists, but it belongs to some
  // unrelated process tree — a kernel-recycled pidfile pid, or a coincidence
  // of pid numbering. Must fall to the single-pid kill of the real listener,
  // never a group signal on the pidfile pid.
  const killGroup = t.mock.fn();
  const killPid = t.mock.fn();
  const clearPidFile = t.mock.fn();
  const getGroupId = (pid) => (pid === 22175 ? 9999 : pid === 22237 ? 22237 : null);

  await stopDaemon(true, {
    readPidFile: () => 22175,
    isRunning: () => true,
    getPortHolders: () => [22237],
    getGroupId,
    killGroup,
    killPid,
    clearPidFile,
  });

  assert.equal(killGroup.mock.callCount(), 0, 'the pidfile pid must never be process-group-signalled');
  assert.equal(killPid.mock.callCount(), 1);
  assert.equal(killPid.mock.calls[0].arguments[0], 22237);
  assert.equal(clearPidFile.mock.callCount(), 1);
});

test('wiring: a reused pidfile PID is never group-signalled; the real listener is killed instead', async (t) => {
  const killGroup = t.mock.fn();
  const killPid = t.mock.fn();
  const clearPidFile = t.mock.fn();
  const getGroupId = (pid) => (pid === 4242 ? 9999 : pid === 777 ? 777 : null);

  await stopDaemon(true, {
    readPidFile: () => 4242, // reused pid, unrelated to the daemon
    isRunning: () => true,
    getPortHolders: () => [777], // the real daemon's listener
    getGroupId,
    killGroup,
    killPid,
    clearPidFile,
  });

  assert.equal(killGroup.mock.callCount(), 0, 'the pidfile PID must never be process-group-signalled');
  assert.equal(killPid.mock.callCount(), 1);
  assert.equal(killPid.mock.calls[0].arguments[0], 777);
  assert.equal(clearPidFile.mock.callCount(), 1);
});

test('wiring: a released port with a genuinely dead pidfile PID reports nothing running', async (t) => {
  const killGroup = t.mock.fn();
  const killPid = t.mock.fn();
  const clearPidFile = t.mock.fn();

  await stopDaemon(true, {
    readPidFile: () => null,
    isRunning: () => false,
    getPortHolders: () => [],
    killGroup,
    killPid,
    clearPidFile,
  });

  assert.equal(killGroup.mock.callCount(), 0);
  assert.equal(killPid.mock.callCount(), 0);
  assert.equal(clearPidFile.mock.callCount(), 0);
});

test('wiring: no port holder but a matching command line is still trusted and stopped', async (t) => {
  const killGroup = t.mock.fn();
  const killPid = t.mock.fn();
  const clearPidFile = t.mock.fn();

  await stopDaemon(true, {
    readPidFile: () => 4242,
    isRunning: () => true,
    getPortHolders: () => [], // crashed daemon: listener already dropped
    getCommandLine: () => 'npm run test:daemon',
    killGroup,
    killPid,
    clearPidFile,
  });

  assert.equal(killGroup.mock.callCount(), 1);
  assert.equal(killGroup.mock.calls[0].arguments[0], 4242);
  assert.equal(clearPidFile.mock.callCount(), 1);
});

test('wiring: no port holder and a NON-matching command line is never group-signalled — the exact PID-reuse gap', async (t) => {
  // This is the scenario stop-stale-daemon.sh says is the common one, not
  // the edge case: no daemon running, a leftover pidfile, its PID recycled
  // by the kernel onto some unrelated process. Blindly trusting "empty
  // portHolderPids" here was the hole in the first version of this fix.
  const killGroup = t.mock.fn();
  const killPid = t.mock.fn();
  const clearPidFile = t.mock.fn();

  await stopDaemon(true, {
    readPidFile: () => 4242, // recycled pid — some stranger's process
    isRunning: () => true,
    getPortHolders: () => [],
    getCommandLine: () => 'some-unrelated-long-running-process --flag',
    killGroup,
    killPid,
    clearPidFile,
  });

  assert.equal(killGroup.mock.callCount(), 0, 'an unverifiable PID must never be process-group-signalled');
  assert.equal(killPid.mock.callCount(), 0, 'there is no port holder to kill instead');
  assert.equal(clearPidFile.mock.callCount(), 1, 'the stale pidfile is cleared so it stops being retried');
});
