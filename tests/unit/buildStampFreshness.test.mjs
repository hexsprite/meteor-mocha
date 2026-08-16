// Unit tests for the build-stamp freshness guard (fo-zdpf0).
//
// Regression target: the guard used to reconstruct rspack's watch set from a
// hand-written list of source roots and extensions. Any drift gave a wrong
// answer in both directions — a false "wedged" that blocked pushes for two
// minutes at a time, and the silent opposite where a stale suite ran and
// reported green. The build now reports the input set it actually compiled,
// and these tests pin the contract that reads it: stale means an input is
// newer than what the compiler saw, an input has been deleted, or the named
// target predates every build. Absence of a stamp is 'unknown', never fresh.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyStampFreshness,
  evaluateStamps,
  hashDirTree,
  readBuildStamps,
  scanStampInputs,
  describeStaleness,
} = require('../../package/bin/test-run');

const stampOf = (newestInputMtime, inputs = [], absent = []) => ({
  builtAt: newestInputMtime + 1000,
  newestInputMtime,
  inputCount: inputs.length,
  inputs,
  absent,
});

test('fresh when no recorded input is newer than what the compiler saw', () => {
  assert.deepEqual(
    classifyStampFreshness({ stamp: stampOf(1000), newestOnDisk: 1000 }),
    { stale: false },
  );
});

test('stale when a recorded input was edited after the build read it', () => {
  const verdict = classifyStampFreshness({ stamp: stampOf(1000), newestOnDisk: 1500 });
  assert.equal(verdict.stale, true);
  assert.equal(verdict.mtimeMs, 1500);
});

test('stale when a recorded input has been deleted', () => {
  const verdict = classifyStampFreshness({
    stamp: stampOf(1000),
    newestOnDisk: 500,
    missingInput: 'imports/api/gone.ts',
  });
  assert.deepEqual(verdict, { stale: true, deleted: 'imports/api/gone.ts' });
});

test('THE GAP: a named target no build has ever read still reports stale', () => {
  // A brand-new spec is in no input list, so the recorded inputs alone would
  // call this fresh and the daemon would answer "no tests matched".
  const verdict = classifyStampFreshness({
    stamp: stampOf(1000),
    newestOnDisk: 900,
    targetMtime: 1500,
  });
  assert.equal(verdict.stale, true);
  assert.equal(verdict.mtimeMs, 1500);
});

test('THE GAP: a path the build looked for and did not find, that now exists, is stale', () => {
  // A brand-new spec that no run names explicitly. It is in no input list, so
  // only the compiler's record of what it failed to resolve can catch it.
  const verdict = classifyStampFreshness({
    stamp: stampOf(1000),
    newestOnDisk: 900,
    appearedInput: 'imports/api/actions/brandNew.app-spec.ts',
  });
  assert.deepEqual(verdict, {
    stale: true,
    appeared: 'imports/api/actions/brandNew.app-spec.ts',
  });
});

test('evaluateStamps: one stale bundle makes the whole daemon stale', () => {
  const entries = [
    { bundle: 'test/server', state: 'ok', stamp: stampOf(9000) },
    { bundle: 'test/client', state: 'ok', stamp: stampOf(1000) },
  ];
  const verdict = evaluateStamps(entries, 5000);
  assert.equal(verdict.stale, true);
  assert.equal(verdict.bundle, 'test/client');
});

test('evaluateStamps: reports building so the caller waits instead of crying wedged', () => {
  const entries = [{ bundle: 'test/server', state: 'building', stamp: stampOf(1000) }];
  const verdict = evaluateStamps(entries, 5000);
  assert.equal(verdict.stale, true);
  assert.equal(verdict.building, true);
});

test('evaluateStamps: a failed compile is named, not silently waited on', () => {
  const entries = [{ bundle: 'test/server', state: 'failed', stamp: stampOf(1000) }];
  assert.equal(evaluateStamps(entries, 5000).failed, 'test/server');
});

test('evaluateStamps: fresh bundles report no build state to act on', () => {
  const entries = [{ bundle: 'test/server', state: 'ok', stamp: stampOf(9000) }];
  assert.equal(evaluateStamps(entries, 5000).stale, false);
});

test('describeStaleness tells a failed build apart from a wedged watcher', () => {
  const failed = describeStaleness(
    { stale: true, failed: 'test/server', bundle: 'test/server' },
    null,
  );
  assert.match(failed, /FAILED/);
  const wedged = describeStaleness(
    { stale: true, bundle: 'test/server', mtimeMs: 5000, builtAt: 1000 },
    null,
  );
  assert.match(wedged, /wedged/);
});

test('scanStampInputs reads real mtimes and names the first missing input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-scan-'));
  fs.writeFileSync(path.join(dir, 'present.ts'), 'x');
  const { newest, missing } = scanStampInputs(
    { inputs: ['present.ts', 'gone.ts'], absent: [] },
    dir,
  );
  assert.equal(newest, fs.statSync(path.join(dir, 'present.ts')).mtimeMs);
  assert.equal(missing, 'gone.ts');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('THE FALSE WEDGE: a directory whose listing came back is NOT stale', () => {
  // Observed on a live daemon. A probe file created and deleted inside a
  // watched directory moves its mtime, but rspack compares contents and does
  // not rebuild — so an mtime check waits out its budget and reports a wedge
  // on a perfectly healthy daemon. That is the failure this whole bead exists
  // to remove, so it must not be reintroduced by the directory signal.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-dir-'));
  const watched = path.join(dir, 'actions');
  fs.mkdirSync(watched);
  fs.writeFileSync(path.join(watched, 'actions.ts'), 'x');

  const stamp = { inputs: [], dirs: { actions: hashDirTree(watched) } };
  fs.writeFileSync(path.join(watched, 'probe.app-spec.ts'), 'x');
  assert.equal(scanStampInputs(stamp, dir).changedDir, 'actions', 'new file must be seen');
  fs.unlinkSync(path.join(watched, 'probe.app-spec.ts'));
  assert.equal(scanStampInputs(stamp, dir).changedDir, null, 'listing restored, so fresh');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('THE NESTED GAP: a spec added below the watched directory is stale', () => {
  // rspack forwards a context dependency as a RECURSIVE watch, so `imports`
  // stands in for everything beneath it and the stamp records only the
  // outermost directories. Hashing immediate children left a spec two levels
  // down invisible — verified against a live daemon before the fix, where
  // creating imports/api/calendar/probe.app-spec.ts still read fresh.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-nested-'));
  const watched = path.join(dir, 'imports');
  const deep = path.join(watched, 'api', 'calendar');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'calendar.ts'), 'x');

  const stamp = { inputs: [], dirs: { imports: hashDirTree(watched) } };
  assert.equal(scanStampInputs(stamp, dir).changedDir, null);

  fs.writeFileSync(path.join(deep, 'probe.app-spec.ts'), 'x');
  assert.equal(scanStampInputs(stamp, dir).changedDir, 'imports');

  fs.unlinkSync(path.join(deep, 'probe.app-spec.ts'));
  assert.equal(scanStampInputs(stamp, dir).changedDir, null, 'and back to fresh');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a dependency tree under a watched directory is not a source change', () => {
  // `meteor npm install` under a watched root must not read as a stale suite.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-nested-'));
  const watched = path.join(dir, 'packages');
  fs.mkdirSync(watched, { recursive: true });
  fs.writeFileSync(path.join(watched, 'thing.ts'), 'x');

  const stamp = { inputs: [], dirs: { packages: hashDirTree(watched) } };
  fs.mkdirSync(path.join(watched, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(watched, 'node_modules', 'dep', 'index.js'), 'x');
  assert.equal(scanStampInputs(stamp, dir).changedDir, null);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a dotfile appearing does not count as a source change', () => {
  // .DS_Store must not read as a stale suite — rspack would not rebuild for it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-dir-'));
  const watched = path.join(dir, 'actions');
  fs.mkdirSync(watched);
  fs.writeFileSync(path.join(watched, 'actions.ts'), 'x');

  const stamp = { inputs: [], dirs: { actions: hashDirTree(watched) } };
  fs.writeFileSync(path.join(watched, '.DS_Store'), 'x');
  assert.equal(scanStampInputs(stamp, dir).changedDir, null);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a watched directory that vanished is stale', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-dir-'));
  const stamp = { inputs: [], dirs: { gone: 'somehash' } };
  assert.equal(scanStampInputs(stamp, dir).changedDir, 'gone');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scanStampInputs reports an absent path that has since appeared', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-scan-'));
  fs.writeFileSync(path.join(dir, 'arrived.ts'), 'x');
  const still = scanStampInputs({ inputs: [], absent: ['nothere.ts'] }, dir);
  assert.equal(still.appeared, null);
  const now = scanStampInputs({ inputs: [], absent: ['arrived.ts'] }, dir);
  assert.equal(now.appeared, 'arrived.ts');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scanStampInputs tolerates a stamp written before absent was recorded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-scan-'));
  assert.equal(scanStampInputs({ inputs: [] }, dir).appeared, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readBuildStamps returns nothing when the app writes no stamps', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-read-'));
  assert.deepEqual(readBuildStamps(dir, '_build-daemon'), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readBuildStamps pairs each stamp with its compiler state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-read-'));
  const mode = path.join(dir, '_build-daemon', 'test');
  fs.mkdirSync(mode, { recursive: true });
  fs.writeFileSync(
    path.join(mode, '.build-stamp-server.json'),
    JSON.stringify(stampOf(1000, ['imports/a.ts'])),
  );
  fs.writeFileSync(
    path.join(mode, '.build-state-server.json'),
    JSON.stringify({ state: 'building', at: 2000 }),
  );

  const entries = readBuildStamps(dir, '_build-daemon');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].bundle, 'test/server');
  assert.equal(entries[0].state, 'building');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readBuildStamps defaults to ok when only the stamp survived', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-read-'));
  const mode = path.join(dir, '_build-daemon', 'test');
  fs.mkdirSync(mode, { recursive: true });
  fs.writeFileSync(
    path.join(mode, '.build-stamp-server.json'),
    JSON.stringify(stampOf(1000, [])),
  );
  assert.equal(readBuildStamps(dir, '_build-daemon')[0].state, 'ok');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readBuildStamps ignores the client stamp', () => {
  // Tailwind's content glob pulls docs/, .beads/ and .claude/ into the client
  // dependency graph, so honouring it would turn every `bd` write into a stale
  // test suite. The daemon runs server tests, so the server bundle decides.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-read-'));
  const mode = path.join(dir, '_build-daemon', 'test');
  fs.mkdirSync(mode, { recursive: true });
  fs.writeFileSync(
    path.join(mode, '.build-stamp-client.json'),
    JSON.stringify(stampOf(1000, ['docs/README.md'])),
  );
  assert.deepEqual(readBuildStamps(dir, '_build-daemon'), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
