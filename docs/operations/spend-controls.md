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
| `tokenmax` | Every embedding-spend gate in the table below prints its estimate and **proceeds** — informational only. Spend is still recorded to the ledger; posture removes the *ceiling*, not the *accounting*. (Commands with their own LLM cost caps outside this doc's embedding scope — e.g. `extract-conversation-facts --max-cost-usd`, `dream retriage --max-usd` (an estimate-based soft stop), `facts relink --max-usd` (default $1.00; its free tiers and moved rows spend nothing), the automatic facts drain (`facts.drain_budget_usd` $1.00 per run, `facts.drain_daily_budget_usd` $5.00 per rolling day; [guide](../guides/facts-drain.md)) — don't resolve posture; their per-call flags govern.) |

`spend.posture` is deliberately separate from `search.mode=tokenmax` (which governs
retrieval payload size, not embedding spend). When a gate fires and
`search.mode=tokenmax` but `spend.posture` is unset, the gate prints a one-line hint
pointing at this switch.

**Precedence:** an explicit per-call cap (`--max-usd N`, `--max-cost N`) always wins
over posture. `tokenmax` only governs the default/absent case — it never overrides a
number you typed on the command line.

## Consent and caps for paid commands (agent operator contract v1)

Every command that spends money asks for authorization the
same way ([protocol](../protocol/AGENT_OPERATOR_v1.md#consent-and-preapproval)).
Without a terminal and without authorization, nothing runs: the command exits
3 with a `confirmation_required` payload whose `user_message` the agent relays
to the user, and whose `fix` is the exact command to run once they agree.
`--json` never implies consent.

What authorizes paid work, and the cap it runs under:

| Authorization | Cap | `cap_source` |
|---|---|---|
| `--max-usd <n>` / `--max-cost <n>` | `<n>` | `user` |
| a configured cap for the command (for example `embed.backfill_max_usd`) | that value | `user` |
| the user's preapproval `consent.preapprove.paid.max_usd_per_run <usd>` (covers runs whose estimate is at or under it) | the preapproved limit | `user` |
| `--yes` alone | the estimate × 1.5, floor $0.25, printed before the run | `derived` |
| `--yes` alone, no estimate and no configured cap | the default cap ($5), printed | `default` |
| `spend.posture=tokenmax` | the derived/default cap above, except `enrich` and `reindex-code` (below) | `derived` / `default` |

- **`tokenmax` on `enrich` and `reindex-code` is uncapped.** On those two
  commands `spend.posture=tokenmax` means no ceiling: an unattended run
  proceeds uncapped (spend still ledgered). Everywhere
  else `tokenmax` authorizes the run under the derived cap. An explicit
  `--max-usd` always wins.
- **A derived cap that runs out** stops the command with exit 1, a checkpoint
  and the exact resume command (`--max-usd <n>`); doctor's `agent_contract`
  check then suggests the preapproval command. Raise the cap only with the
  user's agreement.
- **Unpriced models** (a model gbrain has no per-token rate for, for example
  a newly released one): under a derived or default cap the run
  **warns and proceeds** (`BUDGET_TRACKER_NO_PRICING` on stderr; the cap
  cannot meter it). Under a cap the user set (`--max-usd`, a configured cap
  or a preapproval) it **blocks** with `no_pricing` and nothing is spent: the
  refusal's `fix` has `inputs` telling the agent to look up the model's
  per-token rates (for example by web search on the provider's pricing page)
  and register them with `gbrain pricing set` (see
  [Registering a model price](#registering-a-model-price)), then retry the
  same command.

## Queued paid work

Paid commands that queue jobs carry the approval onto the jobs, and the
worker enforces it:

| Producer | Jobs | Basis stored | Budget the worker enforces |
|---|---|---|---|
| `book-mirror` | one `subagent` per chapter | `authorized`, one group | the approved total, shared by the chapters |
| `enrich --background` (Postgres) | one `enrich` per source | `authorized`, one group | the approved total, shared by the sources |
| `jobs submit enrich\|subagent` | one | `authorized` | the approved cap |
| jobs of those commands queued before submit-time authorization | as above | `legacy_default`, one group per job | `enrich`: the job's `--max-usd`, else $5; `subagent`: $5 |
| everything else (`agent run`, MCP `submit_agent`/`submit_job`, `doctor --remediate`, autopilot and dream phases, `skillopt`, `import`, `reindex`, `sync`, embedding backfills) | various | none (`unrecorded`) | the producer's own budget: client daily budget, cycle budget, embedding caps, write-path embedding as configured, `--max-usd` for remediation |

Each provider attempt reserves its maximum cost against the group in the
durable spend meter and settles its measured usage; an attempt that never
reports usage stays charged. When other jobs' attempts are in flight the job
waits (delayed, no attempt burned, at most 6 times); when settled spend
reaches the cap the job dies with `derived_cap_exhausted` or
`cost_cap_exceeded`, the group amounts and the rerun command. `--max-usd off`
(or `spend.posture=tokenmax` on `enrich`) stores an uncapped approval: nothing
is reserved and spend is still ledgered. Group controls:
`gbrain jobs list --group <id> --json`, `gbrain jobs cancel --group <id>`.

Spend-authorized jobs need upgraded workers: an older worker cannot claim
them (and stops claiming at the first one in its queue order), so restart
every worker after upgrading. Rolling the binary back leaves those queued rows
unclaimable; cancel them first (`gbrain jobs cancel --group <id>`).

## Off switches (`off` / `unlimited` / `none`)

The USD-limit knobs accept `off`, `unlimited`, or `none` (case-insensitive) to mean
"no limit", so no sentinel value like `100000` is needed.

On the command line, `--max-usd off` is the canonical way to run uncapped.
`brainstorm`, `lsd`, `skillopt`, `enrich`, `onboard` and `eval longmemeval`
parse their cap flag through one parser (`src/core/budget/cap-flag.ts`), so
the rules match everywhere:

| Command | Canonical | Legacy spellings still accepted |
|---|---|---|
| `brainstorm`, `lsd` | `--max-usd N\|off` | `--max-cost N\|off` |
| `skillopt` | `--max-usd N\|off` | `--max-cost-usd N` (`0` = uncapped, deprecated), `--no-max-cost` |
| `enrich` | `--max-usd N\|off` | `--max-cost-usd N\|off` |
| `onboard`, `eval longmemeval` | `--max-usd N\|off` | none |

A malformed value, a bare `0` (ambiguous: free or uncapped?) and two cap flags
that disagree are refused before any paid call. `eval longmemeval --max-usd 0`
keeps its meaning, a $0 judge cap. Runtime, call and token bounds stay in
force when the USD cap is off. `brainstorm`, `lsd` and `skillopt` print one
line naming the cap, its source and how to remove it, e.g.
`cap: $5.00 (default; change it with --max-usd <usd>, remove it with --max-usd off)`.

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
| `reindex-code` cost gate | — (preview before re-embed) | — | TTY prompt / non-TTY refuse + exit 3 (`confirmation_required`) | `--max-cost off` | runs uncapped (still ledgered) |
| `migrate embeddings` consent gate | — (plan + estimate before provider migration) | — | TTY y/N prompt / non-TTY refuse + exit 3 (`confirmation_required`) | `--yes` | estimate marked informational, but **still prompts** (guards a destructive schema rebuild, not just spend) |
| `enrich` / `onboard --auto` | `--max-usd` (per-call) | — | non-TTY without `--yes`/`--max-usd`: refuse + exit 3 (`confirmation_required`); `--yes` runs under the derived cap | `--max-usd off` | runs uncapped (still ledgered) |
| Image-OCR per-run ceiling | `embedding_image_ocr_max_images` / `embedding_image_ocr_max_usd` | `200` images / `$1.00` (estimated) | skips OCR over-cap (import continues; skips counted in `ocr_skipped_budget`, surfaced by doctor `ocr_health`) | `0` disables that cap | **not** bypassed (per-run cap, not a tracker gate) |
| Dream `extract_atoms` phase budget | `cycle.extract_atoms.budget_usd` | `0.30` | caps the phase's budget tracker (one tracker per drain attempt, across all its batches) | — | **not** consulted (phase budget enforces regardless) |
| Atom auto-drain daily cap | `autopilot.auto_drain.max_usd_per_day` | `2.00` | daily cap on drain **attempts** (`floor(max / 0.30)` = 6), not a dollar ledger | `gbrain config set autopilot.auto_drain.enabled false` | **not** consulted |
| Connector email/meeting atoms | `cycle.extract_atoms.connector_pages` | on (unset) | Gmail/Calendar `email`/`meeting` pages are extracted like other pages, under the auto-drain cap | `false` | **not** consulted |
| Life Chronicle event extraction | `chronicle.job_budget_usd` (per page) / `chronicle.auto_daily_limit` (calls per rolling 24 h) | `0.25` / `200` | caps one extraction call; past the daily limit pending pages wait for a free slot | `gbrain config set auto_chronicle false` | **not** consulted |
| [Fence model repair (Tier 3)](#fence-model-repair-tier-3) | `fences.repair.max_usd_per_page` / `fences.repair.max_usd_per_day` | `0.30` / `1.00` | refuses the call: a page whose estimate is over the per-page cap or over today's remainder in the durable USD ledger (`llm_repair`/`fences`, per UTC day across every process) waits as `budget_exhausted`, and `gbrain repair fences --apply` stops there with exit 1. `--max-usd <n>` lowers a run's cap, never raises it | `gbrain config set fences.repair.llm false` (`0` on a cap = no model spend) | **not** consulted |
| Dream `synthesize` per-run budget | `dream.synthesize.budget_usd` | `5` | defers the transcript and the rest of the run before submission (estimate: prompt size + child output cap, x `max_turns` in agentic mode) | `unlimited` (`0` = submit nothing) | **not** consulted |
| Dream `synthesize` daily submission cap | `dream.synthesize.max_submissions_per_source_per_day` | `0` (off) | skips whole files; a failed count query submits nothing that run | `0` | **not** consulted |
| Dream `BudgetMeter` phases (auto_think, drift, propose/grade takes, calibration) | `dream.auto_think.budget`, `dream.drift.budget`, `cycle.<phase>.budget_usd` | per phase | refuses the next submit past the cap | `unlimited` (`0` = spend nothing) | **not** consulted |

Dream `BudgetMeter` phases meter a model missing from the pricing table at a
Sonnet-tier fallback rate instead of letting it run uncapped; local model
servers (Ollama, LM Studio, llama-server) count as $0. Set
`dream.budget.allow_unpriced=true` to let unpriced models bypass the meter.

The `extract_atoms` cap is enforced only for models in the pricing maps. A model
the tracker cannot price — e.g. a local Ollama model selected via
`models.dream.extract_atoms` — runs without a cost gate after a one-line stderr
warning (a USD cap cannot be enforced on an unpriced model; local models incur
no API spend).

### Fence model repair (Tier 3)

**Say to your agent:** *"How much did fence repair spend today?"* or *"Stop
paying a model to repair my facts tables."*

The maintenance run's `fence_repair` phase and `gbrain repair fences --apply`
send a malformed facts or takes fence that only a rewrite can realign to the
repair model. Only the fence header and the rows it must realign leave the
machine, never valid rows or the rest of the page. Every other fence repair
is free.

- **Model.** `models.fence_repair` when set (any model, priced or not, always
  runs). Unset, the first model the fence-repair eval measured as accurate
  enough whose provider key the brain has: `openai:gpt-6.1-sol` with an
  OpenAI key, else `anthropic:claude-opus-5-5` with an Anthropic key
  (`anthropic:claude-fable-5-1` also met the bar). With neither key, model repair is off by
  default and those fences wait as `no_measured_model`; choosing a model is
  the user's call.

- **Ledger.** Each call reserves its estimate in the durable daily USD ledger
  before it is sent and settles the measured cost after. Failed and retried
  calls settle against it too, and a call whose usage is unknown is charged
  its reserved maximum. The ledger is per UTC day and shared by every process
  on the brain (the maintenance cycle and the CLI), so concurrent runs never
  exceed the cap together. When the ledger cannot be read, no call is made
  (`ledger_unavailable`).
- **Caps.** `fences.repair.max_usd_per_page` (default $0.30) and
  `fences.repair.max_usd_per_day` (default $1.00), validated at
  `config set`; `0` means no model spend. A call's estimate is its worst
  case: the prompt plus the full output ceiling, which leaves a reasoning
  model 2,048 tokens to think before it writes the table. The per-page
  default covers the worst case of every measured model for the largest
  page in the eval (`anthropic:claude-fable-5-1`, two fences, $0.27); measured
  spend per model repair was about $0.003 (`openai:gpt-6.1-sol`), $0.008
  (`anthropic:claude-opus-5-5`) and $0.02 (`anthropic:claude-fable-5-1`). A page over either cap waits as
  `budget_exhausted`; `gbrain repair fences --apply` stops with exit 1,
  naming the spend, the cap, the reset time (next 00:00 UTC) and the pages
  waiting. Raising a cap is the user's call.
- **`--max-usd <n>`** on `gbrain repair fences` lowers the cap for that run
  below today's remainder and never raises it; `--no-llm` keeps a run to the
  free tiers. `gbrain doctor --remediate --max-usd <n>` passes what is left of
  its allowance to the fences step.
- **Off switches.** `gbrain config set fences.repair.llm false` stops model
  repair everywhere; those fences wait as `llm_disabled` while the free
  tiers keep running. `gbrain config set fences.repair.enabled false` pauses
  the maintenance phase (an explicit `gbrain repair fences --apply` still
  runs).
- **`spend.posture` is not consulted.** `tokenmax` neither lifts these caps
  nor skips the ledger.
- **Unpriced models.** Under the default caps, a repair model gbrain has no
  price for still runs: each call is metered at an estimated ceiling, the
  highest chat rate in the canonical price table, and the run carries a
  notice naming `gbrain pricing set` to make the metering exact. When the user
  set either cap, it is refused with `no_pricing` and the pricing guidance
  instead ([registering a model price](#registering-a-model-price)), and
  nothing is sent.

`gbrain doctor --only fence_integrity` shows both caps and today's spend.

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

### Atom extraction: auto-drain cap and connector pages

**Say to your agent:** *"Extract atoms from my Gmail and Calendar pages too"* or
*"Stop spending on automatic atom extraction."*

When the active schema pack does not run `extract_atoms` in the routine cycle,
autopilot (Postgres brains) submits a bounded `extract-atoms-drain` job per
source with a backlog. Each drain **attempt** runs under one BudgetTracker
capped at `cycle.extract_atoms.budget_usd` ($0.30 by default), shared by all of
its batches. The daily cap `autopilot.auto_drain.max_usd_per_day` ($2.00) is a
count of attempts at that per-attempt estimate (6 a day), so a retried job
uses one slot per attempt. A job refused before any model call (no active
canonical owner on this host, untrusted caller) dead-letters once with
`structural_refusal:` and uses no slot; autopilot also skips a source whose
writer would refuse, and logs why. Checkout-backed and connector sources take
turns for the daily slots. With a model the tracker cannot price (the
extraction chat model or the embedding route), the default dollar limit is not
enforced and the phase warns and runs; only the attempt count bounds the drain.
When you set `cycle.extract_atoms.budget_usd` yourself, an unpriced model
instead stops the run before any model call: the phase reports `warn` with
`details.no_pricing` (model, provider, kind, units, `register_command`), the
stop counts as an expected limit rather than a halt in `extract_health`, and
`gbrain doctor` names the command until you register the price with
`gbrain pricing set` (see [registering a model price](#registering-a-model-price)).

Connector pages are extracted by default. Gmail threads (`email`) and
Calendar events (`meeting`) from a Google or GitHub connector source go
through atom discovery, the backlog count, the routine cycle,
`gbrain dream --drain` and the auto-drain like any other page, under the caps
above. To keep them out:

```bash
gbrain config set cycle.extract_atoms.connector_pages false   # opt out
gbrain config unset cycle.extract_atoms.connector_pages       # back to the default (on)
gbrain config set autopilot.auto_drain.enabled false          # stop all automatic atom drains
```

What leaves the machine while it is on: the page text of each extracted email
thread or calendar event (message bodies, subjects, participants as rendered on
the page, up to `cycle.extract_atoms.max_input_chars`) is sent to the
configured `extract_atoms` chat model (`models.dream.extract_atoms`, a
utility-tier model by default), under the caps above. Atoms already extracted
stay; opting out only stops new extraction.

### Life Chronicle: automatic event extraction

**Say to your agent:** *"How much does automatic event extraction cost?"* or
*"Turn off automatic event extraction."*

`auto_chronicle` is on by default. Each eligible new or changed meeting,
conversation or calendar page gets one chat call that turns it into timeline
events, capped at `chronicle.job_budget_usd` ($0.25) per page. At most
`chronicle.auto_daily_limit` (200) automatic calls run per rolling 24 hours;
retries count, and pages past the limit wait for a free slot. The worst case
is the product, $50 a day at the defaults, for a priced model. With a model the
tracker cannot price, the default cap is not enforced: extraction warns and
runs, bounded only by the call count. When you set `chronicle.job_budget_usd`
yourself, an unpriced model refuses with `no_pricing` until you register its
price with `gbrain pricing set`. `gbrain chronicle-backfill` (history, on
request) is exempt from the daily limit and bounded by its `--limit`;
`--max-usd` adds a hard spend bound that counts retries (an unpriced model then
refuses with `no_pricing`; see the
[chronicle guide](../guides/life-chronicle.md#bound-the-spend-with---max-usd)).

```bash
gbrain config set auto_chronicle false              # opt out
gbrain config set chronicle.auto_daily_limit 50     # fewer automatic calls per day
gbrain config set chronicle.job_budget_usd 0.10     # lower per-page cap
```

`gbrain doctor` (`auto_chronicle`) reports 24 h use of the limit, the largest
writer's share and 7-day spend. Details: [Life Chronicle](../guides/life-chronicle.md).

## Notes & limits

- **Pre-pull window:** the gate fetches before estimating, so it prices what the run
  will pull. If a fetch fails (offline), it estimates against local HEAD and labels the
  result; the bounded residual is priced on the next run.
- **Single-source `gbrain sync`** carries the same gate as `sync --all`.
- **Recovery under parallel:** `--skip-failed` / `--retry-failed` work under parallel
  sync (the failure ledger is per-source and lock-serialized), so recovery never
  requires dropping to `--serial` (which would arm the inline gate).
- **Chat-side accounting completeness:** query-expansion and image-OCR calls record
  on the ambient budget tracker like every other gateway call, including failed
  attempts (recorded pessimistically). This is record-only — these paths never
  pre-reserve, so a cap breach from them surfaces on the next reserving call.
  Practical effect: capped runs (`--max-cost` and friends) count these calls
  toward their ceiling; a run that hits its cap needs a higher cap, not a bug
  report.

## Dream paid-loop breaker (`dream.breaker.max_dead_submissions`)

Dream synthesize and patterns pay a model for each transcript or reflection set
they submit. Without a limit, an input that keeps failing would be paid for
again on every cycle. The breaker stops that: once one dream key has died 3
times within 24 hours, dream refuses to submit it again until you reset it. The refusal shows up
in the cycle summary and the autopilot log with the exact reset command, and
`gbrain doctor` reports it as `dream_paid_loop`.

**Say to your agent:** *"Is dream re-billing the same transcripts?"* or
*"Reset the dream key that keeps failing once you've fixed it."*

```bash
gbrain dream reset-key --list                    # tripped keys, counts, reset commands
gbrain dream reset-key 'dream:synth-v2:...'      # re-enable one key (persists across restarts)
gbrain config set dream.breaker.max_dead_submissions 5   # raise the limit; 0 disables
```

- A submission is one run of a key: the chunks of one transcript in one run count
  once. Only jobs that ended dead count; completed jobs, including a legitimate
  answer that wrote nothing, never do.
- The check happens before synthesis submission. Transcript triage for that run may
  already have happened, so the promise is "no synthesis submission", not "no
  model call at all".
- Not covered: a transcript that keeps growing gets a new content-hashed key each
  cycle, and patterns runs outside maintenance carry no key.
- If the count query fails, the breaker is skipped for that run with a warning, the
  same posture as the synthesize daily cap.

## Operator price overrides (`pricing.overrides`)

Under a cost cap you set (`--max-cost`, `--max-usd`, `--max-cost-usd`, or an
explicit cap in config), a model with no shipped pricing row stops the run
with `no_pricing` rather than pretend the call is free. A cap gbrain applied by
default does not: an unpriced model warns and runs, so a newly released model
always works. Proxy routes hit the explicit-cap refusal by design: a LiteLLM
endpoint can front a paid provider, so `litellm:*` models are deliberately
absent from both the pricing tables and the free-local sets.

`brainstorm` / `lsd` and `skillopt` follow the same rule. With no cap flag the
$5 default is a default cap: an unpriced model warns and runs, priced calls
in the same run stay metered, and brainstorm's estimate, mid-run and pre-judge
checks count the unpriced model at Sonnet rates so an oversized run still
stops. With `--max-usd N` a run that would call an unpriced chat, judge or
embedding model is refused before any work (skillopt: before any spend, in the
preflight). The skillopt preflight never invents a rate: an unpriced model
shows `Est. cost: unpriced (...)`. `brainstorm_health` in `gbrain doctor`
names an unpriced brainstorm chat or judge model.

Shipped rates are list rates. DeepSeek bills half its peak rate off-peak;
gbrain's DeepSeek rows are the peak rate so caps bound the worst case, and
estimates that use them say `(DeepSeek at peak rates, an upper bound)`.

Every model a recipe lists is either priced or declared in the recipe's
`unpriced_models`; `bun run check:recipe-pricing` enforces it in CI.

### Registering a model price

The `no_pricing` refusal tells the agent what to do: look up the provider's
current price for the model (for example, search the web for its pricing
page), register it, and retry. The refusal text and its JSON fields
(`model`, `provider`, `kind`, `units`, `lookup`, `register_command`,
`register_scope`, `docs`) carry the exact command:

```bash
# Chat models: USD per 1M input tokens and per 1M output tokens.
gbrain pricing set litellm:gpt-4o --input 2.5 --output 10 \
  --source https://example.com/pricing

# Embedding and reranker models: one USD-per-1M-token rate.
gbrain pricing set litellm:text-embedding-3-large --rate 0.13

gbrain pricing list            # what is registered, with source and date
gbrain pricing unset litellm:gpt-4o
```

- `pricing set` and `pricing unset` change one entry and keep every other
  entry in `pricing.overrides`. (`gbrain config set pricing.overrides '<json>'`
  still works, but it replaces the whole value.)
- Rates must be non-negative finite numbers; anything else is refused and
  nothing is written. An unreadable stored value is left unchanged and the
  command refuses rather than overwrite it.
- `--source` and the registration time are stored beside the rates
  (`source`, `set_at`) for provenance. Cost caps ignore them.
- **$0 is allowed, with a warning.** The operator decides; $0 is right for a
  local or flat-rate route. Every call to that model then counts as free
  against every cost cap.
- **Registration is trusted-local only.** `gbrain pricing` is a CLI-only
  command on the brain host, never an MCP operation, and a thin client
  refuses it. Otherwise a remote agent could register $0 and void the cap.
  An agent connected over MCP that meets `no_pricing` looks the price up and
  asks the brain's operator to run the command the refusal names.

The raw config shape, for reference:

```bash
# Scalar = one USD-per-1M-token rate for input AND output (natural for embeddings):
gbrain config set pricing.overrides '{"litellm:text-embedding-3-large": 0.13}'

# Object form for chat models with distinct input/output rates
# (pricing set also writes source and set_at beside them):
gbrain config set pricing.overrides \
  '{"litellm:gpt-4o": {"input": 2.5, "output": 10}, "litellm:text-embedding-3-large": 0.13}'
```

Semantics:

- Keys are full `provider:model` strings (case-insensitive, exact match). An
  override keyed by a model alias also prices the id the provider serves for it.
- **Provider wildcard (subscription providers only).** `<provider>:*` prices
  every model of a provider whose recipe bills by subscription, today only
  `claude-cli`: `gbrain pricing set 'claude-cli:*' --rate 0`. Precedence is
  exact model entry, then the wildcard, then the shipped tables. This is a
  cap bypass by design: at $0 every claude-cli call counts as free against
  every cap, including models gbrain ships a rate for. It is an operator
  assumption, labelled as such by `gbrain pricing list`, which also names the
  models the wildcard prices. A bare `*` and a wildcard on a per-token API
  provider (`openai:*`) are refused by `pricing set` and ignored if written
  into the config directly.
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
with a stderr warning naming both fixes (register its price with `gbrain pricing set`, or
set `embed.backfill_max_usd` to an explicit number). An EXPLICIT cap is a
different contract: you chose a ceiling, so an unpriced model stays
fail-closed (`no_pricing`) — register the model's rate with `gbrain pricing set`
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

## CRAG knobs (both default OFF)

`search.crag_think` runs `think` (an LLM call) on weak-graded LOCAL queries —
it is fail-closed for remote callers. `search.crag_escalation` triggers a
high-ceiling retrieval re-run with `expansion=true` (one LLM multi-query call)
per weak-graded query and IS reachable by remote MCP callers once the operator
enables it — attacker-shaped weak queries drive that spend. Both respect
`spend.posture`; leave them off unless you accept per-weak-query LLM cost.
