// Unit tests for getProjectMtime's source scan.
//
// getProjectMtime is a recursive readdir walk (not fs.promises.glob) so it can
// scan /packages without descending into local packages' installed node_modules
// — a `packages/**` glob would, and a routine `meteor npm install` would then
// bump the freshness basis and spuriously trip the staleness guard. These tests
// pin that contract: the walk finds nested sources across every bundled root,
// skips node_modules/build output, ignores non-source extensions, and doesn't
// throw on absent roots. A regression that reintroduced dependency-tree
// traversal (or dropped a root) fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { getProjectMtime } = require('../../package/bin/test-run');

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projmtime-'));
  const write = (rel, mtimeMs) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '// x');
    const t = mtimeMs / 1000;
    fs.utimesSync(full, t, t);
    return full;
  };
  return { root, write };
}

test('walks nested source files and returns the newest mtime', async () => {
  const { root, write } = makeTree();
  write('imports/a/old.ts', 1_000_000);
  write('common/deep/nested/new.tsx', 5_000_000);
  const latest = await getProjectMtime(root, ['imports', 'common']);
  assert.equal(latest, 5_000_000);
});

test('includes local package sources under packages/', async () => {
  const { root, write } = makeTree();
  write('imports/a.ts', 1_000_000);
  write('packages/my-pkg/lib/thing.js', 4_000_000);
  const latest = await getProjectMtime(root, ['imports', 'packages']);
  assert.equal(latest, 4_000_000);
});

test('skips node_modules and build output (not sources)', async () => {
  const { root, write } = makeTree();
  write('imports/real.ts', 2_000_000);
  // A far-future mtime under a skipped dir must NOT win.
  write('packages/my-pkg/node_modules/dep/index.js', 9_000_000);
  write('imports/dist/bundle.js', 9_000_000);
  const latest = await getProjectMtime(root, ['imports', 'packages']);
  assert.equal(latest, 2_000_000);
});

test('ignores non-source extensions', async () => {
  const { root, write } = makeTree();
  write('imports/code.ts', 3_000_000);
  write('imports/README.md', 8_000_000);
  write('imports/data.json', 8_000_000);
  const latest = await getProjectMtime(root, ['imports']);
  assert.equal(latest, 3_000_000);
});

test('returns 0 when no roots exist (absent /common etc.) — no throw', async () => {
  const { root } = makeTree();
  const latest = await getProjectMtime(root, ['does-not-exist']);
  assert.equal(latest, 0);
});

// Default roots must cover /apps: the app bundles /apps/mobile, /apps/web, and
// /apps/support-agent via explicit imports, so an edit there has to gate
// freshness. Calling with the DEFAULT root list (no second arg) proves apps is
// included, not just reachable when named explicitly.
test('default roots include /apps (mobile/web/support are bundled)', async () => {
  const { root, write } = makeTree();
  write('apps/mobile/startup/index.tsx', 6_000_000);
  const latest = await getProjectMtime(root);
  assert.equal(latest, 6_000_000);
});
