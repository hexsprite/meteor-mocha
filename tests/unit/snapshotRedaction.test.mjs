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
const commands = [
  '101 /usr/bin/bash -c export FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----"',
  '102 /usr/bin/node /worktree/meteor/main.js ENCRYPTION_KEY=sk_fake tail',
  '103 /usr/bin/bash -c export CONFIG=ordinary\nexport STRIPE_WEBHOOK_SECRET=whsec_fake\nexport SLACK_STATS_WEBHOOK_URL=https://hooks.slack.com/fake',
  '104 /usr/bin/node /worktree/meteor/main.js',
  '105 /usr/bin/node /worktree/rspack/bin.js serve',
  '106 /usr/bin/mongod --dbpath /worktree/.meteor/local/db',
];
const forbidden = /-----BEGIN|sk_|whsec_|hooks\.slack\.com/;

test('truncates the complete process entry at its first assignment', () => {
  for (const command of commands.slice(0, 3)) {
    const result = redactProcessEntry(command);
    assert.equal(result, command.slice(0, command.indexOf('=') + 1) + '[redacted]');
    assert.doesNotMatch(result, forbidden);
  }
});

test('preserves pid, executable, subcommand and worktree without assignments', () => {
  for (const command of commands.slice(3)) assert.equal(redactProcessEntry(command), command);
});

test('redacts assignment shapes without secret-name knowledge', () => {
  for (const value of ['alpha beta', '"prefix whsec_fake"', '$(printf "whsec_fake")', '\n101 whsec_fake']) {
    assert.equal(redactProcessEntry(`123 /bin/bash -c export "UNNAMED=${value}`),
      '123 /bin/bash -c export "UNNAMED=[redacted]');
  }
  assert.equal(redactProcessEntry('123 /bin/bash -c echo ok\nexport NEW_NAME=whsec_fake'),
    '123 /bin/bash -c echo ok\nexport NEW_NAME=[redacted]');
  assert.doesNotMatch(redactProcessEntry.toString(), /FIREBASE|ENCRYPTION|STRIPE|SLACK/);
});

function captureLog({ failedPid, pids = commands.map(line => line.split(' ')[0]).join('\n') } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'snapshot-redaction-'));
  mkdirSync(join(directory, '.meteor/local'), { recursive: true });
  const calls = [];
  const childProcess = {
    execSync: command => {
      if (command.includes('pgrep')) return Buffer.from(commands.join('\n'));
      return Buffer.from('');
    },
    execFileSync: (file, args) => {
      calls.push([file, args]);
      if (file === 'pgrep') return pids;
      assert.equal(file, 'ps');
      assert.deepEqual(Array.from(args).slice(0, 1), ['-p']);
      assert.deepEqual(Array.from(args).slice(2), ['-ww', '-o', 'args=']);
      if (args[1] === failedPid) throw new Error('whsec_fake from failed process probe');
      return commands.find(line => line.startsWith(`${args[1]} `)).replace(/^\d+ /, '') + '\n';
    },
  };
  const context = {
    require: name => name === 'child_process' ? childProcess : require(name),
    module: { exports: {} },
    process: { env: {}, cwd: () => directory, removeAllListeners: () => {}, stderr: { write: () => {} } },
    console,
    Buffer,
  };
  try {
    runInNewContext(source + `\nlogDaemonEvent('startup-abandoned', {
      snapshot: captureDiagnosticSnapshot('crash', null)
    }, { quiet: true });`, context);
    const log = readFileSync(join(directory, '.meteor/local/test-daemon.log'), 'utf8');
    return { log, entries: JSON.parse(log.replace('[daemon-event] ', '')).snapshot.meteor_procs, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('crash log redacts each whole process before handling multiline text', () => {
  const { log, entries, calls } = captureLog();
  assert.doesNotMatch(log, forbidden);
  assert.deepEqual(entries, commands.map(redactProcessEntry));
  assert.equal(calls.filter(([file]) => file === 'ps').length, commands.length);
});

test('a disappeared process is omitted without losing remaining diagnostics', () => {
  const { log, entries } = captureLog({ failedPid: '102' });
  assert.doesNotMatch(log, forbidden);
  assert.deepEqual(entries, commands.filter(line => !line.startsWith('102 ')).map(redactProcessEntry));
});

test('only numeric process IDs reach ps and collection remains bounded', () => {
  const { calls } = captureLog({ pids: ['bad whsec_fake', ...Array(25).fill('104')].join('\n') });
  assert.equal(calls.filter(([file]) => file === 'ps').length, 20);
});
