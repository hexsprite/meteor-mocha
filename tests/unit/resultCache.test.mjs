// Unit tests for the client result cache (fo-jw0z4).
//
// Regression target: fo-zdpf0 replaced the mtime-scan staleness guard with
// build stamps and deleted getProjectMtime, but checkCache/saveCache still
// called it — every completed run died with a ReferenceError mid-stream,
// truncating --json output. The cache is now keyed to the server build
// stamps' builtAt: valid for exactly the bundle that produced the result,
// invalidated by a rebuild, and never populated or hit when no stamp exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// cacheFile binds to process.cwd() at module load, so chdir into an isolated
// tmpdir BEFORE requiring the bin. Safe here: node --test runs each file in
// its own process.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-run-cache-'));
process.chdir(tmp);

const require = createRequire(import.meta.url);
const { cacheBuildBasis, checkCache, saveCache } = require('../../package/bin/test-run');

const stampDir = path.join(tmp, '_build-daemon', 'test');

function writeStamp(builtAt) {
  fs.mkdirSync(stampDir, { recursive: true });
  fs.writeFileSync(
    path.join(stampDir, '.build-stamp-server.json'),
    JSON.stringify({ builtAt, newestInputMtime: builtAt - 1000, inputCount: 1, inputs: ['imports/x.ts'] })
  );
}

test('no build stamp: saveCache does not throw and checkCache never hits', () => {
  assert.equal(cacheBuildBasis(), null);
  saveCache('out', 0, 0, { ok: true }); // the fo-jw0z4 crash site
  assert.equal(checkCache(), null);
});

test('cached result round-trips while the bundle is unchanged', () => {
  writeStamp(1000);
  saveCache('all green', 0, 0, { stats: { passes: 5 } });
  const hit = checkCache();
  assert.ok(hit, 'expected a cache hit for the same bundle');
  assert.equal(hit.output, 'all green');
  assert.equal(hit.exitCode, 0);
  assert.equal(hit.failures, 0);
  assert.deepEqual(hit.jsonResult, { stats: { passes: 5 } });
});

// fo-bhgu: a flaky/failing run must never be cached. Caching failures meant a
// transient timeout, once cached, kept being replayed as a failure for up to
// CACHE_TTL_MS even after the underlying issue cleared.
test('a failing run (non-zero exitCode) is never cached', () => {
  writeStamp(3000); // basis unique to this test, isolated from the others
  saveCache('boom', 1, 3, { stats: { failures: 3 } });
  assert.equal(checkCache(), null, 'a failed run must not be replayed as a cache hit');
});

// Pullfrog finding on PR #1471: a forced fresh run (--no-cache) exposing a
// failure must invalidate the prior successful entry too, not just decline to
// overwrite it -- otherwise the next ordinary run replays that older success
// as a false green even though the failure was never cached itself.
test('a failure invalidates an existing successful cache entry for the same basis', () => {
  writeStamp(4000); // basis unique to this test, isolated from the others
  saveCache('all green', 0, 0, { stats: { passes: 5 } });
  saveCache('boom', 1, 3, { stats: { failures: 3 } }); // same build basis
  assert.equal(checkCache(), null, 'the stale successful entry must not be replayed');
});

test('a rebuild invalidates the cache', () => {
  writeStamp(1000);
  saveCache('stale soon', 0, 0, null);
  writeStamp(2000); // rebuild: builtAt advances
  assert.equal(checkCache(), null);
});

test('a legacy projectMtime cache entry is treated as stale', () => {
  writeStamp(1000);
  const cacheFile = path.join(tmp, '.meteor', 'local', 'test-cache.json');
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(
    cacheFile,
    JSON.stringify({ lastRun: { timestamp: Date.now(), projectMtime: 999, output: 'old', exitCode: 0, failures: 0, jsonResult: null } })
  );
  assert.equal(checkCache(), null);
});

test('the build basis does not change with directory listing order', () => {
  // readBuildStamps walks the mode directories with readdirSync, which makes
  // no ordering promise. Unsorted, the same bundle set could produce two
  // different basis strings and miss its own cache. Created in reverse order
  // here so a filesystem that returns insertion order (CI is Linux; macOS
  // APFS happens to sort) reproduces it.
  fs.rmSync(path.join(tmp, '_build-daemon'), { recursive: true, force: true });
  for (const mode of ['zzz', 'aaa']) {
    const dir = path.join(tmp, '_build-daemon', mode);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.build-stamp-server.json'),
      JSON.stringify({ builtAt: 1000, newestInputMtime: 0, inputCount: 1, inputs: ['imports/x.ts'] })
    );
  }

  assert.equal(cacheBuildBasis(), 'aaa/server:1000|zzz/server:1000');
});
