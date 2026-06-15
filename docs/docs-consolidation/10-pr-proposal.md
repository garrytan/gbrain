# Docs Consolidation PR Proposal

Status: prepared PR handoff. Do not open or mark a PR ready without explicit
operator approval.

## Proposed Title

Docs: consolidate GBrain operational entrypoints and current-state guidance

## Proposed Body

### Summary

This is a docs-only consolidation pass for GBrain operational documentation. It
does not change runtime behavior.

The branch:

- adds a changelog-derived current-capabilities ledger;
- refreshes the documentation inventory and status taxonomy;
- makes README a router with current version, human install, agent install,
  production, architecture, and LLM entrypoints;
- rebuilds `docs/INSTALL.md` as the Human Operational Center;
- updates `INSTALL_FOR_AGENTS.md` as the Agent Operational Center;
- separates operating models from deployment topologies;
- adds a central Brain Repo Layout guide;
- adds a Mode Selection Guide for `search`, `think`, `dream`/autopilot, and
  push context;
- adds a production/shared-brain path and checklist;
- aligns MCP/auth/remote/thin-client docs with current OAuth/scopes/localOnly
  behavior;
- labels selected historical/design/superseded docs;
- removes or qualifies brittle skill/test/generated-map count claims;
- regenerates `llms.txt` and `llms-full.txt` where their source changed;
- adds a final consistency report mapping PRD acceptance, changelog-current
  capabilities, operator feedback, and issues #2 through #14.

### Key Artifacts

- `docs/docs-consolidation/05-current-capabilities-ledger.md`
- `docs/docs-consolidation/06-documentation-status-taxonomy.md`
- `docs/docs-consolidation/09-final-consistency-report.md`
- `README.md`
- `docs/INSTALL.md`
- `INSTALL_FOR_AGENTS.md`
- `docs/architecture/topologies.md`
- `docs/architecture/brain-repo-layout.md`
- `docs/guides/mode-selection.md`
- `docs/mcp/DEPLOY.md`
- `SECURITY.md`
- `llms.txt`
- `llms-full.txt`

### Validation

- `bun run build:llms` passed after generated-map source changes.
- `git diff --check` and staged whitespace checks passed on implementation
  slices.
- Targeted stale-count searches passed for the #13 phrases.
- Staged-diff secret-pattern scans returned no hits.
- GitHub issues #1 through #14 were used as tracker/acceptance context.
- Final report confirms no `src/`, test, migration, package, lockfile, Docker
  compose, or runtime config changes.
- `bun test test/build-llms.test.ts` passed after materializing locked
  dependencies locally with `bun install --frozen-lockfile --ignore-scripts`.

### Proof Limits

- Static documentation/source inspection only.
- No GBrain runtime command was run.
- No local GBrain brain home, corpus path, runtime config, Hermes/OpenClaw,
  Hindsight, or Nexus runtime was inspected.
- No service, Docker lifecycle, migration, import, sync, or dependency install
  beyond local dependency materialization was run.
- One local dependency materialization was run with `bun install
  --frozen-lockfile --ignore-scripts`; it changed no tracked files and did not
  run lifecycle scripts.

## Review Checklist

- [ ] README routes readers without duplicating operational detail.
- [ ] `docs/INSTALL.md` is acceptable as the Human Operational Center.
- [ ] `INSTALL_FOR_AGENTS.md` preserves the search-mode user gate and remote
      safety boundaries.
- [ ] Operating model and deployment topology are distinct enough for personal,
      family/team/company, thin-client, split-engine, and security-driven
      setups.
- [ ] Production checklist covers provider/base URL gotchas, keys, backups,
      OAuth/scopes, MCP exposure, health, and failure verification.
- [ ] Historical/design/superseded labels are useful without over-labeling.
- [ ] `llms.txt` and `llms-full.txt` generated-map guidance is acceptable for
      upstream and fork users.
- [ ] The `.gitignore` local-analysis entries for `.codegraph/` and
      `.understand-anything/` are acceptable in a docs-focused PR, or should be
      moved to local excludes before opening the PR.
