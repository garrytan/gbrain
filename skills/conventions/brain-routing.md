# Brain Routing Convention

Cross-cutting rules for which brain and which source an operation targets.
Applies to every skill that reads or writes brain pages. Read
`docs/architecture/brains-and-sources.md` once for the full SaaS model.

## Axes

- **Brain** = which database/deployment boundary. In SaaS terms, this is the
  tenant brain.
- **Source** = which team, repo, or domain boundary inside that brain.

Pick one brain and one source per operation. For hosted agents, OAuth source
bindings are authoritative:

- `source_id` is the write source.
- `federated_read` is the readable source set.

## Default Behavior

Start in the brain and source resolved by the environment or OAuth context.
Do not cross the boundary without a reason.

For remote/MCP callers, trust the authenticated client context rather than
local dotfiles:

- `ctx.auth.sourceId`
- `ctx.auth.allowedSources`
- `ctx.sourceId`

For local developer workflows, the runtime can still resolve:

- `--brain`
- `CORTEX_BRAIN_ID`
- `.cortex-mount`
- `--source`
- `CORTEX_SOURCE`
- `.cortex-source`

These are compatibility mechanics, not the SaaS product model.

## When To Switch Brain

Switch brain when:

- The user explicitly names another tenant brain.
- The data owner, lifecycle, residency, backup, or admin boundary changes.
- The task is customer-facing or externally isolated from the main company
  brain.

Do not switch brain when:

- The task only needs a different team/topic/repo inside the same company
  brain. Use a source.
- You are unsure. Ask or stay inside the authenticated scope.

## When To Switch Source

Switch source when:

- The user asks about a specific team, repo, customer set, or domain inside
  the current brain.
- You are writing a page that logically belongs to one team/repo/domain.
- The OAuth client has the needed write/read scope.

Do not switch source when:

- The OAuth client is not allowed to read or write that source.
- The user intent crosses sources and the client has `federated_read` access.

## Writing Rules

Writing is stricter than reading.

- A fact about a team's work goes to that team's source.
- Shared company context goes to the tenant's shared/default source.
- Sensitive domains should use their dedicated source or separate brain.
- If a write would cross the authenticated client's scope, ask for a scoped
  invite/client change instead of silently broadening access.

## Citations

Standard citation format stays the same (`[Source: ...]`). For cross-brain
synthesis, include enough context for traceability:

- Single-brain query: `[Source: Meeting, 2026-04-10]`
- Cross-brain synthesis: `[Source: company:engineering:meetings/2026-04-10]`

## Decision Table

| Situation | Brain | Source |
| --- | --- | --- |
| User asks about a team in the current company | current tenant brain | team source |
| User asks about a separate customer-facing workspace | named customer brain | relevant source |
| User asks "what are we doing across all teams?" | current tenant brain | federated read set |
| User asks "add this to the cortex notes" | current tenant brain | `cortex` |
| User asks "save this meeting note for team X" | current tenant brain unless a separate brain is named | team's meetings source |
| Unknown or ambiguous | ask before writing | ask before writing |

## Anti-Patterns

- Silently jumping brains to find an answer when the authenticated scope is
  clear.
- Writing to the wrong brain/source when the data is clearly team-owned.
- Cross-brain synthesis without citations that name the source brain.
- Ignoring OAuth `source_id` and `federated_read` bindings for remote callers.

## Read More

- `docs/architecture/brains-and-sources.md` - organization, brain, source, and
  agent routing model.
- `skills/conventions/brain-first.md` - reads the brain before asking.
- `skills/conventions/quality.md` - citation format.
