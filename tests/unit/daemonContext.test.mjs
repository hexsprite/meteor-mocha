import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const {
  daemonContextMatches,
  getDaemonContextFingerprint,
  isCacheContextCurrent,
} = require('../../package/bin/test-run');

function makeProject(env = 'ENCRYPTION_KEY=first\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-context-'));
  fs.writeFileSync(path.join(root, '.env.test'), env);
  return root;
}

test('fingerprint changes when .env.test changes', () => {
  const root = makeProject();
  const first = getDaemonContextFingerprint(root);
  fs.writeFileSync(path.join(root, '.env.test'), 'ENCRYPTION_KEY=second\n');
  assert.notEqual(getDaemonContextFingerprint(root), first);
});

test('fingerprint is stable for identical content and missing files', () => {
  const first = makeProject();
  const second = makeProject();
  assert.equal(
    getDaemonContextFingerprint(first),
    getDaemonContextFingerprint(second),
  );

  fs.unlinkSync(path.join(first, '.env.test'));
  fs.unlinkSync(path.join(second, '.env.test'));
  assert.equal(
    getDaemonContextFingerprint(first),
    getDaemonContextFingerprint(second),
  );
});

test('daemon context requires the running daemon fingerprint to match', () => {
  assert.equal(daemonContextMatches('current', 'current'), true);
  assert.equal(daemonContextMatches('old', 'current'), false);
  assert.equal(daemonContextMatches(undefined, 'current'), false);
});

test('cached results are invalid after the environment context changes', () => {
  assert.equal(
    isCacheContextCurrent({ contextFingerprint: 'current' }, 'current'),
    true,
  );
  assert.equal(
    isCacheContextCurrent({ contextFingerprint: 'old' }, 'current'),
    false,
  );
  assert.equal(isCacheContextCurrent({}, 'current'), false);
});
