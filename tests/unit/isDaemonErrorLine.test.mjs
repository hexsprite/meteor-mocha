// Unit tests for the daemon startup log-line classifier.
//
// Regression target: isDaemonErrorLine matched the bare substring 'Error'
// against every daemon log line, so macOS's
// 'Failed to start watcher for <path>: [Error: Error starting FSEvents
// stream]' warning scored as a crash even though the daemon keeps running
// and rebuilds normally. Under load this burned all three startup retries
// and reported daemon_crashed for a daemon that was never down (fo-a3v67).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isDaemonErrorLine } = require('../../package/bin/test-run');

test('does not classify the macOS FSEvents watcher warning as a crash', () => {
  assert.equal(
    isDaemonErrorLine(
      "Failed to start watcher for /foo/bar: [Error: Error starting FSEvents stream]",
    ),
    false,
  );
});

test('still classifies a genuine crash line as an error', () => {
  assert.equal(isDaemonErrorLine('FATAL ERROR: heap out of memory'), true);
});

test('still classifies "Running two copies of Meteor" as an error', () => {
  assert.equal(isDaemonErrorLine('Running two copies of Meteor in the same application directory'), true);
});

test('still classifies a plain uncaught Error line as an error', () => {
  assert.equal(isDaemonErrorLine('Error: something unrelated broke'), true);
});
