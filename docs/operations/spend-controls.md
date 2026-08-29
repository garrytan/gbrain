# Spend controls

GBrain's embedding-spend gates in one place: every gate, its config key, default,
whether it blocks or just informs, how to widen or disable it, and how the
`spend.posture` switch governs all of them.

The orienting idea: **GBrain itself is rounding error; the spend that matters is
downstream embedding.** These gates exist so a routine sync or enrich can't run up
an unexpected embedding bill, while never wedging an unattended cron.

**Keyless mode:** if you run with zero provider keys (`gbrain init --no-embedding`,
the keyless bootstrap posture — see `docs/guides/bootstrap.md` and
`docs/operations/headless-install.md`), nothing here can spend and none of these
gates ever fire. This doc applies once you add a key.

## `spend.posture` — one switch for "cost is not my constraint"

```bash
gbrain config set spend.posture tokenmax   # all cost gates become informational
gbrain config set spend.posture gated      # default — gates enforce
```

| Value | Effect |
|-------|--------|
| `gated` (default) | Every cost gate enforces its limit as documented below. |
| `tokenmax` | Every embedding-spend gate in the table below prints its estimate and **proceeds** — informational only. Spend is still recorded to the ledger; posture removes the *ceiling*, not the *accounting*. (Commands with their own LLM cost caps outside this doc's embedding scope — e.g. `extract-conversation-facts --max-cost-usd`, `dream retriage --max-usd` (an estimate-based soft stop) — don't resolve posture; their per-call flags govern.) |

`spend.posture` is deliberately separate from `search.mode=tokenmax` (which governs
retrieval payload size, not embedding spend). When a gate fires and
`search.mode=tokenmax` but `spend.posture` is unset, the gate prints a one-line hint
pointing at this switch.

**Precedence:** an explicit per-call cap (`--max-usd N`, `--max-cost N`) always wins
over posture. `tokenmax` only governs the default/absent case — it never overrides a
number you typed on the command line.

## Off switches (`off` / `unlimited` / `none`)

The USD-limit knobs accept `off`, `unlimited`, or `none` (case-insensitive) to mean
"no limit" — no more setting sentinel values like `100000`.

- `0` is **not** "off". On `sync.cost_gate_min_usd`, `0` means "block on any nonzero
  spend" (a real choice). On the backfill caps, `0` falls back to the default — and on
  `embed.backfill_max_usd` specifically, any present-but-invalid value (`0`, a
  negative, garbage text) is treated as a typo'd cap: the $10 default applies and is
  **never dropped**, even for unpriced models (see "Default caps vs unpriced models"
  below). Only the off tokens (`off`/`unlimited`/`none`, case-insensitive) remove
  that ceiling.
- Internally "no limit" is the string `unlimited` in any printed/JSON output and "no
  cap" inside the budget tracker — never a raw `Infinity` (which would serialize to
  `null` in ledger rows).

## The gates

| Gate | Config key | Default | Blocks? | Off switch | tokenmax |
|------|-----------|---------|---------|-----------|----------|
| Sync inline-embed cost gate | `sync.cost_gate_min_usd` | `0.50` | TTY prompt / non-TTY auto-defer | `off` (or `0` = block-on-any) | informational |
| Backfill 24h per-source spend cap | `embed.backfill_max_usd_per_source_24h` | `25` | refuses submission | `off` (`0` → default) | bypassed (still ledgered) |
| Backfill per-job budget | `embed.backfill_max_usd` | `10` | caps the job's tracker | `off` (`0`/garbage → default, fail-closed) | uncapped (still ledgered) |
| Backfill cooldown | `embed.backfill_cooldown_min` | `10` | skips re-submission inside window | — (latency knob, not spend) | **not** bypassed |
| `reindex-code` cost gate | — (preview before re-embed) | — | TTY prompt / non-TTY refuse + exit 2 | `--max-cost off` | informational |
| `migrate embeddings` consent gate | — (plan + estimate before provider migration) | — | TTY y/N prompt / non-TTY refuse + exit 2 | `--yes` | estimate marked informational, but **still prompts** (guards a destructive schema rebuild, not just spend) |
| `enrich` / `onboard --auto` | `--max-usd` (per-call) | — | refuse without a cap (non-TTY) | `--max-usd off` | runs uncapped (still ledgered) |
| Image-OCR per-run ceiling (#3973) | `embedding_image_ocr_max_images` / `embedding_image_ocr_max_usd` | `200` images / `$1.00` (estimated) | skips OCR over-cap (import continues; skips counted in `ocr_skipped_budget`, surfaced by doctor `ocr_health`) | `0` disables that cap | **not** bypassed (per-run cap, not a tracker gate) |
| Dream `extract_atoms` phase budget | `cycle.extract_atoms.budget_usd` | `0.30` | caps the phase's budget tracker | — | **not** consulted (phase budget enforces regardless) |

The `extract_atoms` cap is enforced only for models in the pricing maps. A model
the tracker cannot price — e.g. a local Ollama model selected via
`models.dream.extract_atoms` — runs without a cost gate after a one-line stderr
warning (a USD cap cannot be enforced on an unpriced model; local models incur
no API spend).

### Sync inline-embed cost gate

Fires only when sync embeds **inline** (federated_v2 off, or `--serial` without
`--no-embed`). Under federated_v2 + parallel, embedding is deferred to capped backfill
jobs and the gate is informational. The estimate prices the **delta** — the files this
sync will actually import (fetched-first, so it sees commits the run is about to pull) —
not the whole tree. A busy brain with a dirty working tree but caught-up commits
estimates `$0`, because an attached-HEAD sync imports only the committed diff by
default. The `--working-tree` / `sync.include_working_tree` opt-in is the one
exception: it imports uncommitted files that the estimator deliberately does not
price (pricing dirty files on every attached repo would bring back the
phantom-cost class the delta estimate exists to kill), so the gate can
underestimate an explicit working-tree run.

Behavior above the floor:
- **TTY:** prompts `[y/N]`.
- **Non-interactive (cron/agent):** **auto-defers** embeds (rows stay stale; exits 0 —
  it never wedges the pipeline). A capped backfill job is submitted only when a
  worker-backed surface exists; otherwise the result reports
  `manual_drain_required` (`reason: no_worker_surface` on PGLite/no-worker setups, or
  `auto_submit_disabled`) with the paste-ready drain command. The backlog drains via
  the jobs worker or `gbrain embed --stale`. Pass `--yes` to embed inline instead.

Output format splits on the explicit `--json` flag: `--json` emits a structured
envelope; otherwise human text. Every gate message carries paste-ready knobs.

`--full` re-embeds the stale backlog inline (full sync sweeps it), so a `--full`
estimate is `delta + stale backlog`, labeled as such.

### Estimate labels

- `~N tokens (delta: changed files since last sync)` — the precise estimate.
- `<=N tokens (full-tree ceiling for K source(s): <reasons> …)` — a conservative
  over-count used only when a precise delta can't be computed: a first sync, a chunker
  version drift (forces a full re-chunk), or git being unavailable. Unchanged files
  still skip via `content_hash` at execution, so the ceiling over-states real spend.

## Notes & limits

- **Pre-pull window:** the gate fetches before estimating, so it prices what the run
  will pull. If a fetch fails (offline), it estimates against local HEAD and labels the
  result; the bounded residual is priced on the next run.
- **Single-source `gbrain sync`** carries the same gate as `sync --all` (it previously
  embedded inline with no preview).
- **Recovery under parallel:** `--skip-failed` / `--retry-failed` work under parallel
  sync (the failure ledger is per-source and lock-serialized) — you no longer have to
  drop to `--serial`, which is what used to arm the inline gate.
- **Chat-side accounting completeness:** query-expansion and image-OCR calls record
  on the ambient budget tracker like every other gateway call, including failed
  attempts (recorded pessimistically). This is record-only — these paths never
  pre-reserve, so a cap breach from them surfaces on the next reserving call.
  Practical effect: capped runs (`--max-cost` and friends) that previously
  under-counted may now hit their ceiling; the new number is the honest one, so
  raise the cap rather than assuming a regression.

## Operator price overrides (`pricing.overrides`)

Cost caps are fail-closed: when `--max-cost` (or a phase's default cap) is set
and a model has no shipped pricing row, the budget tracker aborts with
`no_pricing` rather than pretend the call is free. Proxy routes hit this by
design — a LiteLLM endpoint can front a paid provider, so `litellm:*` models
are deliberately absent from both the pricing tables and the free-local sets.

Declare your real rate in the config plane instead:

```bash
# Scalar = one USD-per-1M-token rate for input AND output (natural for embeddings):
gbrain config set pricing.overrides '{"litellm:text-embedding-3-large": 0.13}'

# Object form for chat models with distinct input/output rates:
gbrain config set pricing.overrides \
  '{"litellm:gpt-4o": {"input": 2.5, "output": 10}, "litellm:text-embedding-3-large": 0.13}'
```

Semantics:

- Keys are full `provider:model` strings (case-insensitive, exact match).
- Overrides win over shipped tables — you own your bill (negotiated rates,
  markup-charging proxies).
- Models with neither a table row nor an override stay fail-closed under a cap.
- Invalid entries (negative, non-numeric) are dropped; those models keep the
  fail-closed behavior.
- Consumed by `BudgetTracker` construction; both chat and embed routes price
  through it. The key is registered in `KNOWN_CONFIG_KEYS`, and it is loaded
  automatically by enrich and the cycle's `enrich_thin` phase, the
  `embed-backfill` job handler, and every conversation-facts entry point
  (`gbrain extract-conversation-facts`, the cycle's
  `conversation_facts_backfill` phase, transcript facts ingest) — an override
  declared once in config reaches the queued/background lanes too, not just
  interactive enrich.

### Default caps vs unpriced models (embed backfill)

The `embed-backfill` job's per-job cap defaults to $10 — an IMPLICIT ceiling
nobody chose. When the configured embedding model has no shipped pricing row
and no `pricing.overrides` entry (the `isModelPriceable` contract), enforcing
that implicit cap would fail-close every job for a model that may well be
free or self-hosted. So the handler drops the DEFAULT cap and runs uncapped,
with a stderr warning naming both fixes (add a `pricing.overrides` entry, or
set `embed.backfill_max_usd` to an explicit number). An EXPLICIT cap is a
different contract: you chose a ceiling, so an unpriced model stays
fail-closed (`no_pricing`) — declare the model's rate in `pricing.overrides`
to proceed. Spend is ledgered by the tracker either way; only the ceiling
changes.

A present-but-unparsable value is a third contract, and it is fail-closed:
when `embed.backfill_max_usd` is SET but not a positive number (`"ten"`, `0`,
a negative), the operator clearly intended a cap, so the $10 default applies
and is NEVER dropped — even for unpriced models — with a stderr warning
naming both fixes (correct the value, or set it to `off` to remove the
ceiling). A typo must not silently degrade to uncapped spend.

## Escape hatches at a glance

```bash
# Never gate this brain on cost:
gbrain config set spend.posture tokenmax

# Widen the sync inline floor to $5:
gbrain config set sync.cost_gate_min_usd 5

# Disable the sync inline floor entirely:
gbrain config set sync.cost_gate_min_usd off

# Lift the backfill 24h spend cap:
gbrain config set embed.backfill_max_usd_per_source_24h off

# Run enrich uncapped non-interactively:
gbrain enrich --max-usd off        # or: gbrain config set spend.posture tokenmax
```
