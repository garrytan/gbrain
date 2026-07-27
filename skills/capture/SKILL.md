---
name: capture
description: Save any thought or content into the brain via one CLI command. The single human-facing entrypoint that replaces "put_page vs commit-then-sync vs autopilot-wait" with one command that just works.
triggers:
  - "capture this"
  - "save this thought"
  - "remember this"
  - "ingest this into my brain"
  - "drop this in the inbox"
  - "save to brain"
writes_pages:
  - "inbox/*"
---

# capture — the single ingestion entrypoint

When the user wants to save a thought, an article snippet, a transcript
fragment, or any text into their brain, run `gbrain capture`. Don't reach
for `gbrain put` or commit-then-sync — `capture` is the front door and it
handles both local and thin-client installs the same way.

## Contract

- **Input:** the content to save (inline arg, `--file PATH`, or `--stdin`).
- **Output:** a page in the brain DB AND a markdown file on disk under
  `<sync.repo_path>/<slug>.md`. Receipt printed to stdout.
- **Side effect:** the page becomes immediately queryable via `gbrain query`,
  `gbrain search`, or any MCP-bound agent.
- **Idempotency:** same content → same `inbox/YYYY-MM-DD-<hash8>` slug. The
  daemon's 24h content-hash dedup catches re-captures.
- **Trust:** all captures via this skill are local-CLI trust (`remote: false`).
  Untrusted webhook ingestion goes through `POST /ingest`, not this verb.

## When to invoke

- "Capture this thought" / "save this" / "drop this into my brain" / "remember this"
- The user pastes content and asks to keep it
- After a meeting summary, a research note, or any synthesis that should land as a brain page

## What it does

`gbrain capture` resolves to a `put_page` call (local) or a remote MCP call
(thin-client). Either way the page lands in the DB AND on disk in one move
via the v0.38 write-through plumbing. The default slug is
`inbox/YYYY-MM-DD-<hash8>` so captures cluster in a predictable triage
location.

## How to use

```bash
gbrain capture "the thought I want to remember"
gbrain capture --file ./notes/today.md
echo "from a pipe" | gbrain capture --stdin
gbrain capture "..." --slug daily/2026-05-21
gbrain capture "..." --type idea --source voice-whisper
gbrain capture "..." --quiet          # script-friendly: prints just the slug
gbrain capture "..." --json           # structured output for agents
```

## Defaults

- **Slug:** `inbox/YYYY-MM-DD-<hash8>` (stable for same content; the daemon's 24h dedup catches re-captures).
- **Type:** `note` (override with `--type idea` etc.).
- **Frontmatter stamps:** `captured_via: capture-cli`, `captured_at: <ISO>`.
- **Title:** first non-empty line of the body, capped at 80 chars (truncation appends `…`).

## Output Format

Default prints a 5-line receipt:

```
captured:
  slug:          inbox/2026-05-21-abcdef12
  status:        created_or_updated
  content_hash:  f3a7b9c0d1e2f3a4…
  file:          /Users/you/brain/inbox/2026-05-21-abcdef12.md
  captured_at:   2026-05-21T04:15:00.000Z
```

`--quiet` prints only the slug (use for `SLUG=$(gbrain capture "..." --quiet)`).
`--json` prints structured output for downstream tools.

## Anti-Patterns

- **Don't reach for `gbrain put`.** That's the old per-page primitive that
  doesn't know about default slug generation, content-type heuristics, or
  the receipt block. `capture` is the human-facing wrapper.
- **Don't try to bulk-import dozens of files by looping over `gbrain capture`.**
  That's what `gbrain sync` (or `gbrain import`) is for. Capture is for
  single thoughts, single notes, single transcripts.
- **Don't pre-format the content yourself with frontmatter if you don't need to.**
  Capture wraps plain prose in sensible frontmatter (type + title +
  captured_via + captured_at). The body becomes `# Title\n\n<your prose>`.
  Pass `--file PATH` if you already have a fully-formatted markdown file.
- **Don't pass secrets as inline content.** Inline args land in shell
  history. Use `--file` or `--stdin` instead.

## When NOT to use this skill

- Bulk ingestion of many files → `skills/media-ingest/SKILL.md` or `gbrain sync` instead
- Article/link with author + publication metadata → `skills/idea-ingest/SKILL.md` (it knows to build the people page)
- Meeting transcripts → `skills/meeting-ingestion/SKILL.md` (attendee enrichment)

This skill is for the simple "I have a thought, save it" case. Specialized
ingestion paths handle their own slugging + cross-referencing.
