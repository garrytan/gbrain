**Dependency scans no longer fail on the picomatch advisory GHSA-fc5q-39xc-vjpf in the admin UI's build tooling, until 2026-12-17.**

### Tests and CI
- `admin/osv-scanner.toml` ignores GHSA-fc5q-39xc-vjpf (a picomatch ReDoS with no fixed version yet) for `admin/bun.lock` only, until 2026-12-17. picomatch reaches the admin UI only through its bundler (vite), with patterns from our own build config, and is not in the CLI or the server. The root lockfile has no ignore.
- OSV-Scanner reads that file for the admin lockfile and stops ignoring the entry after its date. `scripts/ci-dependency-audit.sh` passes the same ids to the admin `bun audit` until then; an entry past its date or without one is reported as `audit_ignore_expired` and the advisory is checked again, which fails a blocking run.
- The advisory-only registry-outage test now has the same time budget as its sibling, so it no longer times out on slower machines.
