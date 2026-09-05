// Unit tests for the test-run daemon-start lock file (fo-754ok).
//
// Regression target: stale-lock cleanup logged unconditionally to stdout, so
// `./scripts/test-run --json` piped into jq (as the pre-push hook does) died
// as invalid JSON whenever the lock happened to be stale — an otherwise green
// run reported as broken.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// lockFile binds to process.cwd() at module load, so chdir into an isolated
// tmpdir BEFORE requiring the bin. Safe here: node --test runs each file in
// its own process.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-run-lock-'));
process.chdir(tmp);

const require = createRequire(import.meta.url);
const { acquireLock } = require('../../package/bin/test-run');

const lockFile = path.join(tmp, '.meteor', 'local', 'test-daemon.lock');

function writeLock(timestamp, pid) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ timestamp, pid }));
}

test('no lock file: acquires silently on both streams', (t) => {
  const log = t.mock.method(console, 'log');
  const error = t.mock.method(console, 'error');

  assert.equal(acquireLock(), true);

  assert.equal(log.mock.callCount(), 0);
  assert.equal(error.mock.callCount(), 0);
});

test('fresh lock held by a live process: refuses, silently', (t) => {
  const log = t.mock.method(console, 'log');
  const error = t.mock.method(console, 'error');
  writeLock(Date.now(), process.pid); // this test process is definitely alive

  assert.equal(acquireLock(), false);

  assert.equal(log.mock.callCount(), 0);
  assert.equal(error.mock.callCount(), 0);
});

test('stale lock (age): recovers, cleanup message goes to stderr not stdout', (t) => {
  const log = t.mock.method(console, 'log');
  const error = t.mock.method(console, 'error');
  writeLock(Date.now() - 999999, process.pid); // older than LOCK_STALE_MS

  assert.equal(acquireLock(), true);

  assert.equal(log.mock.callCount(), 0, 'stale-lock diagnostic must not reach stdout');
  assert.equal(error.mock.callCount(), 1);
  assert.match(error.mock.calls[0].arguments[0], /stale lock/i);
});

test('stale lock (dead pid): recovers, cleanup message goes to stderr not stdout', (t) => {
  const log = t.mock.method(console, 'log');
  const error = t.mock.method(console, 'error');
  // A pid essentially guaranteed not to exist on a Linux CI box.
  writeLock(Date.now(), 999999);

  assert.equal(acquireLock(), true);

  assert.equal(log.mock.callCount(), 0, 'stale-lock diagnostic must not reach stdout');
  assert.equal(error.mock.callCount(), 1);
});
