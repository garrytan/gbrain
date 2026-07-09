# Stop Memory Capture Recipe

This recipe captures agent hook events into a review queue for the Dreams review
workflow.

It is intentionally conservative:

- raw local evidence is written under `~/.gbrain/inbox/auto`;
- a redacted review draft is written under `~/brain/inbox/auto/YYYY-MM-DD`;
- no curated pages are created;
- no `gbrain sync`, commit, or push is run.

The review draft is meant to be handled later by `skills/dreams/SKILL.md` or an
equivalent operator-approved review workflow.

## Supported Events

The example Codex config covers:

- `UserPromptSubmit`
- `Stop`
- `SubagentStop`

Generate a config snippet:

```bash
bun recipes/stop-memory-capture/stop-memory-capture.ts --print-config
```

## Configuration

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `GBRAIN_CAPTURE_BRAIN_DIR` | `~/brain` | Brain markdown repo where redacted review drafts go |
| `GBRAIN_CAPTURE_RAW_DIR` | `~/.gbrain/inbox/auto` | Raw local evidence directory |
| `GBRAIN_CAPTURE_MIN_CHARS` | `200` | Skip captures shorter than this normalized length |
| `GBRAIN_CAPTURE_INCLUDE_CWD` | unset | Include a redacted `cwd` line in review drafts. Omitted by default. |
| `GBRAIN_CAPTURE_DRY_RUN` | unset | Print target paths without writing files |

## Session Aggregation

Events with the same `session_id` append to the same redacted review draft.
Each append creates a new `Capture segment N` section and increments
`capture_segment_count`.

That keeps one conversation reviewable as one unit even when it produces
multiple Stop/UserPrompt/SubagentStop hook events.

## Safety Boundary

The script redacts home-directory prefixes and common token/private-key shapes
before writing the review draft. It omits `cwd` from review drafts by default
because repository and folder names can identify private work. The raw evidence
stays local and should not be imported, embedded, committed, or shared by
default.

The redacted draft is still only a candidate. The Dreams review workflow is the
place where an agent decides whether to preserve, synthesize, archive, discard,
or block it.
