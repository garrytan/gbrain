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
| `--handle <login>` | your GitHub handle (reserved for involvement queries) | none |
| `--scope auto\|repos` | auto-discover vs explicit list | `auto` |
| `--repos a/b,c/d` | repos when `--scope repos` | none |
| `--dir <path>` | managed page directory | `$GBRAIN_HOME/clones/<id>-github` |
| `--no-involvement` | disable involvement query expansion | enabled |

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

Three layers, cheapest to fastest:

1. **Poll sweeps** (default): `gbrain sync --source gh` on your own cron or
   via autopilot. Zero standing infrastructure. A sweep is one list call per
   repo plus detail calls for changed items.
2. **Full reconcile** (daily recommended): `gbrain sync --source gh --full`
   re-enumerates everything, refreshes strays and deletes pages for items
   that vanished. Backed by the same mass-delete guard as git sources.
3. **Webhook** (optional accelerator): event-driven, sub-second item
   refreshes. See below.

Every page carries `synced_at` and the API `updated_at` in frontmatter, so
staleness is measurable and the next sweep skips fresh pages.

## Webhook (optional but recommended)

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
