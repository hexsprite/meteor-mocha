// Unit tests for the fo-u728l half of the staleness guard.
//
// Regression target (fo-u728l): the daemon could report a confident, green
// result for server code that was never in the bundle it ran. Two independent
// holes produced that:
//
//   1. ensureDaemonFresh returned `{ stale: false }` immediately unless a file
//      pattern was given, so only `-f`/path-targeted runs were ever guarded.
//      `test-run Billing`, `test-run -t foo` and bare full runs — the documented
//      everyday invocations — bypassed the guard completely. Proven end to end:
//      with an unconditional `throw` injected into lib/dateparse.ts and the
//      daemon's rspack watcher wedged, `-f imports/utils/parsePin.app-spec.ts`
//      correctly reported stale while `-t parsePin` reported 2 passes.
//
//   2. The daemon's `builtAt` is `Date.now()` at module scope, i.e. when the
//      server process BOOTED, not when its bundle was compiled. A restart that
//      re-executes the same stale bundle refreshes builtAt, so comparing source
//      mtimes against it says "fresh" about code compiled before the edit.
//
// computeEffectiveBuiltAt closes (2) by folding in the emitted bundle's own
// mtime. isFreshnessRelevantSourceFile keeps the guard from firing on files a
// rebuild can never be triggered by, so closing (1) doesn't buy false alarms.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  computeEffectiveBuiltAt,
  isFreshnessRelevantSourceFile,
  getBundleMtime,
  getProjectMtime,
} = require('../../package/bin/test-run');

test('falls back to builtAt when no bundle mtime is available', () => {
  // Non-rspack app, or an unknown build context: 0 means "no signal". Inventing
  // staleness from a missing file would break every consumer of this fork.
  assert.equal(computeEffectiveBuiltAt({ builtAt: 5000, bundleMtime: 0 }), 5000);
});

test('THE BUG: a restart that re-runs a stale bundle cannot refresh freshness', () => {
  // builtAt jumped to now because Meteor rebooted the server; the bundle on
  // disk was last written long before. The running code is the old bundle, so
  // the honest freshness is the bundle's mtime, not the boot time.
  assert.equal(computeEffectiveBuiltAt({ builtAt: 9000, bundleMtime: 2000 }), 2000);
});

test('a bundle written after boot is not yet loaded, so boot time still governs', () => {
  // rspack emitted a fresh bundle but Meteor has not restarted onto it. The
  // process is still executing the older bundle it booted with.
  assert.equal(computeEffectiveBuiltAt({ builtAt: 4000, bundleMtime: 7000 }), 4000);
});

test('.d.ts files are excluded from the freshness basis', () => {
  // path.extname('foo.d.ts') is '.ts', so a naive extension check folds ambient
  // declarations in. Nothing rebuilds for them, so the guard would wait out the
  // full stale budget and then cry wedged on a healthy daemon.
  assert.equal(isFreshnessRelevantSourceFile('revenuecatApiTypes.d.ts'), false);
  assert.equal(isFreshnessRelevantSourceFile('create.ts'), true);
  assert.equal(isFreshnessRelevantSourceFile('Component.tsx'), true);
  assert.equal(isFreshnessRelevantSourceFile('legacy.js'), true);
  assert.equal(isFreshnessRelevantSourceFile('README.md'), false);
});

test('getProjectMtime ignores a .d.ts that is newer than every real source', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-u728l-'));
  fs.mkdirSync(path.join(cwd, 'imports'));
  fs.writeFileSync(path.join(cwd, 'imports', 'real.ts'), 'export const a = 1\n');
  fs.utimesSync(path.join(cwd, 'imports', 'real.ts'), 1000, 1000);
  fs.writeFileSync(path.join(cwd, 'imports', 'types.d.ts'), 'declare const b: number\n');
  fs.utimesSync(path.join(cwd, 'imports', 'types.d.ts'), 9000, 9000);

  return getProjectMtime(cwd, ['imports']).then((mtime) => {
    assert.equal(mtime, 1000 * 1000);
  });
});

test('getBundleMtime takes the newest server bundle across build modes', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-u728l-'));
  const ctx = path.join(cwd, '_build-daemon');
  for (const [mode, when] of [['test', 3000], ['test-main-dev', 5000]]) {
    fs.mkdirSync(path.join(ctx, mode), { recursive: true });
    const file = path.join(ctx, mode, 'server-rspack.js');
    fs.writeFileSync(file, '// bundle\n');
    fs.utimesSync(file, when, when);
  }
  assert.equal(getBundleMtime(cwd, '_build-daemon'), 5000 * 1000);
});

test('getBundleMtime reports no signal when the build context is absent', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-u728l-'));
  assert.equal(getBundleMtime(cwd, '_build-daemon'), 0);
});
