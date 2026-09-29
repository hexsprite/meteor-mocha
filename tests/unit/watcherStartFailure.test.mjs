import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { detectWatcherStartFailure, startupPollResult, readLogSince } = require('../../package/bin/test-run');

test('detects a failed FSEvents watcher from the daemon log', () => {
  const log = 'Building...\nFailed to start watcher for /tmp/packages/rspack: [Error: Error starting FSEvents stream]\n';
  assert.match(detectWatcherStartFailure(log), /Failed to start watcher/);
});

test('ignores a clean boot log', () => {
  assert.equal(detectWatcherStartFailure('Building...\nServer started\n'), null);
});

test('detects a standalone FSEvents stream error', () => {
  assert.match(detectWatcherStartFailure('Error starting FSEvents stream\n'), /FSEvents/);
});

test('only the current startup attempt can report a watcher failure', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-start-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logFile = join(dir, 'daemon.log');
  const oldLog = 'Failed to start watcher for /old/path\n';
  writeFileSync(logFile, oldLog);
  const offset = Buffer.byteLength(oldLog);
  appendFileSync(logFile, 'Server started\n');
  assert.equal(detectWatcherStartFailure(readLogSince(logFile, offset)), null);
});

test('watcher failure wins over a ready health response in the startup poll', () => {
  const watcherFailure = detectWatcherStartFailure('Failed to start watcher for /tmp/packages/rspack: [Error: Error starting FSEvents stream]');
  assert.equal(startupPollResult({ watcherFailure, processAlive: true, healthReady: true }), 'watcher-failed');
  assert.equal(startupPollResult({ watcherFailure: null, processAlive: true, healthReady: true }), 'ready');
});
