# Upgrade matrix

[.github/workflows/upgrade-matrix.yml](../.github/workflows/upgrade-matrix.yml)
installs published gbrain releases exactly as a user does, builds a small brain
on each, upgrades it through that release's own updater to one candidate, and
checks the candidate on the upgraded brain. The driver is
[scripts/upgrade-matrix.ts](../scripts/upgrade-matrix.ts) with its modules in
[scripts/upgrade-matrix/](../scripts/upgrade-matrix/).

It does not gate releases to the latest lane. Stable promotion reads its run
receipt (GBRA-224 W1).

## What a run tests

**From-versions.** Resolved once per run from published release tags (the
releases API, authenticated with the workflow token) and recorded in the plan:
N-1, N-10 and N-50 (the 1st, 10th and 50th newest release older than the
candidate), the release published closest to 30 days before the candidate, and
the current `stable` tag when it exists and is older. A role that cannot be
filled is recorded as skipped with its reason. Pull requests run N-1 and N-50
only.

**Cells.** Every from-version runs on PGLite and Postgres, keyless and keyed,
repo-less and repo brain (32 to 40 cells; one job per from-version, engine and
key mode runs both brain shapes). Pull requests run PGLite and Postgres,
keyless, repo-less only. Keyed cells set a Voyage key (gbrain's default
embedding provider) and the fixture forwards `api.voyageai.com` to the local
fake provider in `scripts/bench/retrieval-scale/mock-providers.ts`, so the
brain keeps the provider's real URL and nothing is billed. Repo cells run
`gbrain init --git`; repo-less cells keep the default content directory
without Git.

**Each cell**, in its own HOME, GBRAIN_HOME, BUN_INSTALL and global git config:

1. Installs the old release with the README command,
   `bun install -g github:garrytan/gbrain`, while the fixture's default branch
   and `latest-stable` point at that release, and checks `gbrain --version`.
2. Runs `gbrain init` for the cell's shape and seeds pages, a page with a facts
   fence, a remembered fact, a soft-deleted page, embeddings (keyed) and one
   `gbrain dream` pass (recorded, not judged: the old release ran it). It
   snapshots the canonical content and keeps a copy of the old install.
3. Starts `gbrain serve` as an agent harness does (stdio, stdin held open) and
   checks it answers MCP as the old version; on Postgres it also starts
   `gbrain jobs supervisor start --detach`.
4. Moves every fixture ref to the candidate and runs `gbrain upgrade` (the old
   release's code). When it refuses with `restart_refused` for the MCP server
   it reruns with `--stop-mcp`, the documented fix.
5. Checks the install is the candidate: `gbrain --version`, the commit Bun
   pinned in its lockfile, and every installed file against the candidate's
   git tree. The fixture log must show the candidate tarball and no other
   commit after the switch.
6. One build: an old serve still running is restarted with the candidate's
   `gbrain upgrade --restart-only --stop-mcp` (old releases have no restart
   step); the restarted serve must report the candidate version over MCP and
   find a seeded page through the `search` tool. On Postgres doctor's
   `runtime_build_skew` must be ok with serve and the supervisor running. No
   process for the brain may remain once both are stopped.
7. `gbrain apply-migrations --yes --non-interactive` exits 0, doctor's
   `schema_version` is at the candidate's head, and doctor reports no failing
   check outside the skill category (see the W4 switch point below).
8. Preservation: the canonical content snapshot equals the one taken before
   the upgrade (below).
9. A new page is written and found by keyword search; keyed cells embed it,
   and `gbrain query` must embed the question and return the matching seed
   page; one `gbrain dream` pass exits 0.
10. Mixed versions: the old install runs `--version`, `search`,
    `doctor --json` and `serve` (MCP initialize and one search) on the
    upgraded brain; the schema catalog and canonical content must not change.

Services the upgrade tries to install go to stub `crontab`, `systemctl`,
`launchctl` and `loginctl` on the cell's PATH; the receipt lists the calls
(`service_calls`) and nothing reaches the runner.

**Preservation snapshot.** Per page: source id, slug, type, kind, title,
content hash, frontmatter, provenance columns (`source_kind`, `source_uri`,
`ingested_via`, `source_path`) and deletion state. Per fact: entity, claim,
row number, kind, visibility, notability, context, source, confidence, valid
dates, typed-claim columns, and expired or superseded state. Per source: id,
name and archive state. Timestamps, ids, vectors, chunks and bookkeeping are
left out, so a migration that adds columns or re-chunks pages compares equal; a
canonical column the upgrade drops is a difference. The catalog snapshot adds
columns, indexes, constraints, triggers, function bodies, views and the
schema version. A PGLite brain is read with the PGLite build of the release
installed at that moment, never the harness's own.

## How the updater is interposed

The old release's updater must only ever see the candidate:

- **git**: `url.<per-cell bare mirror>.insteadOf https://github.com/garrytan/gbrain`
  in the cell's global git config. The mirror borrows the harness checkout's
  objects and holds only the fixture refs (`master`, `latest-stable`,
  `stable`, the old tag and `v<candidate version>`), so `git ls-remote`
  lists the candidate as the newest release.
- **Bun's tarball fetch**: `GITHUB_API_URL` points at the fixture's loopback
  server, which answers `/repos/garrytan/gbrain/tarball/<ref>` with
  `git archive` of the ref's commit.
- **Every other HTTPS request** (raw.githubusercontent.com for VERSION and the
  Bun-floor package.json, api.github.com, codeload, github.com): an
  `HTTPS_PROXY` sends the GitHub hosts to a local TLS server whose certificate a
  per-run CA signs (`NODE_EXTRA_CA_CERTS`), tunnels only `registry.npmjs.org`
  to the internet for dependencies, and refuses every other host. Refused hosts
  are listed in the receipt (`interposition.denied`).

Every from-version installs and upgrades through these paths today, so no
from-version is listed as un-interposable. The binary updater
(`gbrain self-upgrade` on a compiled binary) is not exercised: the matrix
installs through Bun as the README says.

## Verdicts

A cell is `pass`, `fail` (a candidate check failed), `error` (the old
release could not be installed, initialized or seeded in that shape, so there
is no candidate verdict) or `known_exception` (every failure matches an entry
below). A run is **red** when any cell fails, a planned cell left no receipt, a
fault was injected, or a receipt names another candidate or harness; **hold**
when it is otherwise clean but a cell errored or a door could not run;
**green** when every planned cell passed. A hold never qualifies a candidate
and never opens an issue.

<a id="known-exceptions"></a>
**Known exceptions** live in
[scripts/upgrade-matrix/known-exceptions.json](../scripts/upgrade-matrix/known-exceptions.json):
each names one check, an explicit list of old release tags (no wildcards) and
the issue that tracks it. Setup errors cannot be excepted. Old releases that
mutate the brain when started again after the upgrade belong here, linked to
#7776 or a narrower issue; the candidate's own `client_behind` refusal is
tested in the unit suite, since a frozen old binary cannot carry it.

**W4 switch point.** Until `gbrain doctor --alert` ships, the doctor check is
the legacy report (`DOCTOR_ARGV` and `doctorVerdict` in
`scripts/upgrade-matrix/verdict.ts`); a report that carries `alert.level` is
judged by it. When W4 lands, change `DOCTOR_ARGV` there and drop the legacy
branch.

## Runs and receipts

- **Nightly** (06:41 UTC): full matrix against the newest release. A red run
  opens or updates one issue carrying the `upgrade-break` label (found by the
  marker `<!-- gbrain-upgrade-matrix:nightly -->`) and a later green run
  comments and closes it. Nightly watch also tracks the workflow like every
  scheduled run.
- **Dispatch**: `gh workflow run upgrade-matrix.yml --ref master -f candidate=v0.60.475.0`
  (empty candidate: the newest release; `-f from=v0.60.390.0,v0.60.425.0`
  replaces the resolved from-versions; `-f fault=corrupt-after-upgrade` is the
  proof that preservation catches a corrupted upgrade, and is always red).
- **Pull requests** touching schema, migrations, self-upgrade, `upgrade.ts`,
  `apply-migrations` or the harness: the reduced subset against the head.

The gate runs from master's workflow and harness: dispatch and schedule runs
refuse any other ref, and the candidate is only installed as the subject. The
`upgrade-matrix-plan` artifact records the harness commit, the workflow ref,
the candidate tag, commit and tree, and the from-versions with their roles; the
`upgrade-matrix-receipt` artifact adds every cell's verdict and failures. Cell
artifacts keep each cell's receipt, logs and snapshots. A pull-request run's
harness is its own head and is not gate evidence.

Run a cell locally (Postgres cells need a superuser URL, for example the
`docs/TESTING.md` test container):

```bash
bun scripts/upgrade-matrix.ts plan --candidate v0.60.475.0 --out plan.json
bun scripts/upgrade-matrix.ts cell --plan plan.json --from v0.60.474.0 --engine pglite --keys keyless --brain both --out-dir out
UPGRADE_MATRIX_POSTGRES_URL=postgresql://postgres:postgres@localhost:5434/postgres \
  bun scripts/upgrade-matrix.ts cell --plan plan.json --from v0.60.474.0 --engine postgres --keys keyed --out-dir out
bun scripts/upgrade-matrix.ts summarize --plan plan.json --receipts out --out summary.json
```

## Coverage

Against the upgrade-breakage classes in the GBRA-224 plan:

| Class | Covered |
| --- | --- |
| A: schema bring-up from an old version | Yes: every from-version, both engines, through apply-migrations and the schema head check |
| D: the updater targets an unpublished or wrong version | Yes: the old updater runs against the fixture; the installed tree must be the candidate's |
| H: false-healthy signals | Yes: doctor after the upgrade, and the serve answering on the candidate build |
| I: packaged skill and host migrations | Yes: `apply-migrations` runs every orchestrator on a brain the old release created |
| J: embedding backfill holds created by an upgrade | Yes on keyed cells: embedding a new page and vector query after the upgrade |
| C: mixed versions, stale resident processes | Partly: a stdio serve and (Postgres) a supervisor across the upgrade, one build afterwards, and the old binary on the upgraded brain; not long-lived multi-host fleets |
| E: runtime floor, postinstall, Bun | Partly: the real Bun-floor read and global install on the runner's Bun; not older Bun versions |
| G: migration orchestrator chain on managed brains | Partly: the chain on fresh small brains; not managed multi-writer brains |

Not covered: scale (classes B and F stay with the production soak and the
scale tier), multi-host timing, launchd and systemd restart behaviour (service
calls go to stubs), custom database roles, the compiled-binary updater, and
older Bun versions.

## Cost

A cell takes 40 to 70 seconds on a 4-vCPU runner (install from the Bun cache,
seed, upgrade, checks, mixed-version probe); a job adds about two minutes of
checkout, `bun install` and cache restore. A full run is 20 cell jobs of about
four minutes on `ubicloud-standard-4` plus the plan, summary and issue jobs on
`ubicloud-standard-2`: about 330 vCPU-minutes. The pull-request subset is
4 jobs, about 50 vCPU-minutes.
