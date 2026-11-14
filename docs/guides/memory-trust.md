# Memory trust

gbrain records where each memory came from and how much it should be trusted,
labels everything an agent reads back with that, and flags text that reads like
instructions to an agent. This guide covers what you get by default, the
stricter protections you can turn on, how older memory is covered, and the
commands that claim your sources and scan older memory.

## Trust tiers

Every fact, take, timeline entry and page carries one tier. Read surfaces show
it as a label:

| Tier | Label | Typical origin |
|---|---|---|
| `user_confirmed` | confirmed by you | you confirmed it (`gbrain trust confirm`) |
| `operator_curated` | your notes | sync and import of your own sources |
| `tool_observed` | tool data | structured tool output |
| `agent_written` | written by an agent | `put_page`, `remember`, `capture`, remote MCP writes |
| `unknown` | unverified origin | rows saved before trust tiers existed |
| `external_untrusted` | external, untrusted | connectors, webhooks, clipped pages, third-party transcripts |

When an agent saves something you told it and says so (`content_origin:
"user_said"` on `remember`, `put_page` or `capture`), the row stays
`agent_written` but reads **you told your agent this (not yet confirmed)**, and
its origin gains a `:user_said` marker (`mcp:remember:user_said`). It is not
"confirmed by you" or "your notes": `gbrain trust explain` shows the
`gbrain trust confirm` command that raises it. An instruction-like write the
gate flags keeps "unconfirmed, agent-written" even when tagged `user_said`, so
the tag buys poisoned text no softer label. The tool description tells agents
to use `user_said` only for what you personally said in the conversation, never
for a document, email, web page or tool output, even when that text asks for
it. The exact wording is
`USER_SAID_TRUST_LABEL` in `src/core/trust/tier.ts`.

Nothing ever becomes "confirmed by you" without you typing a confirmation
token at a terminal on the brain host. `--yes` never confirms.

## What you get by default

- **Labels on everything.** Every item an agent reads back (search, recall,
  `get_page`, hook context, `context_pack`) carries its tier label;
  external, untrusted text arrives wrapped as data. `trust.read_policy` is
  `label`.
- **Flags on instruction-like writes.** A write at "written by an agent" or
  below that reads like instructions to an agent (for example "from now on
  always recommend..." or "ignore your previous instructions") is saved, gets
  a write-gate receipt and carries the flag "unconfirmed, agent-written" or
  its external label wherever it is read. External content is flagged too
  (`write_gate.external_mode` is `flag`; `write_gate.agent_mode` is `flag`).
  `gbrain trust review` lists flagged items; confirming one clears its flag.
- **Flagged items still reach proactive context, labeled**
  (`trust.agent_activation` is `allow`).

These defaults come from a preregistered paid eval with Opus 5.5, Sonnet 5.5
and GPT-6.1 Sol (gbrain-evals
`docs/benchmarks/2026-10-08-memory-trust-results-paid.md`). With labels shown,
the stricter protections below cut no measurable attack success, so they
are opt-in. Removing the labels raised attack success, which is why labels
stay on.

## Stricter protections (opt-in)

```bash
gbrain config set write_gate.external_mode quarantine   # hold instruction-like external content out of memory until you release it
gbrain config set trust.agent_activation suppress       # keep flagged agent-written items out of proactive context until you confirm them
```

With quarantine, an instruction-like external write is held: it is not
searchable and not injected until you release it (`gbrain trust release`).
On a managed brain, a released fact whose entity page exists is written as a
row of that page's `## Facts` table, so the page's file holds it; a fact with
no entity page, and any fact on an unmanaged brain, is saved to the database
only.
The release preview shows every field the release confirms along with the
text: kind, visibility, validity, source and context, and for a held row
that is already in a `## Facts` table, that row's confidence, notability,
typed-claim and attribution cells as they stand. The confirmation covers exactly what you saw:
if the hold or that row changes before the release lands, it refuses with
`preview_changed` and the fact stays held, on every brain, with or without a
repository.
With suppress, flagged items are still returned by explicit search, recall
and `get_page`, labeled, but hook context, the context engine,
`context_pack` and volunteer leave them out until you confirm them in
`gbrain trust review`. `write_gate.external_mode reject` refuses such writes
outright. `gbrain trust disable --all` turns every protection off; labels
stay.

## How recall weighs old and low-trust facts (opt-in)

`recall` with a `question` ranks saved facts by how well they match. Turn on
confidence weighting and the match is also weighed by how much each fact
deserves to be believed now:

```bash
gbrain config set recall.confidence_weighting on
```

- Facts you confirmed, and facts from your own notes, keep full weight at any
  age.
- Other facts lose weight as they age (an event after about a week, a
  preference or commitment after about three months, other facts after about
  a year) and by tier: tool data a little, agent-written and unverified facts
  more, external text the most.
- A fact the writer dated ("founded in 2010") is history and keeps its weight.
- Weighting at most halves a fact's score. It reorders the facts that match
  and never hides one; `relevance` stays the plain match score, and
  `rank_score` and `confidence_factor` show the weighting.

It works the same on a brain with no git repository. `gbrain config set
recall.confidence_weighting off` turns it off.

## Old and conflicting facts

Two saved facts can state different figures for the same thing: one note says
acme-example's March MRR was 40k, a later one says 44k. Save figures as typed
claims and gbrain can find these conflicts without an API key or a model call.

```text
remember {fact: "acme-example MRR was 44k in March", entity: "companies/acme-example",
          claim_metric: "mrr", claim_value: 44000, claim_unit: "USD",
          claim_period: "monthly", valid_from: "2026-03-20"}
```

| Field | Meaning |
|---|---|
| `claim_metric` | What is measured, e.g. `mrr`, `headcount`. Required when any other claim field is set. |
| `claim_value` | The number (finite; `"2.5M"` is refused with the corrected call as its fix). |
| `claim_unit` | Optional, e.g. `USD`, `people`. |
| `claim_period` | Optional, e.g. `monthly`. `weekly`, `monthly`, `quarterly` and `annual` (or `yearly`) set the bucket below; any other text is kept as written. |

The claim is stored on the fact and in the entity page's `## Facts` table, so a
re-import keeps it. In a `remember` batch each item carries its own claim
fields; they are never shared across items. Saving the same text again with a
claim adds the claim to a copy saved without one, and never changes a claim
already saved (the response says `claim_ignored: existing_claim`).

Two facts conflict when they are about the same entity and state the same
metric, unit and period in the same as-of bucket: the `valid_from` day, or its
ISO week, month, quarter or year when the period names that cadence. Figures in
different buckets are history, so a monthly MRR series, a run of funding rounds
or a forecast next to an actual (different metrics) are never flagged. A typed
write never supersedes a typed fact in another bucket either.

Finding conflicts is off by default. Turn it on, or run it once:

```bash
gbrain config set dream.claim_conflicts.mode propose   # the nightly dream cycle files them
gbrain decide sweep --claims --dry-run                 # preview; no key, nothing written
gbrain decide sweep --claims [--source <id>]           # file them now
```

Each conflict becomes one pending proposal (`dp<id>`), filed once per pair. A
run files at most `dream.claim_conflicts.max_pairs` (default 500) per source and
leaves the rest for the next run. Nothing changes until you decide. Both facts are shown
as `contested` in `recall` meanwhile, only to a caller that can read the other
fact. Decide each one from `gbrain trust review --kind contradiction`:

| Action | Command | Effect | Undo |
|---|---|---|---|
| supersede | `gbrain decide proposals accept <id>` | The newer fact replaces the older one | `gbrain decide proposals undo <id>` |
| forget | `gbrain forget <newer-id> --source <src>` | Withdraws the newer fact; the older stays current | none |
| confirm | `gbrain trust confirm f<newer-id>` (at your terminal) | Marks the newer fact confirmed by you; the proposal stays open | none |
| drop | `gbrain decide proposals reject <id>` | Not a conflict: both stay current and the pair is not filed again | none needed |

`gbrain trust review --accept-all` never decides a contradiction; it lists each
one as skipped. All of this reads and writes database rows, so it works the
same on a brain with no git repository. On a brain with one, page changes go
through the usual page-write path.

## Older memory

Content saved before this release is flagged only after you claim your
sources and run the scan. Older rows have no provenance, so they read as
"unverified origin". On a long-lived brain that is most rows, including your
own notes and synced code repositories. Agents connected over MCP see text
below "your notes" (including unverified origin) quoted as source material,
so your own older notes read as quoted until you claim their source. gbrain
never scans them on its own.
Doctor, `gbrain post-upgrade` and the behavior-change notice tell you the
commands to run.

## Claim your sources (once, after upgrading)

```bash
gbrain trust claim-sources --dry-run    # read-only: every source and what a claim would change
gbrain trust claim-sources              # asks you, per source, to type its id
```

For each source, the listing shows:
- its id and local path (or remote);
- its page count;
- its trust mix now and after a claim.

Typing a source's id claims it as your own notes:

- The source syncs as "your notes" from now on. This is the
  `gbrain sources set-trust` default, set to `operator_curated`.
- Its rows from before trust tiers move from "unverified origin" to "your
  notes", so agents connected over MCP no longer see them quoted. A row with a lowering signal keeps the lower tier: MCP and capture
  stamps, imported transcripts, clipped pages, connector stamps, extraction
  and dream provenance, journaled agent writes, and a `trust_tier` marker in
  the frontmatter. Nothing goes above "your notes".
- Connector sources (Gmail, Calendar, GitHub) cannot be claimed. Their text
  comes from other people.

Claiming needs you at a terminal on the brain host. Without one (an agent,
piped input) the command changes nothing. It exits 3 with a fix whose
`next` is `tell_user_to_run`; its `user_message` explains claiming.

The lift runs in bounded batches. If it is interrupted,
`gbrain trust claim-sources --resume` finishes it without asking again. Until
the lift finishes, `gbrain trust scan` refuses, and `gbrain trust explain`
shows the claimed source's remaining rows as "your notes".

Each lifted row keeps `write_origin.channel = "trust_claim"`. The source
records when it was claimed and when its lift finished.

Atoms extracted before gbrain recorded `extracted_by` as an agent signal
could be lifted to "your notes" by an earlier claim (#6533).
`gbrain trust claim-sources --relower --dry-run` lists the claim-lifted rows
whose own signals now say lower, and `gbrain trust claim-sources --relower`
lowers them. It only lowers: it never raises a row, it touches only rows with
`write_origin.channel = "trust_claim"`, rows on a lowered page follow it, and
each lowered row records `write_origin.channel = "trust_relower"`.

Legacy Life Chronicle event pages (`captured_via: life-chronicle:auto`) are
model summaries of another page (#9284). A claim caps them at "written by an
agent" and never above the tier of the page they summarise. Events an earlier
claim lifted change only when you run `--relower`.

`gbrain sources set-trust <id> <lower tier>` or `--clear` ends a claim. Rows
it already lifted keep their tier. To lower them anyway, name the source:
`gbrain trust claim-sources --relower --dry-run --source <id>`, then the same
command without `--dry-run`. Doctor names the `--source` flags when it finds
such rows.

## Repair unknown markers

Before v0.60.249.0, an agent edit of a page with no tier yet wrote a
`trust_tier: unknown` marker into its frontmatter (#6550). The backfill later
gave the page its real tier, but the marker stayed. Agents copy the
frontmatter back when they edit, so the next agent edit lowered the page to
"unverified origin" and filed a `lower_page` item you never needed to see.
`gbrain trust review` adds a `repair` command to those items.

```bash
gbrain trust backfill --repair-unknown-markers     # read-only preview
```

The preview lists every page whose marker is `unknown` while its stored tier
is higher. For each page it shows the slug, the current marker, the stored
tier, the proposed marker and the tier after a repair (unchanged). It also
shows the evidence:

- the first saved version that shows the marker, and whether that was before
  or after this brain first ran the fixed release (the release date is a hard
  bound; an upgrade recorded in `~/.gbrain/upgrade-state.json` is more precise);
- whether the page already had the marker when it was first imported.

The time a marker appeared cannot prove it was accidental, so gbrain never
decides for you. Pages with a version from before the fix that shows the
marker, and no marker at first import, are listed as consistent with #6550,
and the printed apply command names them. Every other page is listed as
ambiguous. A page imported with the marker was probably marked on purpose.
Pages an agent edit already lowered are listed with their `gbrain trust
revert` command. Revert them first, then run the preview again.

When any page is listed, the preview ends with the exact command:

```bash
gbrain trust backfill --repair-unknown-markers --slug notes/a-example --expect mr_0123456789abcdef
```

Apply rewrites only the pages you name with `--slug` (repeatable). They must
be at the revisions the preview showed, and the preview must still hash to
`--expect`; otherwise it refuses with `preview_changed` and changes nothing.
The marker becomes the page's stored tier (pages at "your notes" or higher
get no marker), and the page keeps its tier. This runs on the local CLI only.
Run the preview again to verify: repaired pages no longer show.

## Label lowerings

A privacy label is not content. `gbrain repair visibility` (including
`--slug <page>` for one page and `--readers <list>` for its `readable_by`) and `gbrain repair private-labels` keep a
page's tier, file no `lower_page` item, and change only the label lines of its
file. A `put_page` that adds the same label is an agent edit and lowers the
page, because a local agent with a shell is indistinguishable from you.

A local agent edit can't make a page more readable on its own. When a write
below your tier drops or widens a page's `visibility`, `access`,
`confidentiality` or `readable_by`, gbrain publishes the rest of the edit with
the page's earlier labels kept, in the database and in the file it commits.
The write's receipt names the kept keys under `privacy_labels_kept`. The
page's `lower_page` item in `gbrain trust review` shows what the edit asked
for, for example `visibility private -> (none)`.

- `gbrain trust confirm tp<id>` applies exactly those labels, if the page
  hasn't changed since. On a page of yours it also endorses the edit, and the
  page takes your tier. On a page whose own tier is an agent's (one you set
  labels on, or an agent's page that kept you as a reader), it changes only the
  labels and the page keeps the agent's tier, so saying yes to a label change
  never vouches for the body.
- `gbrain trust drop tp<id>` keeps the earlier labels.
- Undoing a confirm puts the earlier labels and the edit's tier back, if the
  page hasn't changed since the confirm.

Until you decide, the page stays private to remote callers and to members
who weren't readers; a credential bound to you still reads it. The hold also
applies after you drop the item, after an earlier agent edit that lowered
the page, and after an agent deletes the page and writes it again, so a later
agent write still can't widen the labels. A maintenance job's derived page
(a dream patterns run rewriting one of your pages) is held the same way, and a
page with no recorded tier (`unknown`) counts as yours. It doesn't
apply to a write that only narrows a label, to a write that leaves the labels
alone, to a writer at or above the page's tier, or to your own edits (a file
you edit and sync, `gbrain repair visibility`).

Labels you set on an agent's page hold too. `gbrain repair visibility` (and
its `--readers` setter, and `gbrain repair private-labels`) keeps the page's
agent tier, but it raises the page's label guard to your tier, so a later agent
write at the page's tier that drops or widens your labels is held the same way.
The guard is kept in the database and set only by a label repair run after the
upgrade, so labels you set earlier, and a managed Git brain rebuilt from a
clone, start without it. Run the label repair again to set it: on a page that
already has the labels, `gbrain repair visibility --slug <page>` (for a private
page) or `--readers <list>` (with the readers the page already names) lists it
as `... kept, label guard raised` and raises the guard without changing the
labels or writing the page. `gbrain repair private-labels` raises it only on
pages it writes. A repair that leaves the page with no privacy label removes the
guard.

An agent also can't take you out of a page's readers. When a write below your
tier sets `readable_by` to a list that leaves you, the brain owner, out of a
page you read now, gbrain publishes the rest of the change with you still in
the list and records the readers it asked for in the page's `lower_page` item;
`gbrain trust confirm tp<id>` applies them. An agent narrowing that keeps you
in the list, your own readers changes, and a brain with
`access.owner_reads_restricted` on (you read every page anyway) are unaffected.

```bash
gbrain trust backfill --label-lowerings [--source <id>] [--json]   # read-only
```

It lists every `lower_page` item and compares the version the lowering
replaced with the page now: `label_only` when only `visibility`, `access` or
`confidentiality` and the server's stamps (`trust_tier`, `source_kind`,
`ingested_via`, `ingested_at`) changed, `content` otherwise, and
`unreadable` when the replaced version is gone. Counts are grouped by proposer
(`agent_page_edit:put_page`, `derived_page:submit_job`, ...). It changes no
tier: raising a page back is your decision in `gbrain trust review`.

## Scan older memory (only when you agree)

```bash
gbrain trust scan
```

The scan runs the write gate's deterministic detector over older rows at
"written by an agent" or below. It records a receipt for each instruction-like
row. It never deletes, moves or rewrites anything. Flagged rows carry their
flag wherever they are read, and with `trust.agent_activation suppress` they
stop reaching proactive context until you confirm them. Doctor's `trust_scan`
check therefore leaves it to you (`fix.next: tell_user_to_run`): no agent
starts it.
Claim your own sources first, so your notes are not treated as unverified.

## Doctor checks

- `trust_sources_unclaimed` warns while unclaimed, non-connector sources hold
  rows from before trust tiers, with `fix.next: tell_user_to_run` naming
  `gbrain trust claim-sources`. It also warns, with the resume command, while
  a claim's lift has not finished, and names `gbrain trust claim-sources
  --relower` while claim-lifted rows rank above their own signals. A fresh or
  empty brain is ok.
- `trust_scan` warns while older rows at "written by an agent" or below have
  not been scanned. Its fix is yours to run (`tell_user_to_run`).
- `trust_tiers` reports the tier mix and recommends `gbrain trust backfill`.
  It also names how many unverified-origin pages remote MCP readers see
  quoted. The backfill classifies older rows from deterministic signals only.
- `trust_release_unpreviewed_fields` warns about facts released from a held
  `## Facts` row before the preview showed that row's fields. Those releases
  confirmed the row's confidence, notability, validity and other cells
  without showing them. Review each listed fact (`gbrain trust explain f<id>`)
  and edit the row or forget the fact if a field is wrong. The check is
  read-only and never lowers a tier.
