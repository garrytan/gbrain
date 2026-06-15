# Documentation Status Taxonomy

Status: reusable trust/status taxonomy for docs consolidation issue #3

Proof level: `code_proven` static documentation and source inspection only.
No GBrain runtime command, local brain home, local corpus path, service,
migration, import, sync, or Docker lifecycle command was run.

This taxonomy applies to upstream documentation input. It does not classify
`docs/docs-consolidation/*` outputs as public docs.

## Status Values

Use these values consistently in consolidation notes, review checklists, and
status banners when a banner is needed.

| Status | Meaning | Use when | Preferred action |
|---|---|---|---|
| `CURRENT` | Accurate current-state operational or architecture reference for its stated scope. | The doc matches `CHANGELOG.md`, current source/docs authority, and current entrypoint routing. | Keep, route to it, or update only for clarity. |
| `INCOMPLETE_CURRENT` | Mostly true, but missing current behavior needed for correct operation. | The doc would lead a reader to a workable but partial mental model. | Evolve in place or route to the missing current reference. |
| `CONTRADICTORY` | Conflicts with current source, current docs authority, or the changelog-derived ledger. | The doc says a current behavior is impossible, old, Postgres-only, bearer-only, count-fixed, etc. when that is no longer true. | Fix directly or replace with a pointer to the authority. |
| `HISTORICAL` | Useful history, release notes, incident record, old spec, or provenance. | The doc explains how something changed or what was once planned. | Preserve with a visible status note if it can be mistaken for current guidance. |
| `DESIGN` | Forward-looking or proposal-level design, not guaranteed live behavior. | The doc describes intended architecture, product shape, or unlanded work. | Label and link to current authority when available. |
| `DEPRECATED` | A supported-but-retired path remains for compatibility or migration. | The path still exists but should not be recommended for new installs. | Keep migration/compat instructions, avoid promoting it in entrypoints. |
| `SUPERSEDED_BY` | The useful content moved to or is replaced by another doc. | A page remains for discoverability but should route readers elsewhere. | Add `SUPERSEDED_BY: <path>` and keep only context needed for migration. |
| `MISSING` | A current capability has no adequate reader-facing doc. | The ledger identifies a live capability or operator need not documented centrally. | Create or extend the canonical doc. |
| `GENERATED` | Derived file, regenerated from another source of truth. | `llms.txt`, `llms-full.txt`, generated metric docs, or similar. | Edit generator/source, then regenerate. Do not hand-edit unless the project says otherwise. |
| `FORK_LOCAL` | Fork-specific coordination/output, not upstream canon. | Local PRD, consolidation artifacts, fork URL regeneration notes. | Keep under `docs/docs-consolidation/` or clearly isolate from upstream input. |
| `FIXTURE_OR_EVAL_SUPPORT` | Test fixture, benchmark corpus, or support markdown. | Docs-like file exists only for tests/evals/examples. | Exclude from public-doc trust decisions unless referenced by public docs. |

## Classification Rules

1. Start from `CHANGELOG.md`.
   - Use `docs/docs-consolidation/05-current-capabilities-ledger.md` as the
     current release measuring stick for this PR.
   - Do not classify from memory or from old issue prose alone.

2. Respect authority layers.
   - README routes.
   - `docs/INSTALL.md` operates for humans.
   - `INSTALL_FOR_AGENTS.md` operates for agents and carries safety gates.
   - Architecture docs define current semantics.
   - `CHANGELOG.md` records release evolution.
   - Generated LLM maps are regenerated outputs.
   - Historical/design docs need labels when ambiguous.

3. Classify by reader consequence, not by age.
   - A one-year-old doc can be `CURRENT`.
   - A week-old doc can be `INCOMPLETE_CURRENT` if it misses a just-landed
     operational branch.
   - A release note stays `HISTORICAL` even when perfectly accurate.

4. Separate scope from correctness.
   - A doc can be current for a narrow scope and incomplete for the product.
   - Example: `docs/guides/push-context.md` is current for push context, while
     README is incomplete because it does not route users to that current guide.

5. Prefer in-place evolution for operational docs.
   - If the doc is a live entrypoint or guide, update it rather than creating a
     parallel file.
   - Create a new doc only when the missing subject is genuinely new and has a
     stable home in the authority model.

6. Avoid brittle counts.
   - Counts are allowed only when the scope and source are explicit.
   - Prefer "scaffolded skills in `openclaw.plugin.json`" over "skills".
   - Prefer count-free wording in entrypoints unless a generated source owns the
     number.

7. Generated files follow generator authority.
   - If `README.md`, `AGENTS.md`, `CLAUDE.md`, or an included reference changes
     and the LLM bundle includes that content, update the generator inputs and
     regenerate `llms.txt` / `llms-full.txt`.
   - If only `docs/docs-consolidation/*` changes, do not assume LLM maps need
     regeneration.

8. Public docs must not depend on this consolidation folder.
   - Public docs can reflect decisions derived here.
   - They should not tell users to read `docs/docs-consolidation/*` for normal
     install, operation, or architecture guidance.

## Banner Convention

Use banners sparingly. Add one when a doc lives in a place where readers may
mistake it for current operational guidance.

Recommended format:

```md
> Status: HISTORICAL.
> This page is retained for release/design context. Current operational guidance
> lives in [docs/INSTALL.md](../INSTALL.md).
```

For superseded pages:

```md
> Status: SUPERSEDED_BY: docs/mcp/DEPLOY.md.
> This page remains as a compatibility index. Use the linked deployment guide
> for current protocol and auth behavior.
```

For design docs:

```md
> Status: DESIGN.
> This page describes a proposed or historical design. Verify current behavior
> against [CLAUDE.md](../../CLAUDE.md) and the linked architecture reference.
```

Do not banner every current doc. Over-labeling creates noise.

## Action Queue By Area

| Area | Representative docs | Status now | Action |
|---|---|---|---|
| README/router | `README.md` | `INCOMPLETE_CURRENT` | Add Current Version callout, route to human/agent centers, production path, architecture refs, changelog, LLM entrypoints. |
| Human install/operation | `docs/INSTALL.md` | `INCOMPLETE_CURRENT` | Rebuild as Human Operational Center; remove brittle counts; include branchable setup and production path. |
| Agent install/operation | `INSTALL_FOR_AGENTS.md`, `AGENTS.md` | `INCOMPLETE_CURRENT` / `CURRENT` | Keep search-mode gate; update counts and add operating/topology/production/push-context routing. |
| Search and modes | `docs/guides/search-modes.md`, `docs/architecture/RETRIEVAL.md`, `docs/guides/push-context.md` | mixed: `CONTRADICTORY`/`CURRENT`/`CURRENT` | Replace old search-mode guide with current mode-selection guide spanning search, think, dream/autopilot, reflex, volunteer op, and watch. |
| Operating model and topology | `docs/architecture/topologies.md`, `docs/architecture/brains-and-sources.md` | `INCOMPLETE_CURRENT` | Separate who owns/uses the brain from where/how it is deployed; add family/team/company branches. |
| Brain repo layout | `docs/architecture/brains-and-sources.md`, schema docs, tutorials | `MISSING` central guide | Add user-facing layout guidance or a section in the Human Operational Center, then route deeper architecture refs. |
| Production operations | install docs, live-sync, verify, minions, MCP, security | `MISSING` central path | Add one checklist covering topology, provider/base URL gotchas, keys, backups, OAuth/scopes, MCP exposure, health, and failure verification. |
| MCP/auth/remote | `docs/mcp/DEPLOY.md`, `docs/mcp/ALTERNATIVES.md`, `SECURITY.md`, `docs/architecture/thin-client.md` | mixed: `CURRENT`/`CONTRADICTORY`/`CONTRADICTORY`/`CURRENT` | Make `DEPLOY.md` the protocol authority; update or supersede stale bearer/Postgres-only wording. |
| Historical/design/archive | `docs/GBRAIN_V0.md`, `docs/designs/*`, `docs/issues/*`, `docs/proposals/*`, `docs/incidents/*`, `docs/plans/*`, `TODOS.md` | `HISTORICAL` or `DESIGN` | Add minimal labels only where ambiguity affects operators. |
| Generated maps | `llms.txt`, `llms-full.txt`, `scripts/llms-config.ts` | `GENERATED` plus count drift | Update generator/source text before regenerating; avoid hand edits. |
| Test/fixture docs | `test/**`, eval fixtures | `FIXTURE_OR_EVAL_SUPPORT` | Keep excluded from public documentation status except when public docs cite them. |

## Status Label Placement

Apply labels at the top of:

- historical specs that look like install guides;
- design docs that look like current architecture;
- old MCP/security pages with superseded protocol framing;
- incident/proposal pages when linked from current docs;
- deprecated compatibility pages that remain useful.

Avoid labels on:

- `CHANGELOG.md` itself;
- generated maps;
- test fixtures;
- docs that will be updated directly in the same PR;
- consolidation-only artifacts.

## Inventory Refresh Result

The existing inventory remains the working file count baseline for this PR:

- 350 documentation-like files.
- 80 under `test/` or `tests/`.
- 270 non-test documentation-like files.
- `docs/docs-consolidation/*` excluded from upstream documentation input.

This taxonomy updates the inventory by adding a trust/status layer on top of
the manifest. It does not replace `01-documentation-manifest.tsv`.

## Proof Map

| Claim | Proof level | Evidence |
|---|---|---|
| Status taxonomy covers #3 acceptance statuses | `implemented` | This file defines `CURRENT`, `INCOMPLETE_CURRENT`, `CONTRADICTORY`, `HISTORICAL`, `DEPRECATED`, `SUPERSEDED_BY`, and `MISSING` plus supporting values. |
| Docs-consolidation outputs stay separate from upstream docs input | `implemented` | Scope statement and classification rules in this file; inventory exclusion in `01-documentation-inventory.md`. |
| Action queue maps docs to update, label, route, or leave historical | `implemented` | "Action Queue By Area" and "Status Label Placement" sections. |
| Inventory baseline remains current for this branch | `code_proven` | `01-documentation-inventory.md`, `01-documentation-manifest.tsv`, `02-architecture-map.md`, and current git status after upstream fetch. |
