// Unit tests for the daemon spawn's working directory (fo-zj5oj).
//
// Regression target: `startDaemon` spawned `npm run test:daemon` with
// `cwd: process.cwd()`. This file is require()'d in-process by
// scripts/test-run's shim (not exec'd as its own process), so
// process.cwd() is whatever directory the invoking shell sat in — not
// necessarily this worktree's root. The project's own style forbids a
// leading `cd` on shell commands (see AGENTS.md), so an agent invoking
// `scripts/test-run` by absolute path from elsewhere is the documented,
// common case — and it silently rooted the daemon in the wrong checkout.
// Because TEST_PORT is already derived correctly per worktree, the
// wrong-tree daemon still answered on the *right* port, so the run reported
// a clean green against a tree nobody edited (observed 2026-09-17 building
// fo-fqu1t: 7/7 passing turned out to be the unmodified suite on master).
//
// resolveProjectRoot fixes this by deriving the root from this file's own
// location (__dirname) instead of process.cwd() — the same move
// scripts/test-run already makes for TEST_PORT resolution. These tests pin
// two things: the walk-up logic in isolation, and — the wiring gap this
// project has been bitten by before (see stopDaemonIdentity.test.mjs) — that
// the resolution is actually independent of the caller's process.cwd(), not
// just correct when nobody has moved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const TEST_RUN_PATH = require.resolve('../../package/bin/test-run');
const { resolveProjectRoot } = require('../../package/bin/test-run');

test('walks up from a nested startDir to the nearest ancestor with a .meteor directory', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-project-root-'));
  try {
    fs.mkdirSync(path.join(tmpRoot, '.meteor'));
    const nested = path.join(tmpRoot, 'packages', 'meteor-mocha-repo', 'package', 'bin');
    fs.mkdirSync(nested, { recursive: true });

    assert.equal(resolveProjectRoot(nested), tmpRoot);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('returns startDir itself when it already has a .meteor directory (same-directory invocation)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-project-root-'));
  try {
    fs.mkdirSync(path.join(tmpRoot, '.meteor'));
    assert.equal(resolveProjectRoot(tmpRoot), tmpRoot);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('throws instead of silently returning an unresolved directory when no ancestor has .meteor', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-project-root-'));
  try {
    const nested = path.join(tmpRoot, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });

    // A bare tmpdir tree has no .meteor above it, so this must fail loudly —
    // silently falling back to process.cwd() here is exactly the bug fo-zj5oj
    // fixes.
    assert.throws(() => resolveProjectRoot(nested));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('wiring: resolution is independent of the caller process.cwd(), the exact regression shape', () => {
  // Simulates the real bug: an agent invokes the script by absolute path
  // from a shell sitting somewhere else entirely. Run resolveProjectRoot()
  // in a genuinely separate process whose cwd is os.tmpdir(), and confirm it
  // still finds THIS repo's root (the one containing package/bin/test-run),
  // not the tmpdir and not silently something derived from cwd.
  const script = `
    const { resolveProjectRoot } = require(${JSON.stringify(TEST_RUN_PATH)});
    process.stdout.write(resolveProjectRoot());
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
  });

  const expectedRoot = path.resolve(path.dirname(TEST_RUN_PATH), '..', '..', '..', '..');
  assert.equal(out, expectedRoot);
  assert.notEqual(out, os.tmpdir());
});
