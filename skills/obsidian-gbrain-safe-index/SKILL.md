---
name: obsidian-gbrain-safe-index
version: 1.0.0
description: |
  Connect, maintain, and sync an Obsidian-style Markdown vault with gbrain while preserving a cost-controlled workflow: the vault remains the source of truth, gbrain is the searchable/embedded index, durable skills/workflows are captured into the vault, and paid embedding runs only after explicit approval.
triggers:
  - "connect Obsidian to gbrain"
  - "import my vault to gbrain"
  - "sync vault and gbrain"
  - "capture this skill in my vault"
  - "embed gbrain after vault update"
  - "is gbrain synced with my vault"
tools:
  - terminal
  - read_file
  - search_files
  - write_file
  - patch
mutating: true
---

# Obsidian → gbrain Safe Index and Capture

## Contract

This skill guarantees:

- Treats the user's Obsidian-style Markdown vault as the source of truth before gbrain indexing.
- Keeps gbrain in conservative mode unless the user explicitly approves a more expensive mode.
- Imports vault changes with `--no-embed` first, then embeds only after explicit approval for the specific paid action.
- Captures durable new skills, workflows, and environment learnings into the vault instead of leaving them only in chat memory.
- Verifies every sync with concrete `gbrain stats`, search mode, and, when embeddings run, exact embedded chunk counts.

## Phases

1. **Resolve the vault path.**
   - Prefer an existing environment variable such as `OBSIDIAN_VAULT_PATH` or `WIKI_PATH`.
   - If no path is configured, search likely note directories and ask the user before writing.
   - Verify the directory exists and contains markdown files or an `.obsidian` directory.

2. **Read vault operating rules before writing.**
   - If the vault has `SCHEMA.md`, `index.md`, `log.md`, `AGENTS.md`, or similar operating files, read them before ingest/query/major edit.
   - Respect immutable source folders such as `raw/` when the vault declares them.
   - Use the vault's native link convention, usually Obsidian `[[wikilinks]]`, for durable relationships.

3. **MECE/capture decision.**
   - If new knowledge belongs on an existing page, update that page.
   - If it is a distinct recurring workflow or operational policy, create a small meta or concept page following the vault schema.
   - Update the vault index/catalog for every new page when the vault maintains one.
   - Append a log entry for meaningful vault updates when the vault maintains a log.

4. **Safe gbrain import path.**
   - Pre-check source directory; do not import a nonexistent path.
   - Run `gbrain config set search.mode conservative` before/after risky reinit steps.
   - Run `gbrain import "$OBSIDIAN_VAULT_PATH" --no-embed`.
   - Run `gbrain extract links --source fs --dir "$OBSIDIAN_VAULT_PATH"` when wikilinks changed materially.

5. **Paid embedding gate.**
   - Do not run `gbrain embed --stale` unless the user explicitly asks or a prior instruction clearly approved this exact paid action.
   - Before embedding, verify provider readiness with `gbrain providers test --model <provider:model>`.
   - Confirm the configured embedding dimensions match the local schema.
   - After embedding, verify `gbrain stats` and record exact `Pages`, `Chunks`, `Embedded`, and `Links` counts.

6. **Final verification and vault echo.**
   - Run `gbrain stats` and `gbrain search modes`.
   - If vault files changed, re-import with `--no-embed`; if embedding was approved, embed stale chunks afterward.
   - Report what changed, what was free/local, what used API billing, and what remains pending.

## Output Format

Use a compact status table:

| Item | Status |
|---|---|
| Vault path | `/path` |
| Vault updated | yes/no + files |
| gbrain mode | conservative/balanced/tokenmax |
| Import | `--no-embed` completed / skipped / failed |
| Pages/chunks | exact counts from `gbrain stats` |
| Embeddings | exact count; note whether this run used API billing |
| Links | exact count |
| Background jobs | none / list exact jobs |

Then include:

- **Safe next step:** free/local action.
- **Paid next step:** embedding/LLM action, if any, with explicit approval requirement.

## Anti-Patterns

- Creating a duplicate skill/page when an existing Obsidian, gbrain, or vault-ingest skill already covers the workflow.
- Running `gbrain embed --stale`, `gbrain dream`, `gbrain autopilot --install`, `gbrain onboard --auto`, or `tokenmax` without explicit cost approval.
- Importing a nonexistent or wrong directory and treating a zero-page import as success.
- Forgetting to update the vault index/catalog and log after creating or materially updating vault pages.
- Recording API keys, tokens, or raw secrets in the vault or final response.

## Tools Used

- `read_file` — read vault schema/index/log and target notes.
- `search_files` — find existing vault pages and avoid duplicates.
- `write_file` / `patch` — create or update vault pages.
- `terminal` — run `gbrain`, `git`, and environment checks with secret values redacted.

## Safe Commands

```bash
export PATH="$HOME/.bun/bin:$PATH"
gbrain config set search.mode conservative
gbrain import "$OBSIDIAN_VAULT_PATH" --no-embed
gbrain extract links --source fs --dir "$OBSIDIAN_VAULT_PATH"
gbrain stats
gbrain search modes
```

## Paid / Approval-Gated Commands

```bash
gbrain providers test --model <provider:model>
gbrain embed --stale
gbrain dream
gbrain autopilot --install
gbrain onboard --auto --max-usd 5
gbrain config set search.mode tokenmax
```

## Verification Checklist

- [ ] Vault path exists and is the intended source.
- [ ] Vault operating files were read before edits when present.
- [ ] Existing pages/skills were searched to avoid duplicates.
- [ ] New/updated vault pages follow the vault schema and link convention.
- [ ] Vault index/catalog updated for new pages when present.
- [ ] Vault log appended for meaningful actions when present.
- [ ] `gbrain import ... --no-embed` completed.
- [ ] `gbrain stats` recorded pages/chunks/embeddings/links.
- [ ] `gbrain search modes` confirms conservative mode unless a different mode was explicitly approved.
- [ ] No paid/background commands ran without approval.
