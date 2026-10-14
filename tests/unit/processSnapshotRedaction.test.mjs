import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { redactProcessEntry } = require('../../package/bin/test-run');
const source = readFileSync(new URL('../../package/bin/test-run', import.meta.url), 'utf8');
// Synthetic sentinels only: diagnostics tests must never inspect machine argv.
const entries = [
  '107 /usr/bin/mongosh mongodb://user:SYNTHETIC_URI_PASSWORD@host/db',
  '108 /usr/bin/mongosh mongodb+srv://user:SYNTHETIC_SRV_PASSWORD@host/db',
  '109 /usr/bin/node /worktree/meteor/main.js --token SYNTHETIC_FLAG_TOKEN --verbose',
  '110 /usr/bin/bash -c node /worktree/rspack/main.js --access-token "SYNTHETIC_QUOTED_TOKEN with spaces"',
  '111 /usr/bin/node /worktree/meteor/main.js --config \'{"user":"operator@example.test","token":"SYNTHETIC_JSON_TOKEN"}\'',
  '112 /usr/bin/node /worktree/meteor/main.js --config \'{"nested":{"password":"SYNTHETIC_JSON_PASSWORD"}}\'',
  '113 /usr/bin/bash -c node /worktree/meteor/main.js --config "{\\"accessToken\\":\\"SYNTHETIC_ESCAPED_TOKEN\\"}"',
  '114 /usr/bin/bash -c node /worktree/meteor/main.js\n--token SYNTHETIC_MULTILINE_TOKEN',
  '115 /usr/bin/node /worktree/meteor/main.js NEW_ENV=SYNTHETIC_ASSIGNMENT_SECRET',
  '120 /usr/bin/bash -c meteor "--password" SYNTHETIC_QUOTED_PASSWORD',
  "121 /usr/bin/bash -c meteor --'to'ken SYNTHETIC_QUOTED_FLAG",
  '122 /usr/bin/node /worktree/meteor/main.js --config \'{"pass\\u0077ord":"SYNTHETIC_UNICODE_KEY"}\'',
  '123 /usr/bin/node /worktree/meteor/main.js --config \'{"url":"mongodb:\\/\\/user:SYNTHETIC_JSON_URI@host/db"}\'',
  '124 /usr/bin/node /worktree/meteor/main.js --config \'{"MONGO_PASSWORD":"SYNTHETIC_PREFIX_KEY"}\'',
  '125 /usr/bin/node /worktree/meteor/main.js --config \'{"SecretAccessKey":"SYNTHETIC_SECRET_KEY"}\'',
];
const controls = [
  '116 /usr/bin/node /worktree/meteor/main.js --email operator@example.test --verbose',
  '117 /usr/bin/mongod --dbpath /worktree/.meteor/local/db',
  '118 /usr/bin/node /worktree/rspack/main.js --config \'{"mode":"development","port":3000}\'',
  '119 /usr/bin/mongosh mongodb://host/db',
  '126 /usr/bin/node /worktree/meteor/main.js --token-count 512 --config \'{"tokenCount":512,"passwordPolicy":"strong","port":3000}\'',
];

for (const entry of entries) {
  test(`redacts non-assignment credentials for fixture PID ${entry.split(' ')[0]}`, () => {
    const result = redactProcessEntry(entry);
    assert.ok(!result.includes('SYNTHETIC_'), 'synthetic credential must be absent');
    assert.ok(result.startsWith(entry.split(' ').slice(0, 2).join(' ')), 'PID and executable survive');
    assert.ok(result.includes('[redacted]'), 'redaction remains explicit');
  });
}

test('preserves benign arguments, worktree identity and standalone emails', () => {
  for (const entry of controls) assert.equal(redactProcessEntry(entry), entry);
  assert.ok(redactProcessEntry(entries[4]).includes('operator@example.test'));
  assert.ok(redactProcessEntry(entries[2]).includes('/worktree/meteor/main.js'));
});

test('snapshot logging redacts stubbed process arguments before writing diagnostics', () => {
  const directory = mkdtempSync(join(tmpdir(), 'snapshot-credentials-'));
  mkdirSync(join(directory, '.meteor/local'), { recursive: true });
  const fixtures = [...entries, ...controls];
  const childProcess = {
    execSync: () => Buffer.from(''),
    execFileSync: (file, args) => {
      if (file === 'pgrep') return fixtures.map(entry => entry.split(' ')[0]).join('\n');
      assert.equal(file, 'ps');
      assert.deepEqual(Array.from(args).slice(2), ['-ww', '-o', 'args=']);
      const entry = fixtures.find(value => value.startsWith(`${args[1]} `));
      assert.ok(entry, 'collector can only access synthetic fixture PIDs');
      return entry.replace(/^\d+ /, '') + '\n';
    },
  };
  try {
    runInNewContext(source + `\nlogDaemonEvent('startup-abandoned', {
      snapshot: captureDiagnosticSnapshot('crash', null)
    }, { quiet: true });`, {
      require: name => name === 'child_process' ? childProcess : require(name),
      module: { exports: {} },
      process: { env: {}, cwd: () => directory, removeAllListeners: () => {}, stderr: { write: () => {} } },
      console,
      Buffer,
    });
    const log = readFileSync(join(directory, '.meteor/local/test-daemon.log'), 'utf8');
    assert.ok(!log.includes('SYNTHETIC_'), 'snapshot must contain no synthetic credential');
    const snapshot = JSON.parse(log.replace('[daemon-event] ', '')).snapshot;
    assert.deepEqual(snapshot.meteor_procs, fixtures.map(redactProcessEntry));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
