# System One: fast typed decisions inside your brain

GBrain makes many small judgment calls on every search and every dream
cycle: is this result evidence for the question, is this transcript worth
synthesizing, does this new fact contradict an old one. Today each call is a
hand-written rule or a full chat-model call. System One lets a decision model
make those calls instead. It answers with a probability or a labelled choice,
and GBrain's code owns every threshold, floor and fallback.

The first provider is TypeSafe's Jev (under a second per request, $0.042 per
million input tokens, output free). Any chat model you already configured can
answer the same questions through an `llm:` provider. Setup for the key and
the reranker: [TypeSafe (Jev)](../ai-providers/typesafe.md). Contract for
contributors: [`docs/architecture/decide.md`](../architecture/decide.md).

Every decision point is a **slot**. Each slot is **off** (today's behavior)
or **on** (GBrain acts on the decision). Without a TypeSafe key every slot is
off, nothing is sent anywhere, and output is byte-identical to a brain
without System One.

## Defaults: on with a key for what measurably helps

With a TypeSafe key installed (`TYPESAFE_API_KEY` or `JEV_TYPESAFE_API_KEY`,
in your shell or `~/.gbrain/.env`), the two slots with a measured win are on
by default: **dream triage** (`triage`) and **contradiction proposals**
(`conflict`). They use the pinned `typesafe:jev-1.13.0` and their shipped
reference calibrations. The other seven slots stay off, because on our eval
sets they either did not help or could not pass the safety gate
([`docs/eval/system-one/`](../eval/system-one/)). The default-on set is
exactly the set `gbrain decide enable --recommended` turns on; both come
from the same reference calibration rows.

What that sends to TypeSafe: transcript windows (conversation text) when a
dream cycle triages, and fact text when the contradiction sweep runs after
`extract_facts`. For these two slots only, the key counts as your opt-in for
that data, including private conversations and private facts. Private and
derived pages are never sent by these slots, and `decide.egress.deny_sources`
still applies. Nothing is written to your config: `gbrain decide status`
shows `on (default: Jev key present)` and the opt-out on the next line.

What it costs: in our end-to-end run, dream spend went from $1.50 to $2.60
(+73%), because triage also synthesizes about a third of routine chats while
catching every buried decision. The sweep costs about $0.00002 per fact. The
daily cap (`decide.budget.daily_usd`, $1.00) applies.

To opt out, any explicit setting wins:

```bash
gbrain decide disable triage            # or: gbrain decide disable conflict
gbrain decide disable --all             # every slot off
gbrain config set decide.egress.private deny   # no default slot sends private data
gbrain config set decide.provider none         # no decide slot runs at all
```

A slot's own mode or provider, or a `deny` on its consent key
(`decide.egress.typesafe.conversation` for triage,
`decide.egress.typesafe.facts` for the sweep), also turns its default off.
Eval commands never use these defaults; their arms set every slot.

## Quickstart

You need a TypeSafe key ([console.typesafe.ai](https://console.typesafe.ai)).
Getting one is not included in the timing below and has not been measured.
From a key in hand, the probe takes under a minute and the whole block a few
minutes. The first probe sends nothing from your brain.

<!-- system-one-quickstart:begin -->
```bash
export TYPESAFE_API_KEY=<your-key>
gbrain decide probe
gbrain decide probe --query "When does Acme Example ship the beta?"
gbrain decide status
gbrain decide enable --recommended
```

Example output from a three-page brain (your latency, cost, pages and
probabilities will differ; `...` marks lines left out here):

```console
$ gbrain decide probe
TypeSafe Jev probe: resolved jev-1.13.0 (requested typesafe:jev-1.13.0) in 439 ms, 383 input tokens, $0.000016.
Key: TYPESAFE_API_KEY. No brain content was sent.
Next: gbrain decide probe --query "<a question your brain can answer>"
$ gbrain decide probe --query "When does Acme Example ship the beta?"
This sends your query and 2 result snippet(s) to TypeSafe (typesafe:jev-1.13.0) once; 1 private result(s) stay local. Nothing is changed or stored.
Jev jev-1.13.0: 260 ms, $0.000019. Probability = evidence probability; Jev rank = its rerank order.
today  jev  probability  slug
    1    2       0.08  meetings/2026-09-22-weekly-sync
    2    1       0.93  notes/launch-plan
    3    -    private  notes/board-prep
Next: gbrain decide status   (with a key, the slots with a measured win are on by default)
$ gbrain decide status
System One (decide): provider none; key: TYPESAFE_API_KEY
egress: private=deny; consent query=deny candidates=deny facts=deny conversation=deny; deny_sources: none; fallback: none; key default allows: triage (conversation), conflict (facts)
...
  triage         on (default: Jev key present) threshold 0.770 (reference ref:triage-jev-1.13.0-2026-09-30) ~$2.0227/1k transcripts (estimate)
    on by default because a TypeSafe key is present (sends conversation text to TypeSafe); opt out: gbrain decide disable triage
...
  conflict       on (default: Jev key present) threshold 0.520 (reference ref:conflict-jev-1.13.0-2026-09-30) ~$0.1618/1k swept facts (estimate)
    on by default because a TypeSafe key is present (sends fact text to TypeSafe); opt out: gbrain decide disable conflict
$ gbrain decide enable --recommended
triage: already on (default: Jev key present); nothing written. Opt out: gbrain decide disable triage
conflict: already on (default: Jev key present); nothing written. Opt out: gbrain decide disable conflict
```
<!-- system-one-quickstart:end -->

What each step shows:

1. `probe` checks the key with a fixed sentence and names the model version
   that answered. It prints the next command.
2. `probe --query` runs today's search on your brain with every slot off,
   then asks Jev once, in one request, for each result's evidence
   probability and its rerank order, and prints them beside today's order.
   It tells you what it will send and asks first (add `--yes` in scripts).
   Private pages stay local. It changes nothing and stores nothing. In the
   example, today's search ranks a meeting that repeats the question first,
   and Jev ranks the note with the answer first.
3. `status` shows each slot's readiness. With the key in place, dream
   triage and the contradiction sweep show `on (default: Jev key present)`
   (see [Defaults](#defaults-on-with-a-key-for-what-measurably-helps)) and
   name their opt-out. `ready for on` means `enable` would succeed now;
   `needs calibration` means the slot needs a calibration before it can act.
4. `enable --recommended` turns on exactly the slots that have a recorded
   eval win for your model and a reference calibration that passes the
   precision gate: dream triage and the contradiction sweep for
   `jev-1.13.0`. When they are already on by default it says so and writes
   nothing. It matters when an explicit setting turned a default off: both
   slots read private data, so with `decide.egress.private deny` set it
   refuses them, names the missing key and changes nothing. Allow it with
   `gbrain config set decide.egress.private allow` and run the command again,
   or route those slots to an `llm:` provider. When no slot qualifies for
   your model, it says so and exits non-zero. Turn one slot on yourself with
   `gbrain decide enable <slot>` (see [Turning a slot on](#turning-a-slot-on)).

A CI test (`test/decide/quickstart-doc.serial.test.ts`) runs this block
against a seeded brain with a fixture transport and checks every output line
above, so the block and the CLI cannot drift apart.

## The slots

Plain names are what `status` and the CLI print. `gbrain decide status`
marks any slot your binary does not include with `(not available in this
build)`, and `enable` refuses it with `slot_unavailable`.

| Slot | Plain name | When on, GBrain... | If Jev fails or is late | Data it sends |
|---|---|---|---|---|
| `rerank` | search reranking | orders search candidates by Jev's relevance score | keeps the fused (RRF) order | query, candidate text |
| `intent` | query routing | picks the query intent (entity, temporal, event, concept, general) when Jev is confident | uses the regex classifier | query |
| `evidence` | evidence gate | drops search results Jev says carry no evidence for the question | keeps every result | query, candidate text |
| `answerable` | abstention | lets `think` say "the brain has no evidence for this" instead of synthesizing | answers normally | query, candidate text |
| `injection` | injection signal | moves results that look like instructions to an AI agent below clean ones and marks them in `think` | no demotion | query, candidate text |
| `recall_needed` | know-to-ask | fires retrieval for prompts the reflex rules miss, and skips it when memory is clearly not needed | the reflex result stands | conversation text |
| `triage` | dream triage | decides which transcripts are worth synthesizing | today's triage path | conversation text |
| `grounding` | claim support | quarantines dream claims their sources do not support | keeps the mechanical verification result | conversation text |
| `conflict` | contradiction | proposes supersedes for facts that contradict older ones, for you to accept | no proposal; the fact stays as written | fact text |

### search reranking (`rerank`)

The Jev reranker from #5178, running on the decide core. Voyage stays the
default reranker. `gbrain decide enable rerank` sets
`search.reranker.model typesafe:jev-1.13.0` and `search.reranker.enabled
true`, and remembers what they were; `gbrain decide disable rerank` restores
them. Rerank has no threshold and no calibration, so it can be `ready for
on` with only a key. The reranker selection is your consent for query and
candidate text, as it is for Voyage. Details, scoring rubric and caveats:
[TypeSafe (Jev)](../ai-providers/typesafe.md#reranker-setup).

### query routing (`intent`)

One choice question per query, asked at the start of search and waited on
for at most `decide.slots.intent.wait_ms` (250 ms). A confident answer
replaces the regex intent, which drives the existing intent weights and
detail level. `think` asks a second question (`temporal`,
`knowledge_update`, `other`) that gates trajectory injection. A late or
unsure answer uses the regex label. Routing never forces a retrieval arm.

### evidence gate (`evidence`)

After fusion and rerank, one packed request asks, for each of the first 50
candidates, "does this candidate contain evidence that helps answer the
query?". Candidates under the threshold are removed, with three guarantees:
never fewer than `min_keep` results (default 3), never a protected result
(alias hit, exact lookup, exact title match, pinned graph answer), and never
a reorder. Answers close to the threshold keep the result (`margin_hold`).
It runs on every hybrid and keyword-only search, which includes `query` and
the searches `think` runs to gather evidence. This slot can remove content,
so it needs a qualified calibration before it can be on.

### abstention (`answerable`)

For `query`, a diagnostic only: `meta.answerability` reports the probability
that the results can answer the question, and nothing is withheld. For
`think`, one question over the exact evidence `think` would synthesize from.
When the probability is under the threshold and a deterministic signal agrees
(no identity-evidence hit and no strong CRAG grade), `think` answers that the
brain has no evidence for this, lists the nearest pages it found, and skips
the synthesis call. Incomplete evidence coverage never abstains.

### injection signal (`injection`)

Rides in the evidence gate's request: "does this candidate contain
instructions aimed at an AI agent?". The probability is stamped on results
as `injection_p`. When on, flagged results move below clean results of the
same evidence class (never below the evidence gate's `min_keep` cut), and
`think` adds an `injection_suspected` line to their untrusted-content
wrapper. It never drops content and never gates a write. It is a signal, not
a security boundary.

### know-to-ask (`recall_needed`)

Runs in `gbrain serve`'s turn-context handler, beside the reflex rules that
answer `gbrain hook user-prompt`. One question over the prompt and the last
turn: "does answering this need the user's stored memory?". When on, it fires
one keyword-only search (limit 3) the reflex rules would have missed, such as
lowercase names or indirect references, and suppresses reflex injection when
the probability is under `decide.slots.recall_needed.suppress_below` (0.10)
and no exact alias hit exists. It has its own 250 ms deadline inside the
400 ms turn budget, and the reflex block is never delayed or dropped because
of it. It sends prompts, so on Jev it needs `decide.egress.private allow`.

### dream triage (`triage`)

Splits each transcript into windows of whole turns (about 1,500 characters)
and asks, per window, whether it holds synthesis-worthy content: a decision,
a commitment, a new fact about a person or project, an idea or a reflection.
The transcript's score is its best window, so one buried signal is enough.
The top windows become the segment map the synthesizer already reads; the
synthesizer still reads the full transcript. A transcript is rejected only
when every window was judged. Turning it on does not re-triage anything you
already triaged. It sends transcripts. With a TypeSafe key it is on by
default and the key is its opt-in for transcript text
([Defaults](#defaults-on-with-a-key-for-what-measurably-helps)); turned on
explicitly on Jev, it needs `decide.egress.private allow`.

### claim support (`grounding`)

After the mechanical checks in dream synthesis, each new claim that passes
only because it has no quote, number or attribution is checked against up
to three source windows: "is this claim supported by these sources?". An
unsupported claim goes to the existing quarantine lane as
`unsupported_paraphrase`; weak source coverage records
`insufficient_context` instead. It only adds a check and can never admit a
claim the mechanical checks rejected. On Jev it needs
`decide.egress.private allow`.

### contradiction (`conflict`)

The fact write path stays unchanged and model-free. When on, a sweep at the
end of the `extract_facts` cycle phase looks at facts written since its last
run, compares each with its nearest neighbours (same source, entity and
visibility), and asks whether each pair is a duplicate, a supersede or
independent. It never supersedes anything by itself: likely supersedes
become proposals you accept or reject. The first run starts at the newest
fact, so enabling it never sweeps your whole history silently. With a
TypeSafe key it is on by default and the key is its opt-in for fact text
([Defaults](#defaults-on-with-a-key-for-what-measurably-helps)). Turned on
explicitly, facts default to private, so on Jev it needs
`decide.egress.private allow`, or route it to an `llm:` provider.

The sweep only compares facts that belong to an entity; a fact saved without
one is skipped as `no_entity`. When `gbrain decide status` shows a large
`no_entity` share, link those facts with `gbrain facts relink`
([guide](facts-relink.md)); linked facts are queued for the next sweep.

```bash
gbrain decide sweep --slot conflict [--since <fact id>] [--source <id>] [--json]   # run the sweep now
gbrain decide proposals list [--status pending|accepted|rejected|stale|undone|all]  # both facts' text, locally
gbrain decide proposals accept <id> | reject <id>           # or --all-from <sweep id>
gbrain decide proposals undo <id>                           # reverse an accepted proposal
```

## Turning a slot on

```bash
gbrain decide enable <slot>        # summary of what leaves the machine and the cost, then asks
gbrain decide enable <slot> --yes  # the same, without the question (scripts, agents)
gbrain decide disable <slot>       # back to off
gbrain decide disable --all        # every slot off
```

`enable` does everything the slot needs in one confirmed step. It prints
what data leaves the machine and to whom, the estimated cost per 1,000 units
and the daily cap, and the exact config keys it will write. After you
confirm, it writes the provider (always the resolved pinned id, never an
alias), the consent keys for the slot's data classes, the calibration it
will use, and the mode. It then prints the requested and the effective mode:

```
evidence: requested: on / effective: on
```

`enable` refuses, writes nothing and exits non-zero when the slot could not
actually act: no provider, no key, no calibration, a failed precision gate,
a changed policy, or private egress denied for a slot that sends private
data. The refusal names the reason, the fix command and the
[troubleshooting](#troubleshooting) anchor.

With `decide.provider none` (the default), `enable <slot>` refuses with
`no_provider` unless you name one: `gbrain decide enable evidence --provider
typesafe:jev-1.13.0`. Rerank is the exception; it uses the pinned Jev id.
`--provider llm:<provider:model>` routes a slot to a chat model you already
use (for example, the evidence gate on Jev and dream triage on a local model
through `decide.slots.triage.provider`).

### Slots that can remove or withhold content

The evidence gate, abstention, know-to-ask suppression, triage rejection and
claim quarantine can take something away. These slots turn on only with a
**qualified calibration**: a threshold measured on labelled data, whose
harmful action (a prune, an abstention, a rejection) was right at least 90%
of the time at the 95% lower bound (`decide.slots.<slot>.min_action_precision`,
default 0.90). A qualified calibration comes from one of two places:

- A **reference calibration** shipped in the binary, measured by the
  maintainers' evals. `--recommended` and `enable` use it when your brain has
  no local row. This build ships two, for `jev-1.13.0`: dream triage and the
  contradiction sweep. Other slots show `needs calibration`.
- **Your own**, from a labelled dataset (the advanced path below).

The contradiction sweep only proposes, and routing and the injection signal
only reorder or relabel, so they do not need this gate. They still need a
threshold, from a calibration or an explicit
`decide.slots.<slot>.threshold`.

### Calibrating on your own data (advanced)

One JSONL line per labelled item. `family` groups items that must stay on the
same side of the calibrate/eval split (one question and its candidates):

```jsonl
{"id":"q1:launch","family":"q1","state":{"query":"When does Acme Example ship the beta?"},"inputs":{"candidate":"Acme Example decided to ship the beta on Friday."},"label":true,"rank":0}
{"id":"q1:sync","family":"q1","state":{"query":"When does Acme Example ship the beta?"},"inputs":{"candidate":"We asked when to ship the beta again. No date yet."},"label":false,"rank":1}
{"id":"q2:owner","family":"q2","state":{"query":"Who owns the launch plan?"},"inputs":{"candidate":"Alice Example owns the launch plan."},"label":true,"rank":0}
{"id":"q2:parking","family":"q2","state":{"query":"Who owns the launch plan?"},"inputs":{"candidate":"The parking garage closes at nine."},"label":false,"rank":1}
{"id":"q3:date","family":"q3","state":{"query":"What did Alice Example decide?"},"inputs":{"candidate":"Alice Example decided to move the launch review to Monday."},"label":true,"rank":0,"protected":false}
```

Optional fields: `slice` (a workload label reported per slice), `rank`
(candidate position) and `protected` (a result the evidence gate may never
remove). Then:

```bash
gbrain decide dataset --slot evidence --from jsonl labels.jsonl --out evidence.jsonl   # frozen 50/50 split by family
gbrain decide calibrate --slot evidence --dataset evidence.jsonl --dry-run             # token and cost estimate, no calls
gbrain decide calibrate --slot evidence --dataset evidence.jsonl                       # threshold, reliability table, ECE
gbrain decide qualify --slot evidence --dataset evidence.jsonl                         # precision gate on the eval half
gbrain decide enable evidence
```

`dataset` sources in this build (`gbrain decide dataset --slot <slot> --from
<source> <path>`): `jsonl` (any slot, pre-labelled lines), `longmemeval`
(evidence gate, abstention, query routing), `brainbench` (query routing),
`know-to-ask` (know-to-ask), `cat35` (dream triage), `grounding-labels`
(claim support), `facts-fixtures` (contradiction) and `injection-fixtures`
(injection signal).
`calibrate` re-asks a sample of items three times, and again with shuffled
neighbours, and stores how much the answers move (`retest_sd`, `repack_sd`).
Answers inside `max(decide.margin_floor, 2 x max(retest_sd, repack_sd))` (floor 0.05) of the threshold on
the harmful side take the no-change outcome. `qualify` refuses with
`insufficient_n` and prints the number of families needed when the dataset
is too small to prove the bound (35 of 35 correct is the minimum at 0.90).
Use `--call-site think` to calibrate a slot's `think` question separately.

### Escape hatches

- `decide.slots.<slot>.threshold <t>` sets the threshold by hand. It does not
  bypass the precision gate, and doctor lists it as an uncalibrated override.
- `decide.slots.<slot>.force_on true` bypasses the precision gate. `status`
  and `enable` print a warning every time, and doctor always lists it.
- `decide.slots.<slot>.min_keep`, `decide.margin_floor`,
  `decide.max_concurrency`, `decide.timeout_ms` and `decide.query_budget_ms`
  are configurable; the full table is in
  [`decide.md`](../architecture/decide.md#fixed-by-design-versus-configurable).

`gbrain config set decide.slots.<slot>.<key>` validates the value and prints
the effective-mode line when the slot would not act as requested:

```
evidence: requested: on / effective: off / cause: no_calibration (no local or reference calibration row for (slot, call site, provider, model)) / fix: gbrain decide calibrate --slot evidence --dataset <jsonl> / docs: docs/guides/system-one.md#no_calibration
```

### The kill switch

`gbrain decide disable --all` turns every slot off, restores the reranker
settings `enable rerank` changed, and stops the contradiction sweep.
`gbrain config set decide.provider none` stops every decide slot as well. A
Jev reranker you selected by hand with `search.reranker.model` keeps running
until you change that key.

## When a slot is on but not acting

A slot you turned on can still run with off behavior for a call: the
provider answered with a different model than the calibration's, the action
policy changed since qualification, consent is missing, or the daily budget
is spent. That call does exactly what off does, writes a receipt with the
reason, and `status` and doctor show

```
evidence       on (inactive: model_drift)
```

plus a `requested: ... / effective: ... / cause: ... / fix: ...` line naming
the one command that fixes it. A new GBrain release never silently moves an
enabled slot to a newer reference calibration; `status` shows `newer
reference available` and you adopt it with
`gbrain decide calibrations adopt <id>`.

## Fail directions

Every slot fails toward today's behavior. No slot can weaken a deterministic
floor: verbatim quotes, numbers, visibility and trust rules always win.

| Failure | What happens |
|---|---|
| Timeout (`decide.timeout_ms`, 1500 ms per decision; `decide.query_budget_ms`, 1500 ms for the time decide work adds to one query, not counting retrieval or expansion) | The slot takes its fail direction. Later stages skip with `late`. |
| HTTP 429 | Retried once only when `retry-after` fits the deadline, else the fail direction. |
| HTTP 5xx, bad key | The fail direction. |
| A missing answer or an out-of-range value | The whole decision fails (`malformed_response`); partial answers are never used. |
| Two resolved models in one decision | The decision fails (`mixed_model`). |
| Daily budget spent | Every third-party slot takes its fail direction until UTC midnight. |
| Egress refused | The item goes to `decide.egress_fallback` if set, else the fail direction. |
| Model drift or a changed policy | Off behavior for that call, with a receipt. |

The fail direction per slot is the "If Jev fails or is late" column in
[the slots table](#the-slots).

## Egress rules

One rule covers every path: a provider receives a data class only with your
consent for that provider.

- **Consent** is per data class for TypeSafe: `decide.egress.typesafe.query`,
  `.candidates`, `.facts` and `.conversation`, each `deny` until `enable`
  writes `allow` after showing you what leaves. For the reranker, selecting
  a TypeSafe reranker is the consent for query and candidate text.
- **Private content** never leaves without `decide.egress.private allow`:
  pages whose visibility resolves private (including derived pages whose
  origin is private), facts (private by default) and conversation text
  (always private). This is why know-to-ask, triage, claim support and the
  contradiction sweep need it on Jev, and why `enable` refuses them with
  `egress_private_denied` unless a permitted route exists. The one
  exception is the key-aware default: a slot that is on only because a
  TypeSafe key is present (triage, the contradiction sweep) treats the key
  as consent for its own data class and the private opt-in for its
  conversation or fact items. It never covers pages, and an explicit
  `decide.egress.private deny` turns those defaults off.
- **Denied sources**: `decide.egress.deny_sources` (source ids) applies to
  every provider and every path.
- **`llm:` providers** follow today's chat egress rules: they are providers
  you already send this data to.
- **Egress fallback**: `decide.egress_fallback llm:<provider:model>` answers
  only the items egress refused, as a separate decision with its own
  calibration. Timeouts, 429s and budget exhaustion never go to the fallback.

`gbrain decide status --egress` prints the provider by data class matrix
and the key that decides each cell. What stays on the machine no matter
what: [TypeSafe data handling](../ai-providers/typesafe.md#what-never-leaves-the-machine).

## Reading `gbrain decide status`

```
System One (decide): provider typesafe:jev-1.13.0; key: TYPESAFE_API_KEY
egress: private=deny; consent query=allow candidates=allow facts=deny conversation=deny; deny_sources: none; fallback: none
budget: $0.0002 of $1.00 today (remote $0.0000, cap 50%); not covered: S1 on: reranker spend controls (BudgetKind rerank); llm: providers: chat spend controls (BudgetKind chat)
reranker: voyage:rerank-2.5 (enabled, mode balanced); Jev called: no

  rerank         ready for on ~$0.5377/1k queries (estimate)
  evidence       on threshold 0.300 (override) ~$0.3873/1k queries (estimate) 24h: 12 decisions, 0.0% errors
    WARN: decide.slots.evidence.force_on bypasses the action-precision gate
```

- Line 1: the default provider (with an alias warning when it is not
  pinned) and which variable supplied the key.
- `egress`: private-content rule, consent per data class, denied sources and
  the egress fallback.
- `budget`: third-party decide spend today against `decide.budget.daily_usd`,
  the remote-caller share and its cap (`decide.budget.remote_share`), and the
  spend the cap does not cover.
- `reranker`: the active search reranker, whether it is enabled, the search
  mode, and whether Jev is being called.
- One line per slot: its readiness, then its threshold and where it came
  from (`override`, a local calibration `local:<id>` or a reference
  `ref:<id>`), the estimated cost per 1,000 units (`receipts` when measured
  from the last 24 hours, `estimate` from the pack planner), and 24-hour
  decisions and error rate.

Readiness values:

| Readiness | Meaning | Next step |
|---|---|---|
| `off` | The slot is off (or cannot be enabled yet, for example no key). | `gbrain decide enable <slot>` names what is missing. |
| `ready for on` | `enable` would succeed now. | `gbrain decide enable <slot>` |
| `needs calibration` | The slot needs a calibration or qualification first. | A reference calibration, or [your own](#calibrating-on-your-own-data-advanced). |
| `on` | GBrain acts on the slot's decisions. | Nothing. |
| `on (inactive: <reason>)` | Requested on, running with off behavior. | The printed fix, or [troubleshooting](#troubleshooting). |

`gbrain decide status --json` carries the same data plus per-slot `status`:
`pending` (no receipts yet), `active`, `blocked` (every receipt skipped) or
`demoted` (skipped because the slot is inactive).

## Reading doctor

`gbrain doctor` has one System One check, `decide_health`. With every slot
off it reports `System One is off (every decide slot is off; nothing is
sent).` Otherwise it summarizes each active slot (a key-aware default reads
`triage=on (default: Jev key present)`, followed by the opt-out command)
and warns about:

- a TypeSafe provider configured without a key;
- an alias (`jev-latest`, `jev-preview`) in use, and decisions that failed on
  mixed resolved models while an alias rolls out;
- slots requested on but inactive, with cause and fix;
- a calibration made for a different model than the one now answering
  (drift);
- a 24-hour error rate over 5% (with at least 20 receipts);
- an exhausted daily budget;
- a pinned model the provider no longer serves;
- every `force_on` bypass and every uncalibrated threshold override;
- egress refusals in the last 24 hours (a note, not a warning).

## Receipts

Every decision writes one receipt row per question to `decision_receipts` in
your database: slot, mode, provider, requested and resolved model, the
answer's number, threshold, outcome, reason, latency and token count. Pages,
facts and transcripts are referenced by an HMAC under a per-brain salt that
no config surface prints. No query, prompt, page or transcript text is
stored.

```bash
gbrain decide receipts [--slot <slot>] [--since <hours>] [--json]    # aggregates only
gbrain decide receipts --slot evidence --what-if-threshold 0.4       # replay a threshold, no provider call
```

`--what-if-threshold` works for slots whose decision can be replayed exactly
from receipts (the evidence gate, triage and claim support) and says "not
reproducible" for the others.

Volume: rerank on writes one row per reranked candidate (at most
`search.reranker.top_n_in`, 30 by default) and the evidence gate one row per
judged candidate (at most 50). A brain running 1,000 searches a day with both
on writes roughly 50,000 to 80,000 rows a day. Rows are kept for
`decide.receipts.retention_days` (7) and pruned by the dream cycle's `purge`
phase.

`gbrain search "<query>" --explain` prints one `decide <slot>: ...` line per
slot that ran on the query (mode, provider and resolved model, threshold and
outcome counts), and a skipped slot's reason. With every slot off, explain
output is unchanged.

## Budget and cost

`decide.budget.daily_usd` (default $1.00) caps third-party decide spend per
brain per UTC day, summed from a local spend ledger that charges failed and
timed-out requests their estimated tokens. Over the cap, slots take their
fail direction. Remote callers (MCP `query` and `think`) may use at most
`decide.budget.remote_share` of it (default 0.5). The cap is soft in both
directions: buffered ledger rows and concurrent processes can overshoot it
slightly. Two paths sit outside it: the Jev reranker under `rerank` on uses
the reranker spend controls, and `llm:` providers use the chat spend
controls. Concurrency limits apply per process.

Estimates at the pinned price, from the pack planner for a typical input:
about $0.54 per 1,000 queries for rerank (30 candidates) and about $0.39 per
1,000 queries for the evidence gate. `status` switches to measured figures
once receipts exist.

## Say to your agent

> Check whether my TypeSafe key works without sending anything from my brain.

> Show me, on my own brain, what System One would change for "When does
> Acme Example ship the beta?", without changing anything.

> Turn on the System One slots that have a recorded win, and show me what
> data leaves the machine before you confirm.

> Is System One doing anything right now? Show me its status and doctor's
> System One check.

> Why is the evidence gate on but not acting?

> Turn System One off everywhere.

Your agent runs `gbrain decide probe`, `gbrain decide probe --query "..."`
(showing you the egress line before adding `--yes`), `gbrain decide enable
--recommended`, `gbrain decide status` and `gbrain doctor`, the fix command
from the `requested / effective / cause / fix` line, and
`gbrain decide disable --all`. `gbrain decide` runs only on the brain host;
a thin client refuses it.

## Troubleshooting

Every refusal and inactive cause prints the problem, the reason code, the
cause, a fix command and a link to a row here.

| Reason | What it means | Recovery |
|---|---|---|
| <a id="no_provider"></a>`no_provider` | `decide.provider` is `none`, so the slot has no provider. | `gbrain decide enable <slot> --provider typesafe:jev-1.13.0` (or `--provider llm:<provider:model>`). |
| <a id="no_key"></a>`no_key` | Neither `TYPESAFE_API_KEY` nor `JEV_TYPESAFE_API_KEY` is set in the process or `~/.gbrain/.env`. | `export TYPESAFE_API_KEY=... && gbrain decide probe`. |
| <a id="no_calibration"></a>`no_calibration` | No local or reference calibration exists for this slot, call site, provider and model. | A reference calibration for your model, or `gbrain decide calibrate --slot <slot> --dataset <jsonl>`. |
| <a id="no_qualification"></a>`no_qualification` | The calibration has no precision bound yet. | `gbrain decide qualify --slot <slot> --dataset <jsonl>`. |
| <a id="pack_shape_mismatch"></a>`pack_shape_mismatch` | The calibration was measured with a different request shape (for example, another slot is now packed into the same request). | Recalibrate: `gbrain decide calibrate --slot <slot> --dataset <jsonl>`. |
| <a id="action_precision_low"></a>`action_precision_low` | The slot's harmful action was not precise enough on the eval half. | Leave it off, calibrate on better data, or bypass on purpose with `gbrain config set decide.slots.<slot>.force_on true` (doctor lists it). |
| <a id="insufficient_n"></a>`insufficient_n` | Too few harmful actions to prove the bound, even if all were right. | Build a larger dataset: `gbrain decide dataset --slot <slot> --from <source> <path>`. |
| <a id="policy_changed"></a>`policy_changed` | The threshold, margin, floors, question version or request shape changed since qualification. | `gbrain decide qualify --slot <slot> --dataset <jsonl>`. |
| <a id="model_drift"></a>`model_drift` | The provider answered with a different model than the calibration's. Calls run with off behavior. | `gbrain decide calibrations list --slot <slot>`, then adopt a calibration for the new model, or pin the old id. |
| <a id="egress_private_denied"></a>`egress_private_denied` | The slot sends private content and `decide.egress.private` is `deny`. | `gbrain config set decide.egress.private allow`, or route the slot to an `llm:` provider (`decide.slots.<slot>.provider`) or set `decide.egress_fallback`. |
| <a id="egress_class_denied"></a>`egress_class_denied` | The data class has no consent for this provider. | `gbrain decide enable <slot>` shows what leaves the machine, then writes consent. |
| <a id="egress_fallback_missing"></a>`egress_fallback_missing` | Items egress refused have no fallback provider. | `gbrain config set decide.egress_fallback llm:<provider:model>`, or accept the fail direction for them. |
| <a id="split_mismatch"></a>`split_mismatch` | The calibration was built from a different dataset split, or not from the calibrate half only. | `gbrain decide calibrate --slot <slot> --dataset <jsonl>` on the same dataset file. |
| <a id="pinned_model_unavailable"></a>`pinned_model_unavailable` | The provider no longer serves the pinned model. Calls take the fail direction. | `gbrain config set decide.provider typesafe:<new-id> && gbrain decide calibrations list`, then recalibrate or adopt a reference calibration for the new id. |
| <a id="budget_exhausted"></a>`budget_exhausted` | Today's third-party decide spend reached `decide.budget.daily_usd`. Slots take their fail direction until UTC midnight. | Wait, or `gbrain config set decide.budget.daily_usd <usd>`. |
| <a id="thin_client"></a>`thin_client` | This install is a thin client; `gbrain decide` runs on the brain host. | Run `gbrain decide` on the brain host. |
| <a id="malformed_response"></a>`malformed_response` | The response missed a question or carried an invalid value. The decision took its fail direction. | `gbrain decide probe`; if it persists, check TypeSafe's status. |
| <a id="reranker_not_jev"></a>`reranker_not_jev` | `rerank` is on but `search.reranker.model` is not a TypeSafe model, so it behaves as off. | `gbrain decide enable rerank`. |
| <a id="slot_unavailable"></a>`slot_unavailable` | The slot is not included in this build. | `gbrain decide status`; upgrade when the slot ships. |
| <a id="llm_capability"></a>`llm_capability` | The `llm:` route cannot enforce structured output or report its model identity. | Use a structured-output route: `gbrain config set decide.slots.<slot>.provider llm:<provider:model>`. |
| <a id="no_recorded_win"></a>`no_recorded_win` | `enable --recommended` found no slot with a recorded win and a passing reference calibration for your model. Nothing changed. | See [`docs/eval/system-one/`](../eval/system-one/); enable a single slot with `gbrain decide enable <slot>`. |

Receipt skip reasons (`error_reason` on skipped or error rows) also include
`egress`, `late`, `timeout`, `rate_limited`, `provider_error`, `mixed_model`,
`no_embedding`, `no_entity`, `missing_provenance`, `denied_source`,
`payload_too_large`, `cache_hit` and `no_candidates`.

## Advanced diagnostics

This section is for diagnosing System One itself. It is not a step toward
turning a slot on, and nothing requires it.

`shadow` mode makes the provider call and writes a receipt, but changes no
ranking, pruning, gating or write:

```bash
gbrain decide enable <slot> --shadow   # same summary and consent as enable
gbrain decide disable <slot>
```

- On search paths shadow runs in the background and adds no latency and no
  meta. It samples by `decide.slots.<slot>.shadow_sample` (the evidence gate
  and injection signal default to 0.1, the rest to 1.0).
- `gbrain search "<query>" --explain` waits for shadow on that one query and
  prints its `decide` lines. `decide.slots.<slot>.shadow_wait on` does this
  for every query, which adds the slot's real latency to every search.
- Rerank in shadow beside a non-Jev reranker (Voyage or none) scores the
  same candidates with Jev using the TypeSafe key, through the decide egress
  consent, and records rank agreement (top-1 match, Kendall tau). Results do
  not change. Without a key it is skipped with `no_key`.
- Shadow receipts hold predictions, not correctness labels, so they cannot
  produce a calibration. Use them to see traffic, latency, drift and
  agreement.
- On a search cache hit, shadow makes no call and writes no receipt.
- `status` shows `shadow` or `shadow (inactive: <reason>)` for these slots,
  and `decide.provider none` stops shadow along with everything else.

Evals can set slot modes for one process with `GBRAIN_DECIDE_SLOTS` (for
example `triage=on`). Only eval commands and `gbrain dream --eval-run` honor
it, it never bypasses consent, egress or the daily cap, and every receipt
records it.
`gbrain dream --eval-run` honors it for dream cycles. The eval commands
take the same setting as flags, so matched pairs differ only in the slot
under test:

```bash
gbrain eval longmemeval <data.jsonl> --no-trajectory --decide <slot>=<off|on|shadow> [--decide ...]
    [--decide-provider <id>] [--decide-calibration <file|ref:<id>>] [--decide-threshold <slot>=<x>]
    [--decide-force-on <slot>] [--decide-dataset <jsonl>] [--eval-pool-depth <N>]
gbrain eval brainbench [--suite know-to-ask] --decide recall_needed=on [same --decide-* flags]
gbrain eval retrieval-quality <fixture.jsonl> --json --decide <slot>=<mode> [--decide-provider <id>] [--decide-dataset <jsonl>]
gbrain decide judge-agreement --suite <longmemeval|grounding> --input <file> [--limit N]
    [--provider <id>] [--threshold 0.5] [--dry-run] [--json] [--out FILE]
```

- Flags win over an inherited `GBRAIN_DECIDE_SLOTS`; the effective value is
  set for the run and recorded in its metadata. No slot on or shadow means
  output identical to a run without the flags.
- LongMemEval and BrainBench write what the slot needs into their throwaway
  benchmark brains (provider, consent, `decide.egress.private allow`,
  thresholds, `force_on`, awaited shadow, calibrations). `retrieval-quality`
  runs on your brain and never writes its config: it refuses with the
  catalogued line when the provider, key or consent is missing.
- `--decide-calibration` takes the JSON `gbrain decide calibrate --slot <slot>
  --json` prints (or a reference id). With `--decide-dataset`, a calibration
  whose `split_hash` differs from that dataset, or that is not calibrate-only,
  is refused with `split_mismatch`, and LongMemEval runs only the eval half.
- `--decide rerank=on` pins the Jev reranker for the run.
  `--eval-pool-depth <N>` (N up to 300, LongMemEval only) lifts the per-arm
  candidate cap for that run and sets `search.reranker.top_n_in` to N;
  production depth is unchanged.
- `--decide-force-on` bypasses the action-precision gate so an eval can
  measure a slot that has not qualified; it prints a warning and is recorded.
- `judge-agreement` runs Jev beside the existing LLM judge (a `--judge`
  output, or grounding labels) and reports Cohen's kappa. It needs no brain,
  and nothing is substituted at runtime.

Row and summary fields: [`docs/eval-bench.md`](../eval-bench.md#system-one-arms---decide).
Protocols and verdicts: [`docs/eval/system-one/`](../eval/system-one/).
