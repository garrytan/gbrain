# GitHub source kind: issues and PRs live in the brain

The `github` source kind mirrors issues, pull requests, comments, reviews,
review comments, labels, assignees, milestones and open-PR CI checks into
brain pages. One page per item, state in frontmatter, the full thread in the
body, wikilinks between linked items and every `#<n>` mention. Closed items
feed the existing dream-cycle atom extraction, so lessons and takes come from
machinery you already run.

The feature is opt-in and dormant until you register a github-kind source.

## Setup

### 1. Create a fine-grained token

A fine-grained PAT with read permission on `Issues` and `Pull requests`
(plus `Metadata`, which is mandatory) for the repos you want to track. The
token must be reachable via an environment variable, by default `GH_TOKEN`.
It is never stored in the brain; set it in the environment that runs
`gbrain sync` (and `gbrain serve --http` if you use the webhook).

### 2. Register the source

```bash
export GH_TOKEN=github_pat_...
gbrain sources add gh \
  --kind github \
  --scope auto
```

`--scope auto` discovers every repo you own, collaborate on, or belong to as
an org member. Pin an explicit list instead:

```bash
gbrain sources add gh \
  --kind github \
  --scope repos \
  --repos owner/one,owner/two
```

Options:

| Flag | Meaning | Default |
|---|---|---|
| `--token-env <var>` | env var holding the token | `GH_TOKEN` |
| `--scope auto\|repos` | auto-discover vs explicit list | `auto` |
| `--repos a/b,c/d` | repos when `--scope repos` | none |
| `--dir <path>` | managed page directory | `$GBRAIN_HOME/clones/<id>-github` |

Repo names are matched case-insensitively everywhere (GitHub treats them
that way); pages and state always use the lowercase form. The `gh_handle`
and `gh_involvement` config keys are reserved: tolerated when present,
ignored by the sync.

### 3. Sync

```bash
gbrain sync --source gh          # delta sweep since the last run
gbrain sync --source gh --full   # full reconcile incl. deletions
```

The first sync is a full bootstrap and may take a while on large histories
(the API rate bucket throttles it; every item is written atomically, so
interruptions resume on the next run). Subsequent sweeps use the `since`
filter and only touch changed items.

Dream cycle and autopilot pick the source up automatically: the cycle's
`sync` phase runs every registered source, and the `extract` / `patterns` /
`consolidate` phases turn resolved items into atoms, lessons and takes.

## Freshness model

Three layers, fastest to cheapest:

1. **Webhook (recommended)**: event-driven, sub-second item refreshes.
   GitHub pushes the change to you the moment it happens; no polling, no
   standing API traffic. See below.
2. **Poll sweeps** (fallback): `gbrain sync --source gh` on your own cron or
   via autopilot. Zero standing infrastructure. A sweep is one list call per
   repo plus detail calls for changed items. Use it where a webhook cannot
   reach the brain (no public URL, locked-down network).
3. **Full reconcile** (daily recommended): `gbrain sync --source gh --full`
   re-enumerates everything, refreshes strays and deletes pages for items
   that vanished. Backed by the same mass-delete guard as git sources.
   It is the audit that catches anything the webhook or sweeps missed.

Every page carries `synced_at` and the API `updated_at` in frontmatter, so
staleness is measurable and the next sweep skips fresh pages.

## Webhook (recommended: instant sync)

Point GitHub webhooks at your `gbrain serve --http` instance:

```bash
gbrain sources webhook set gh --secret <your-secret>
```

The command prints the payload URL, secret and the exact event list to
select. Register the webhook on each repo you track, with events: issues,
pull requests, issue comments, PR reviews, PR review comments, labels,
milestones, assignees, check runs, check suites, workflow runs. Each event
submits a targeted `sync` job that refreshes exactly the item that changed
(check events resolve the linked PR from the payload; events without an
item reference are acknowledged and skipped). Push events keep their
existing git-source behavior.

Without a public URL, use a tunnel (Tailscale Funnel, ngrok, or any HTTPS
host). The webhook is HMAC-signed per source with the same
`X-Hub-Signature-256` verification as the existing push webhook. Out-of-scope
repos are acknowledged but never materialized.

## Pages

- Item: `gh/<owner>/<repo>/<number>.md` (numbers are unique per repo across
  issues and PRs, so one namespace is correct).
- Repo card: `gh/<owner>/<repo>/index.md`.
- Frontmatter: kind, repo, number, title, state, status (merged/draft/
  open/closed), review decision, checks pass/fail/pending counts, labels,
  assignees, milestone, URL, `updated_at`, `synced_at`, linked items.
- Body: description, every comment, reviews, review comments with file and
  line references. `#<n>` mentions and Closes/Fixes/Resolves references
  become wikilinks, so graph traversal works across the whole history.

## Retrieval

Mirrored items are fully searchable through the normal `gbrain query` /
`gbrain search` paths (hybrid keyword + vector over title, description,
comments, reviews and checks). Two behaviors worth knowing:

- **Empty-body items** (an issue or PR with no description) render a
  `## Context` block with labels, milestone, assignees and repo, so they
  stay recallable by those facets. Without a body, the chunk would hold
  only the title, and compound titles tokenize poorly.
- **Near-identical pages** (the same PR merged across several mirrored
  repos) are de-duplicated at search time by upstream gbrain (Jaccard
  similarity, `src/core/search/dedup.ts`). Content recall is unaffected:
  the surviving copy carries the same text, and the hidden copy is still
  reachable via a repo-scoped query or direct slug lookup. If you need
  the per-repo copy to win, include the repo name in the query.

A feature-scoped retrieval bench (brain-bench style, hit@K against a live
mirror) ships with the QA notes; see `QA-REPORT.md` for the summary.

## Rate limits

The client honors `x-ratelimit` headers, backs off on 403/429 and pauses
when the bucket runs low. Pagination follows GitHub's Link header, so large
repositories are never truncated; an enumeration that hits the safety cap
is treated as failed and never reconciled against the brain. A large
bootstrap (tens of thousands of items) runs throttled over a few hours and
resumes where it left off. The sweep cursor only advances after a fully
successful run, so failed items are retried on the next sweep. Steady-state
sweeps use a few dozen calls per hour.

## Removing the source

```bash
gbrain sources remove gh --confirm-destructive
```
