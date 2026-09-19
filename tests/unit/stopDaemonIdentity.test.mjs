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
// The fix has two tiers. A port holder is authoritative: trust the pidfile
// PID only when it IS the port holder, veto it the instant a different pid
// holds the port. With NO port holder at all (a crashed daemon whose
// listener already dropped, or nothing running), absence of a port holder
// is absence of evidence, not evidence of identity — an earlier version of
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

test('predicate: pidfile PID among the port holders is trusted regardless of command line', () => {
  assert.equal(pidfileIdentityVerified(4242, [111, 4242], null), true);
});

test('predicate: a DIFFERENT pid holding the port vetoes the pidfile PID regardless of command line', () => {
  assert.equal(pidfileIdentityVerified(4242, [111], 'npm run test:daemon'), false);
});

test('predicate: no port holder, command line looks like the daemon — trusted', () => {
  assert.equal(pidfileIdentityVerified(4242, [], 'npm run test:daemon'), true);
});

test('predicate: no port holder, command line does not look like the daemon — vetoed', () => {
  assert.equal(pidfileIdentityVerified(4242, [], 'node some-unrelated-script.js'), false);
});

test('predicate: no port holder, command line unreadable (null) — vetoed, not trusted by default', () => {
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

test('wiring: verified pidfile PID (matches the port) is group-signalled and cleared', async (t) => {
  const killGroup = t.mock.fn();
  const killPid = t.mock.fn();
  const clearPidFile = t.mock.fn();
  const getCommandLine = t.mock.fn(() => 'npm run test:daemon');

  await stopDaemon(true, {
    readPidFile: () => 4242,
    isRunning: () => true,
    getPortHolders: () => [4242],
    getCommandLine,
    killGroup,
    killPid,
    clearPidFile,
  });

  assert.equal(killGroup.mock.callCount(), 1);
  assert.equal(killGroup.mock.calls[0].arguments[0], 4242);
  assert.equal(killPid.mock.callCount(), 0, 'must not also signal individually');
  assert.equal(clearPidFile.mock.callCount(), 1);
  assert.equal(getCommandLine.mock.callCount(), 0, 'a matched port holder never needs a command-line check');
});

test('wiring: a reused pidfile PID is never group-signalled; the real port holder is killed instead', async (t) => {
  const killGroup = t.mock.fn();
  const killPid = t.mock.fn();
  const clearPidFile = t.mock.fn();

  await stopDaemon(true, {
    readPidFile: () => 4242, // reused pid, unrelated to the daemon
    isRunning: () => true,
    getPortHolders: () => [777], // the real daemon
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
