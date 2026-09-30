# GBrain's Postgres driver

`postgres/` is the exact published `postgres@3.4.9` package from
https://github.com/porsager/postgres, with GBrain's checked-in
`patches/postgres@3.4.9.patch` applied. The package is **Unlicense**, not MIT;
the original upstream license is preserved in `postgres/UNLICENSE` (the npm
tarball omits this file, so the updater retrieves and verifies it separately).
Original package metadata and attribution are retained.

The registry's latest supported release was inspected on 2026-09-27 and was
still 3.4.9. Its stock reserved and transaction owners do not implement the
`discard()` capability needed by GBrain's cancellation fence. No version
upgrade or opaque third-party fork is being substituted for that capability.

## Why source is shipped

The root package-private `#postgres` import maps directly into this directory.
Every driver import resolves through this one package import. Bun and
Node ESM use `src/`; CommonJS uses `cjs/src/`; compiled Bun artifacts embed
those same resolved source bytes. The workerd export receives the identical
ESM patch, preserving its upstream polyfill imports. GBrain itself does not
support a workerd runtime.

This deliberately avoids Bun's transitive `file:` dependency resolution, which
can report a successful packed installation while leaving the driver absent.
The patched bytes are part of GBrain's checkout and package, not a
`patchedDependencies` instruction that a global install may ignore. No
postinstall mutation of another package's node_modules is needed. The patch
file remains the auditable source of the delta, not an installation hook.

The patch adds abort-aware reservation, reserved/transaction-owner discard,
CancelRequest settlement tracking and ownership/pipeline fences. Cancellation
must settle or retire the connection before another query can own it. This
is necessary for worker admission, query timeout and lease-release safety.
See issues #5466 and #5560 and `test/e2e/persistence-chaos.test.ts`.

## Reproduce and update

Run `bash vendor/update-postgres.sh --check` to download the pinned upstream
tarball, verify SHA-512, apply the checked-in patch to every published runtime
export, verify the upstream license and compare every byte. Run without
`--check` to regenerate `postgres/`. This does not read a brain or alter any
installed service. No driver dependency installation is required after regeneration.

For security updates, the GBrain release maintainer owns this dependency:
review upstream security advisories and supported releases, update the exact
version/URLs/hashes here and in the updater, rebase the patch against pristine
upstream source, regenerate, then review the entire diff. Never edit only an
installed node_modules copy. Do not suppress the runtime capability guard.

Before retiring this vendor, prove the candidate upstream release passes the
same runtime reserved-owner check, interrupted reservation and in-query
cancellation tests, successor-query fence tests, real Postgres and
transaction-mode PgBouncer tests, and fresh/upgrade/packed/GitHub-global and
compiled distribution smokes. An ordinary unsignalled SELECT or matching
version is not evidence of safe cancellation. Publish the distribution and
platform results, including any unavailable target, before changing the
dependency back to the registry.

## Isolated install smoke

With a disposable test-shaped database, run:

```sh
GBRAIN_TEST_ALLOW_DATABASE_URL=1 GBRAIN_TEST_PACKAGE_SMOKE=1 \
  DATABASE_URL="$DISPOSABLE_TEST_DATABASE_URL" \
  bun test test/e2e/postgres-driver-install.test.ts
```

This uses isolated HOME/cache/install directories, no paid providers, and
tests a checkout, actual packed installation, global tarball installation,
an independently installed stock-driver negative fixture, a stale stock
module alongside the new installation, and a Linux compiled job fixture.
Each positive runtime validates readiness and cancellation, then completes a
harmless minion job. The macOS ARM64 fixture is cross-compiled, not run; native
macOS execution is a separate platform acceptance gate. To test a published
GitHub revision's global installation instead of the local global tarball,
also set `GBRAIN_TEST_GITHUB_PACKAGE=github:garrytan/gbrain#<published-sha>`.
Do not claim GitHub transport validation before that revision is available.
