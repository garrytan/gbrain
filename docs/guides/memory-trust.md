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
With suppress, flagged items are still returned by explicit search, recall
and `get_page`, labeled, but hook context, the context engine,
`context_pack` and volunteer leave them out until you confirm them in
`gbrain trust review`. `write_gate.external_mode reject` refuses such writes
outright. `gbrain trust disable --all` turns every protection off; labels
stay.

## Older memory

Content saved before this release is flagged only after you claim your
sources and run the scan. Older rows have no provenance, so they read as
"unverified origin". On a long-lived brain that is most rows, including your
own notes and synced code repositories. gbrain never scans them on its own.
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
  notes". A row with a lowering signal keeps the lower tier: MCP and capture
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

`gbrain sources set-trust <id> <lower tier>` or `--clear` ends a claim. Rows
it already lifted keep their tier.

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
  The backfill classifies older rows from deterministic signals only.
