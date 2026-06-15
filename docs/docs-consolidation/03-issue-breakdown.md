# Documentation Consolidation Issue Breakdown

Status: published issue proposal and execution ledger

Parent issue: <https://github.com/TheAngryPit/gbrain/issues/1>

Tracker mode: GitHub issues, `ready-for-agent` label where available

All slices are AFK. No slice requires local runtime inspection or GBrain
runtime commands.

## Execution Artifacts

| Issue | Artifact |
|---|---|
| [#2](https://github.com/TheAngryPit/gbrain/issues/2) | `docs/docs-consolidation/05-current-capabilities-ledger.md` |
| [#3](https://github.com/TheAngryPit/gbrain/issues/3) | `docs/docs-consolidation/06-documentation-status-taxonomy.md` |
| [#4](https://github.com/TheAngryPit/gbrain/issues/4) | `README.md`, `llms-full.txt` |
| [#5](https://github.com/TheAngryPit/gbrain/issues/5) | `docs/INSTALL.md` |

## Published Issues

| Issue | Title |
|---|---|
| [#2](https://github.com/TheAngryPit/gbrain/issues/2) | Docs: build changelog-to-current-capabilities baseline |
| [#3](https://github.com/TheAngryPit/gbrain/issues/3) | Docs: refresh documentation inventory and status taxonomy |
| [#4](https://github.com/TheAngryPit/gbrain/issues/4) | Docs: add README router, current version, and LLM entrypoints |
| [#5](https://github.com/TheAngryPit/gbrain/issues/5) | Docs: rebuild INSTALL.md as the Human Operational Center |
| [#6](https://github.com/TheAngryPit/gbrain/issues/6) | Docs: update INSTALL_FOR_AGENTS.md as the Agent Operational Center |
| [#7](https://github.com/TheAngryPit/gbrain/issues/7) | Docs: add operating-model and deployment-topology decision trees |
| [#8](https://github.com/TheAngryPit/gbrain/issues/8) | Docs: document Brain Repo Layout and brain/source relationships |
| [#9](https://github.com/TheAngryPit/gbrain/issues/9) | Docs: add Mode Selection Guide for search, think, dream, and push context |
| [#10](https://github.com/TheAngryPit/gbrain/issues/10) | Docs: add production operational path and checklist |
| [#11](https://github.com/TheAngryPit/gbrain/issues/11) | Docs: align MCP, auth, remote, thin-client, and agent exposure docs |
| [#12](https://github.com/TheAngryPit/gbrain/issues/12) | Docs: apply status labels to historical, design, deprecated, and superseded docs |
| [#13](https://github.com/TheAngryPit/gbrain/issues/13) | Docs: remove or qualify brittle counts and generated-map claims |
| [#14](https://github.com/TheAngryPit/gbrain/issues/14) | Docs: run final docs-only consistency pass against changelog, source, PRD, and feedback |

## Ground Rule

The first implementation issue must build a changelog-to-current-capabilities
baseline. The docs PR should not start by rewriting entrypoints from stale
mental models; it should first derive the current product/design state from
`CHANGELOG.md` and then compare the docs against that release reality.

## Proposed Issues

1. **Build changelog-to-current-capabilities baseline**
   - Type: AFK
   - Blocked by: none
   - User stories covered: changelog as Release Evolution Ledger; current docs
     should represent current capabilities/design, not partial older versions.
   - Output: a docs-only matrix mapping current release capabilities to docs
     status: current, incomplete-current, contradictory, historical, or missing.

2. **Refresh documentation inventory and status taxonomy**
   - Type: AFK
   - Blocked by: 1
   - User stories covered: documentation inventory; status classification;
     historical/design/superseded clarity.
   - Output: refreshed inventory plus a status taxonomy that can be applied
     consistently before broad rewrites.

3. **Add README router, Current Version callout, and LLM entrypoint callout**
   - Type: AFK
   - Blocked by: 1, 2
   - User stories covered: README as router; current-version visibility;
     machine-readable entrypoints for LLMs and coding agents.
   - Output: README routes to human install, agent install, architecture,
     changelog, production path, and `llms.txt` / `llms-full.txt` without
     duplicating operational detail.

4. **Rebuild `docs/INSTALL.md` as the Human Operational Center**
   - Type: AFK
   - Blocked by: 1, 2
   - User stories covered: central human install/operating path; production
     operator path; not too basic.
   - Output: a single human-facing operational guide covering install, upgrade,
     providers, search-mode choice, operating model, topology, core usage,
     production branch, verification, backup/restore, and deeper references.

5. **Update `INSTALL_FOR_AGENTS.md` as the Agent Operational Center**
   - Type: AFK
   - Blocked by: 1, 2, 4
   - User stories covered: coding-agent protocol; search-mode user gate;
     trusted local CLI vs untrusted remote caller; safe agent verification.
   - Output: agent-facing install/operation flow that mirrors the human
     branches but includes agent safety gates, MCP exposure boundaries, auth,
     provider handling, and LLM map references.

6. **Add operating-model and deployment-topology decision trees**
   - Type: AFK
   - Blocked by: 1, 2
   - User stories covered: personal brain; personal multi-source; shared group
     brain; family/team/company; single-agent shared mode; auth-scoped shared
     mode; security-driven topology.
   - Output: branchable choices that separate who owns/uses the brain from how
     it is deployed and exposed.

7. **Document Brain Repo Layout and brain/source relationships**
   - Type: AFK
   - Blocked by: 1, 2, 6
   - User stories covered: brain repo layout; avoid reverse-engineering from
     source; use GBrain-native terms while preserving vault/Obsidian context.
   - Output: central layout guidance covering recommended directories,
     editable files, managed/generated files, schema-pack expectations,
     source-to-brain relationship, and backup implications.

8. **Add Mode Selection Guide for retrieval, synthesis, maintenance, and push context**
   - Type: AFK
   - Blocked by: 1, 4, 6
   - User stories covered: search vs think vs dream/autopilot; current push
     context capability; avoid ambiguous non-canonical command names.
   - Output: decision aid for `gbrain search`, `gbrain think`, `gbrain dream` /
     autopilot, retrieval reflex, `volunteer_context`, `gbrain
     volunteer-context`, and `gbrain watch`, with cost/quality and safety
     implications.

9. **Add production operational path and checklist**
   - Type: AFK
   - Blocked by: 4, 6, 7, 8
   - User stories covered: production operator needs; topology/safety; provider
     base URL gotchas; key management; backups; OAuth/scopes; MCP exposure;
     health checks and failure-mode verification.
   - Output: production branch inside the Human Operational Center plus a
     concrete checklist that does not force readers to assemble production
     knowledge from scattered snippets.

10. **Align MCP, auth, remote/thin-client, and agent-exposure docs**
    - Type: AFK
    - Blocked by: 1, 5, 6, 9
    - User stories covered: remote/thin client topology; OAuth/scopes; legacy
      bearer compatibility; MCP safety boundaries; agent operation.
    - Output: MCP and thin-client docs defer protocol truth to the right source
      and reflect current OAuth/PGLite/Postgres behavior without stale
      Postgres-only framing.

11. **Apply status labels to historical, design, deprecated, and superseded docs**
    - Type: AFK
    - Blocked by: 2
    - User stories covered: documentation trust level; preserve useful history
      without making it look like current operational guidance.
    - Output: lightweight `CURRENT`, `DESIGN`, `HISTORICAL`, `DEPRECATED`, or
      `SUPERSEDED_BY` labels on docs that can otherwise mislead operators.

12. **Remove or qualify brittle counts and generated-map claims**
    - Type: AFK
    - Blocked by: 1, 2, 3
    - User stories covered: generated LLM maps; skills surface; test count
      drift; current-version accuracy.
    - Output: brittle hard-coded skill/E2E counts are removed or scoped to their
      source, and generated-map guidance distinguishes upstream docs from
      fork-specific URL regeneration.

13. **Run final docs-only consistency pass against changelog, source, PRD, and operator feedback**
    - Type: AFK
    - Blocked by: 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
    - User stories covered: PR remains docs-only; production operator feedback
      is incorporated in our terms; changelog remains the release ledger.
    - Output: final review checklist showing each PRD acceptance bar,
      changelog-current capability, and operator-feedback concern mapped to
      the landed docs, with proof limited to static/docs inspection.
