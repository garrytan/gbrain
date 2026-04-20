# KBrain — Tracked Fork of `garrytan/gbrain`

This document records the Kelai overlay on top of upstream
[`garrytan/gbrain`](https://github.com/garrytan/gbrain). The fork lives at
`<your-gh-owner>/kbrain` (swap in the final GitHub owner before first deploy).
The sole purpose of the fork is supply-chain control:

- Reproducible builds pinned to a commit SHA we own.
- Audit trail on every upstream change (merges land as PRs in the fork).
- Protection against upstream deletion, hijack, or force-push.

We **do not** rename the CLI, the npm package, or internal module paths. The
fork is a downstream-only overlay so upstream merges stay clean.

## Fork conventions

- **Branch protection on `main`:** linear history, no force-push, require PR,
  require status checks once CI lands.
- **Remotes:** `origin = <your-gh-owner>/kbrain`, `upstream = garrytan/gbrain`.
- **Sync cadence:** monthly, or on-demand for security fixes.
- **First commit after fork:** add this `KBRAIN_OVERLAY.md` at the top level of
  the fork recording the initial upstream SHA.
- **Every sync PR:** update the "Last merged upstream SHA" row below.

## Pinning discipline (deployment side)

The deployable service in `hermes-agents/gbrain-mcp/` pins the fork at a
specific commit via:

- `hermes-agents/gbrain-mcp/.kbrain-ref` — the commit SHA to build against. Any
  bump is a reviewable diff in this repo.
- `hermes-agents/gbrain-mcp/Dockerfile` — `ARG KBRAIN_REPO` + `ARG KBRAIN_REF`
  read the repo URL and pinned SHA. Never checkout a branch.
- `GBRAIN_DISABLE_UPGRADE=1` env var + stub `/usr/local/bin/gbrain-upgrade-stub`
  neutralize `gbrain upgrade` inside the container. Pins only ever move via a
  fresh image built from a bumped `KBRAIN_REF` in git.

## Upstream sync checklist

1. In the `kbrain` fork on a branch: `git fetch upstream && git merge
   upstream/master`. Open a PR in the fork.
2. Review the diff with extra care on:
   - Schema migrations (RDS impact — we run managed Postgres, not PGLite).
   - New required environment variables.
   - Changes to `gbrain serve --http` contract.
   - Changes to the MCP tool list (may require updates to the `include:` list
     in `alpha-researcher/config.yaml`).
   - Any new auto-upgrade or phone-home behaviour.
3. Merge the PR. Record the merged upstream SHA + date below.
4. Bump `hermes-agents/gbrain-mcp/.kbrain-ref` in this repo. Open a PR. Let CI
   build a preview image.
5. Deploy to a staging/canary service first if one exists; otherwise
   `./scripts/deploy.sh --redeploy` to `gbrain-mcp` and watch:
   - `gbrain doctor` exits 0 in the container.
   - MCP `initialize` handshake returns from the internal ALB.
   - A sample `gbrain query` from alpha-researcher round-trips.

## What we explicitly do NOT rename

- The `gbrain` CLI binary name.
- The npm package name.
- Internal module paths.
- Any on-disk or env var conventions published by upstream.

Only the fork repository name differs. This keeps `git merge upstream/master`
conflict-free.

## Out of scope for the fork

- Minions (GBrain's Postgres job queue).
- Voice, email, X, Calendar, Circleback recipes.
- `soul-audit`, `daily-task-manager`, `daily-task-prep`, `briefing`, `skillify`
  — these conflict with Kelai-specific curated files.
- Multi-tenant auth inside gbrain itself (we wrap it with a bearer token at the
  MCP HTTP layer).

## Log

| Date       | Action                  | Upstream SHA | Fork SHA | Notes                                          |
| ---------- | ----------------------- | ------------ | -------- | ---------------------------------------------- |
| 2026-04-20        | Initial fork            | b5fa3d044ae25d08f23068c1e2a00ec77405ccce          | TBD      | Populate on first sync; owner/repo TBD.        |

Keep this table append-only. One row per sync.
