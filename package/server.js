/* global Package */
import { mochaInstance } from 'meteor/meteortesting:mocha-core';
import { startBrowser } from 'meteor/meteortesting:browser-tests';
import { onMessage } from 'meteor/inter-process-messaging';
import { WebApp } from 'meteor/webapp';
import { MongoInternals } from 'meteor/mongo';

import fs from 'node:fs';

import setArgs from './runtimeArgs';
import handleCoverage from './server.handleCoverage';

let mochaOptions;
let runnerOptions;
let coverageOptions;
let grep;
let invert;
let clientReporter;
let serverReporter;
let serverOutput;
let clientOutput;

// File-to-suite tracking: capture source file for each describe() call
// This must happen BEFORE test files are loaded (at module scope)
const suiteToFile = new WeakMap();

/**
 * Normalize a file path to be relative to project root
 * Strips leading slashes and ensures forward slashes
 */
function normalizePath(filepath) {
  if (!filepath) return filepath;
  // Remove leading slash if present
  let normalized = filepath.replace(/^\/+/, '');
  // Ensure forward slashes (Windows compat)
  normalized = normalized.replace(/\\/g, '/');
  return normalized;
}

/**
 * Reset all collections after test run to prevent inter-run pollution
 * Generic approach using MongoInternals - no app-specific dependencies
 */
async function resetAllCollections() {
  const db = MongoInternals.defaultRemoteCollectionDriver().mongo.db;
  const collections = await db.listCollections().toArray();

  for (const { name } of collections) {
    // Skip system collections
    if (name.startsWith('system.')) continue;
    await db.collection(name).deleteMany({});
  }
}

function getCallerFile() {
  const stack = new Error().stack || '';

  // Match any test file pattern in any folder:
  // - imports/.../foo.app-spec.ts
  // - server/.../foo.app-test.ts
  // - tests/foo.spec.ts
  // Stack format: "at module (imports/api/foo.app-spec.js:11:1)"
  // Capture: path between ( and : that ends with test pattern
  const moduleMatch = stack.match(/\(([^)\s]+\.(app-spec|app-test|spec|test)\.[tj]s):/);
  if (moduleMatch) {
    return normalizePath(moduleMatch[1]);
  }

  return undefined;
}

// Wrap global describe to capture file info
if (typeof global.describe === 'function') {
  const originalDescribe = global.describe;

  global.describe = function(title, fn) {
    const suite = originalDescribe(title, fn);
    if (suite && !suiteToFile.has(suite)) {
      const file = getCallerFile();
      if (file) {
        suiteToFile.set(suite, file);
        suite.file = file; // Also set on suite for easier access
      }
    }
    return suite;
  };

  // Preserve describe.only and describe.skip
  global.describe.only = function(title, fn) {
    const suite = originalDescribe.only(title, fn);
    if (suite && !suiteToFile.has(suite)) {
      const file = getCallerFile();
      if (file) {
        suiteToFile.set(suite, file);
        suite.file = file;
      }
    }
    return suite;
  };

  global.describe.skip = originalDescribe.skip;
}

// Daemon mode: allow multiple test runs without recreating the Mocha instance
const isDaemonMode = !!process.env.TEST_DAEMON;
if (isDaemonMode) {
  // Use Mocha's method API to set options properly
  mochaInstance.cleanReferencesAfterRun(false);
}

if (Package['browser-policy-common'] && Package['browser-policy-content']) {
  const { BrowserPolicy } = Package['browser-policy-common'];

  // Allow the remote mocha.css file to be inserted, in case any CSP stuff
  // exists for the domain.
  BrowserPolicy.content.allowInlineStyles();
  BrowserPolicy.content.allowStyleOrigin('https://cdn.rawgit.com');
}

// Since intermingling client and server log lines would be confusing,
// the idea here is to buffer all client logs until server tests have
// finished running and then dump the buffer to the screen and continue
// logging in real time after that if client tests are still running.

let serverTestsDone = false;
let clientTestsRunning = false;
const clientLines = [];

function clientLogBuffer(line) {
  if (serverTestsDone) {
    // printing and removing the extra new-line character. The first was added by the client log, the second here.
    console.log(line);
  } else {
    clientLines.push(line);
  }
}

function printHeader(type) {
  const lines = [
    '\n--------------------------------',
    Meteor.isAppTest
      ? `--- RUNNING APP ${type} TESTS ---`
      : `----- RUNNING ${type} TESTS -----`,
    '--------------------------------\n',
  ];
  for (const line of lines) {
    if (type === 'CLIENT') {
      clientLogBuffer(line);
    } else {
      console.log(line);
    }
  }
}

let callCount = 0;
let clientFailures = 0;
let serverFailures = 0;

function exitIfDone(type, failures) {
  callCount++;
  if (type === 'client') {
    clientFailures = failures;
  } else {
    serverFailures = failures;
    serverTestsDone = true;
    clientLines.forEach(console.log);
  }

  if (callCount === 2) {
    // We only need to show this final summary if we ran both kinds of tests in the same console
    if (
      runnerOptions.runServer &&
      runnerOptions.runClient &&
      runnerOptions.browserDriver
    ) {
      console.log('All tests finished!\n');
      console.log('--------------------------------');
      console.log(
        `${Meteor.isAppTest ? 'APP ' : ''}SERVER FAILURES: ${serverFailures}`,
      );
      console.log(
        `${Meteor.isAppTest ? 'APP ' : ''}CLIENT FAILURES: ${clientFailures}`,
      );
      console.log('--------------------------------');
    }

    handleCoverage(coverageOptions).then(() => {
      // if no env for TEST_WATCH, tests should exit when done
      if (!runnerOptions.testWatch) {
        if (clientFailures + serverFailures > 0) {
          process.exit(1); // exit with non-zero status if there were failures
        } else {
          process.exit(0);
        }
      }
    });
  }
}

function serverTests(cb) {
  if (!runnerOptions.runServer) {
    console.log('SKIPPING SERVER TESTS BECAUSE TEST_SERVER=0');
    exitIfDone('server', 0);
    if (cb) cb();
    return;
  }

  printHeader('SERVER');

  if (grep) mochaInstance.grep(grep);
  if (invert) mochaInstance.invert(invert);
  mochaInstance.color(true);

  // We need to set the reporter when the tests actually run to ensure no conflicts with
  // other test driver packages that may be added to the app but are not actually being
  // used on this run.
  mochaInstance.reporter(serverReporter || 'spec', {
    output: serverOutput,
  });

  mochaInstance.run((failureCount) => {
    if (typeof failureCount !== 'number') {
      console.log(
        'Mocha did not return a failure count for server tests as expected',
      );
      exitIfDone('server', 1);
    } else {
      exitIfDone('server', failureCount);
    }
    if (cb) cb();
  });
}

function isXunitLine(line) {
  return line.trimLeft().startsWith('<');
}

function browserOutput(data) {
  // Take full control over line breaks to prevent duplication
  const line = data.toString().replace(/\n$/, '');
  if (clientOutput) {
    // Edge case: with XUNIT reporter write only XML to the output file
    if (clientReporter !== 'xunit' || isXunitLine(line)) {
      fs.appendFileSync(clientOutput, `${line}\n`);
    } else {
      // Output non-XML lines to console (XUNIT reporter only)
      clientLogBuffer(line);
    }
  } else {
    clientLogBuffer(line);
  }
}

function clientTests() {
  if (clientTestsRunning) {
    console.log('CLIENT TESTS ALREADY RUNNING');
    return;
  }

  if (!runnerOptions.runClient) {
    console.log('SKIPPING CLIENT TESTS BECAUSE TEST_CLIENT=0');
    exitIfDone('client', 0);
    return;
  }

  if (!runnerOptions.browserDriver) {
    console.log(
      'Load the app in a browser to run client tests, or set the TEST_BROWSER_DRIVER environment variable. ' +
        'See https://github.com/meteortesting/meteor-mocha/blob/master/README.md#run-app-tests',
    );
    exitIfDone('client', 0);
    return;
  }

  printHeader('CLIENT');
  clientTestsRunning = true;

  startBrowser({
    stdout: browserOutput,
    writebuffer: browserOutput,
    stderr: browserOutput,
    done(failureCount) {
      clientTestsRunning = false;
      if (typeof failureCount !== 'number') {
        console.log(
          'The browser driver package did not return a failure count for server tests as expected',
        );
        exitIfDone('client', 1);
      } else {
        exitIfDone('client', failureCount);
      }
    },
  });
}

// Daemon mode: run tests on-demand via HTTP instead of at startup
let daemonTestsRunning = false;
let clientDisconnected = false;
let shuttingDown = false;

// Track active SSE connections for graceful shutdown
const activeConnections = new Set();

// Graceful shutdown: notify all connected clients before server restarts
function setupShutdownHandlers() {
  const shutdown = (signal) => {
    if (shuttingDown) return; // Prevent double-handling
    shuttingDown = true;
    console.log(`[daemon] Received ${signal}, notifying clients...`);

    // Notify all active SSE connections
    for (const res of activeConnections) {
      try {
        res.write(`data: ${JSON.stringify({ type: 'shutdown', reason: signal })}\n\n`);
        res.end();
      } catch (e) {
        // Connection may already be closed
      }
    }
    activeConnections.clear();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

function runDaemonTests(grepPattern, invert, res, options = {}) {
  if (daemonTestsRunning) {
    res.write(`data: ${JSON.stringify({ type: 'error', data: 'Tests already running - wait or restart daemon' })}\n\n`);
    res.end();
    return;
  }

  // Reject new test runs if shutting down
  if (shuttingDown) {
    res.write(`data: ${JSON.stringify({ type: 'shutdown', reason: 'Server is shutting down' })}\n\n`);
    res.end();
    return;
  }

  daemonTestsRunning = true;
  clientDisconnected = false;

  // Track this connection for graceful shutdown
  activeConnections.add(res);

  // Set snapshot update mode if requested (for snapshot testing)
  const previousSnapshotUpdate = process.env.SNAPSHOT_UPDATE;
  if (options.snapshotUpdate) {
    process.env.SNAPSHOT_UPDATE = '1';
  }

  // Handle client disconnect - reset flag so new clients can run
  res.on('close', () => {
    if (daemonTestsRunning) {
      console.log('[daemon] Client disconnected while tests running');
      clientDisconnected = true;
      // Note: Tests keep running but we track disconnect for cleanup
    }
  });

  // Reset test states so previously-run tests can run again
  // Uses Mocha's built-in reset() which properly clears:
  // - test state, pending, timedOut, err, _currentRetry
  // - all hooks (beforeEach, afterEach, beforeAll, afterAll)
  mochaInstance.suite.reset();

  // Set grep pattern for this run
  // Mocha.grep() converts string to RegExp internally
  mochaInstance.grep(grepPattern || ''); // Empty string matches all

  // Set invert flag - Mocha's invert() takes no args, it just sets to true
  // So we need to set options.invert directly
  mochaInstance.options.invert = invert;

  // Set bail mode if requested (stop on first failure)
  if (options.bail) {
    mochaInstance.bail(true);
  } else {
    mochaInstance.bail(false); // Reset for next run
  }

  // Use JSON reporter if requested, otherwise default to spec
  const useJsonReporter = options.reporter === 'json';
  mochaInstance.color(!useJsonReporter); // No ANSI colors in JSON mode
  mochaInstance.reporter(useJsonReporter ? 'json' : (serverReporter || 'spec'), {
    output: serverOutput,
  });

  // Capture all output (console + process.stdout/stderr) and stream via SSE
  // Mocha's reporter writes directly to process.stdout, not console.log
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  // Buffer for JSON reporter output (collected and sent at end)
  let jsonBuffer = '';

  const sendLog = (data) => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'log', data })}\n\n`);
    } catch (e) {
      // Connection closed
    }
  };

  const sendError = (data) => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', data })}\n\n`);
    } catch (e) {
      // Connection closed
    }
  };

  process.stdout.write = (chunk, encoding, callback) => {
    const str = chunk.toString();
    if (useJsonReporter) {
      // Collect JSON output instead of streaming
      jsonBuffer += str;
    } else {
      sendLog(str.replace(/\n$/, '')); // Remove trailing newline
    }
    return originalStdoutWrite(chunk, encoding, callback);
  };

  process.stderr.write = (chunk, encoding, callback) => {
    const str = chunk.toString();
    sendError(str.replace(/\n$/, ''));
    return originalStderrWrite(chunk, encoding, callback);
  };

  console.log = (...args) => {
    const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    originalLog.apply(console, args);
  };

  console.error = (...args) => {
    const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    originalError.apply(console, args);
  };

  // Skip header in JSON mode to keep output clean
  if (!useJsonReporter) {
    printHeader('SERVER');
  }

  // Send heartbeat every 10s so client knows we're alive even if tests produce no output
  const heartbeat = setInterval(() => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
    } catch (e) {
      clearInterval(heartbeat);
    }
  }, 10000);

  mochaInstance.run(async (failureCount) => {
    clearInterval(heartbeat);

    // Reset all collections after tests complete to prevent inter-run pollution
    try {
      await resetAllCollections();
    } catch (e) {
      console.error('[daemon] Failed to reset collections:', e.message);
    }

    // Restore all output handlers
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    console.log = originalLog;
    console.error = originalError;

    // Restore SNAPSHOT_UPDATE env var
    if (previousSnapshotUpdate !== undefined) {
      process.env.SNAPSHOT_UPDATE = previousSnapshotUpdate;
    } else {
      delete process.env.SNAPSHOT_UPDATE;
    }

    daemonTestsRunning = false;
    activeConnections.delete(res);

    if (clientDisconnected) {
      console.log(`[daemon] Tests completed (${failureCount} failures) but client already disconnected`);
    } else {
      try {
        // Send JSON reporter output if using JSON mode
        if (useJsonReporter && jsonBuffer) {
          res.write(`data: ${JSON.stringify({ type: 'json', data: jsonBuffer.trim() })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ type: 'done', failures: failureCount })}\n\n`);
        res.end();
      } catch (e) {
        // Connection closed
      }
    }
  });
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a map of file paths to suite titles
 */
function buildFileMap() {
  const fileMap = {};

  function walkSuites(suite, parentFile) {
    const file = suite.file || parentFile;
    if (file && suite.title) {
      if (!fileMap[file]) {
        fileMap[file] = [];
      }
      fileMap[file].push(suite.fullTitle());
    }
    if (suite.suites) {
      suite.suites.forEach(child => walkSuites(child, file));
    }
  }

  walkSuites(mochaInstance.suite, undefined);
  return fileMap;
}

/**
 * Check if pattern matches file path using whole path element matching.
 * Pattern segments must match complete path segments in the file.
 * e.g., "abc" matches "abc/def/file.ts" but not "abcd/file.ts"
 * e.g., "abc/def" matches "abc/def/file.ts" but not "abc/defg/file.ts"
 */
function pathMatchesPattern(filePath, pattern) {
  // Remove trailing slashes and split into segments
  const fileSegments = filePath.replace(/\/+$/, '').split('/');
  const patternSegments = pattern.replace(/\/+$/, '').split('/');

  // Pattern must have fewer or equal segments to match
  if (patternSegments.length > fileSegments.length) {
    return false;
  }

  // Look for pattern as a contiguous sequence anywhere in file path
  for (let start = 0; start <= fileSegments.length - patternSegments.length; start++) {
    let matches = true;
    for (let i = 0; i < patternSegments.length; i++) {
      if (fileSegments[start + i] !== patternSegments[i]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return true;
    }
  }

  return false;
}

/**
 * Find all suite titles that match a file pattern
 * Both input pattern and stored paths are normalized for consistent matching
 * Pattern matching uses whole path elements (not substring)
 */
function findSuitesForFile(filePattern) {
  const normalizedPattern = normalizePath(filePattern);
  const fileSuites = [];

  function findSuites(suite, parentFile) {
    const file = suite.file || parentFile;
    if (file) {
      const normalizedFile = normalizePath(file);
      if (pathMatchesPattern(normalizedFile, normalizedPattern) && suite.title) {
        fileSuites.push(escapeRegex(suite.fullTitle()));
      }
    }
    if (suite.suites) {
      suite.suites.forEach(child => findSuites(child, file));
    }
  }

  findSuites(mochaInstance.suite, undefined);
  return fileSuites;
}

function setupDaemonEndpoints() {
  // Set up graceful shutdown handlers
  setupShutdownHandlers();

  // Health check endpoint
  WebApp.handlers.use('/test/health', (req, res) => {
    const suiteCount = mochaInstance.suite.suites.length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: shuttingDown ? 'shutting_down' : 'ready',
      suites: suiteCount,
      running: daemonTestsRunning,
    }));
  });

  // File-to-suite mapping endpoint
  WebApp.handlers.use('/test/files', (req, res) => {
    const fileMap = buildFileMap();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(fileMap, null, 2));
  });

  // Run tests endpoint (SSE streaming)
  WebApp.handlers.use('/test/run', (req, res) => {
    // Parse query params
    const url = new URL(req.url, `http://${req.headers.host}`);
    const grepPattern = url.searchParams.get('grep') || '';
    const filePattern = url.searchParams.get('file') || '';
    const invert = url.searchParams.get('invert') === '1';
    const reporter = url.searchParams.get('reporter') || 'spec';
    const snapshotUpdate = url.searchParams.get('snapshotUpdate') === '1';
    const bail = url.searchParams.get('bail') === '1';

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // If file specified, convert to grep pattern
    let effectiveGrep = grepPattern;
    let description = grepPattern || 'all tests';

    if (filePattern) {
      const fileSuites = findSuitesForFile(filePattern);

      if (fileSuites.length === 0) {
        res.write(`data: ${JSON.stringify({ type: 'error', data: `No tests found for file: ${filePattern}` })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', failures: 1 })}\n\n`);
        res.end();
        return;
      }

      // Build regex that matches any of the suite titles
      const fileGrep = `^(${fileSuites.join('|')})`;

      // Combine with existing grep if present
      if (grepPattern) {
        effectiveGrep = `(?=${fileGrep})(?=.*${grepPattern})`;
      } else {
        effectiveGrep = fileGrep;
      }

      // Use filename for description
      const filename = filePattern.split('/').pop();
      description = grepPattern ? `${filename} (${grepPattern})` : filename;
    }

    res.write(`data: ${JSON.stringify({ type: 'start', grep: description, invert })}\n\n`);

    runDaemonTests(effectiveGrep, invert, res, { reporter, snapshotUpdate, bail });
  });

  console.log('\n========================================');
  console.log('  TEST DAEMON READY');
  console.log('  Health: http://localhost:9100/test/health');
  console.log('  Files:  http://localhost:9100/test/files');
  console.log('  Run:    ./scripts/test-run [grep|file]');
  console.log('========================================\n');
}

// Before Meteor calls the `start` function, app tests will be parsed and loaded by Mocha
function start() {
  const args = setArgs();
  runnerOptions = args.runnerOptions;
  coverageOptions = args.coverageOptions;
  mochaOptions = args.mochaOptions;
  grep = mochaOptions.grep;
  invert = mochaOptions.invert;
  clientReporter = mochaOptions.clientReporter;
  serverReporter = mochaOptions.serverReporter;
  serverOutput = mochaOptions.serverOutput;
  clientOutput = mochaOptions.clientOutput;

  // In daemon mode, don't run tests at startup - wait for HTTP requests
  if (isDaemonMode) {
    setupDaemonEndpoints();
    return;
  }

  // Run in PARALLEL or SERIES
  // Running in series is a better default since it avoids db and state conflicts for newbs.
  // If you want parallel you will know these risks.
  if (runnerOptions.runParallel) {
    console.log(
      'Warning: Running in parallel can cause side-effects from state/db sharing',
    );

    serverTests();
    clientTests();
  } else {
    serverTests(() => {
      clientTests();
    });
  }
}

export { start };

onMessage('client-refresh', (options) => {
  console.log(
    'CLIENT TESTS RESTARTING (client-refresh)',
    options === undefined ? '' : options,
  );
  clientTests();
});

onMessage('webapp-reload-client', (options) => {
  console.log(
    'CLIENT TESTS RESTARTING (webapp-reload-client)',
    options === undefined ? '' : options,
  );
  clientTests();
});
