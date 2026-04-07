# UPSTREAM — Fork discipline for `focuster-daemon`

This repo is a fork of [`Meteor-Community-Packages/meteor-mocha`](https://github.com/Meteor-Community-Packages/meteor-mocha).
The `focuster-daemon` branch carries focuster's test daemon work — long-running
test infrastructure that turns Meteor's test runner into a hot-reloadable
service. Without these notes the fork rots.

## Where this lives

- Origin (our fork): `https://github.com/hexsprite/meteor-mocha.git`
- Upstream: `https://github.com/Meteor-Community-Packages/meteor-mocha.git`
- Default working branch: `focuster-daemon`
- Consumed by [focuster](https://github.com/hexsprite/focuster) as a git
  submodule pinned to an explicit SHA. **No floating branch tracking.** Bumps
  in the parent repo happen via `./scripts/bump-mocha.sh`.

## Change footprint vs upstream `master`

The daemon work touches **only 4 files**:

| File | Lines | Nature |
|---|---|---|
| `package/bin/test-run` | +1857 | New file — CLI client |
| `package/docs/TEST_DAEMON.md` | +247 | New file — docs |
| `package/server.js` | +486 | Daemon mode hooks (the only invasive change) |
| `package/server.handleCoverage.js` | ±12 | Small error reporting tweak |

`bin/test-run` and `docs/TEST_DAEMON.md` are pure additions and would extract
cleanly into a standalone add-on package. The interesting (and harder) work
is in `server.js`, where the daemon needs:

1. To wrap `global.describe` *before* test files load (file-to-suite tracking).
2. To call `mochaInstance.cleanReferencesAfterRun(false)` on the private
   Mocha instance.
3. To mount HTTP/SSE handlers via `WebApp.connectHandlers` and reach into
   Mocha internals (`mochaInstance.run()`, `suite.reset()`) for each on-demand
   run.

None of these can be done from a separate Meteor package without first
exposing extension points in upstream. So for now: **the fork stays a fork.**

## The graduation plan

When the daemon work stabilizes (no more weekly fixes), split it into two
upstream contributions:

1. **PR #1: "Expose hooks for runner extensions"** — surgical change to
   upstream `server.js` adding:
   - An exported `mochaInstance` getter
   - A documented `before-tests-load` hook
   - A reset/lifecycle hook for daemon-style runner reuse

   This is the kind of PR upstream maintainers actually merge: small,
   additive, doesn't change defaults.

2. **Standalone add-on package: `meteor-mocha-daemon`** — once #1 lands,
   lift the daemon code into a package that *depends on* `meteortesting:mocha`
   and uses the new hooks. `bin/test-run` and `docs/TEST_DAEMON.md` move
   wholesale; the `server.js` changes get refactored to consume hooks instead
   of monkey-patching.

Until then, stay on `focuster-daemon` and rebase, never merge.

## Rebase discipline

> **Never merge upstream `master` into `focuster-daemon`. Always rebase.**

Why: when the day comes to upstream the daemon, we want a clean linear stack
of feature commits on top of upstream `master`, not a tangled merge graph.
Rebasing keeps each daemon commit cherry-pickable and PR-ready.

Workflow when upstream moves:

```bash
git fetch upstream
git rebase upstream/master
# resolve conflicts (rare — change footprint is small)
git push --force-with-lease origin focuster-daemon
```

After force-pushing, bump focuster:

```bash
cd ../..   # back to focuster repo root
./scripts/bump-mocha.sh
```

## Bumping in the parent repo

`focuster` pins this submodule to a specific SHA. To pull the latest
`focuster-daemon` into focuster:

```bash
./scripts/bump-mocha.sh
```

That script:
- Refuses to run if the submodule has uncommitted changes
- Fetches `origin/focuster-daemon`
- Hard-resets the submodule to the latest commit
- Stages the bump and writes a clean commit message in focuster

Pass `--no-commit` if you want to inspect before committing.

## Don't do these things

- ❌ Don't merge `upstream/master` into `focuster-daemon` — rebase instead
- ❌ Don't add a `branch =` line to `.gitmodules` in focuster — pin the SHA
- ❌ Don't squash daemon commits — keep them feature-named so the eventual
  upstream PR is reviewable
- ❌ Don't develop daemon features in focuster's working tree directly —
  do them in this submodule, commit here, then bump focuster
