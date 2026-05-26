# Dream review workflow

`gbrain dream review` is the safe transcript-review lane for operators who want
memory-page proposals without turning on the full dream synthesis writer.

Use it when you have one transcript and want to inspect possible memory pages
before deciding whether anything should become durable brain content.

## Command

```bash
gbrain dream review --input <transcript-file> --json
```

Use `--model` for a one-run model override:

```bash
gbrain dream review \
  --input /Users/sawbeck/.gbrain/session-corpus/2026/2026-05-24-hermes-20260524_075415_7582ca47.txt \
  --model anthropic:claude-sonnet-4-6 \
  --json
```

`--model` does not write config. It is the safe way to test Anthropic review
mode when another provider, such as OpenAI, is not configured.

## Contract

Review mode may call a chat model. It must not:

- write pages
- update `dream.synthesize.last_completion_ts`
- cache dream verdicts
- construct or submit Minion jobs
- write files under the brain repo
- enable autopilot

The JSON response includes `review_only: true`, `pages_written: 0`, the model
used, the source path/date, and proposed pages. Proposed pages are suggestions
only. Approval to write pages is a separate operator action.

## Truth boundary

Treat the transcript as reported evidence, not verified runtime truth.

If a transcript claims something about production, a repo, a deployment, a
customer, or live business state, verify it in the owning source before
promoting it into a durable page. The owning repo/runtime wins over the
transcript.

## PGLite and workers

Review mode is PGLite-safe because it runs inline and does not need workers.
The worker daemon remains a Postgres-oriented operating surface for queued
jobs. PGLite users should use review mode or other inline paths unless they
have explicitly moved to a worker-capable setup.

## Verification

```bash
bun test test/cycle-synthesize-review.test.ts test/dream-review-cli.test.ts
bun test test/e2e/dream-review-pglite.test.ts
```

For a live smoke, run review mode against a known transcript and confirm:

- JSON says `review_only: true`
- JSON says `pages_written: 0`
- JSON uses the requested model when `--model` is passed
- proposed pages are visible for human review
- `git -C <brain-repo> status --short --branch` remains clean
