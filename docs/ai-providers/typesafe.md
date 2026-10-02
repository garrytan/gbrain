# TypeSafe (Jev)

TypeSafe's Jev is a decision model. One `POST /v1/systemone` request carries a
shared `state` and a map of typed questions, and returns, per question, a
probability (yes/no), one option with a probability distribution (choice), or
a rubric score. GBrain uses it in two places:

- **System One (`decide`)**: typed decisions inside search, `think`, dream and
  the fact sweep. With a key installed, the two slots with a measured win,
  dream triage and contradiction proposals, are on by default; every other
  slot is off until you turn it on. The operator guide is
  [System One](../guides/system-one.md).
- **Search reranking**: `search.reranker.model typesafe:jev-1.13.0`, the
  reranker contract from #5178. Voyage stays the default reranker.

Jev has no chat, synthesis or embedding surface. A key never changes your
reranker. It does turn on the key-aware defaults below.

## What a key turns on by default

When `TYPESAFE_API_KEY` or `JEV_TYPESAFE_API_KEY` is set (shell or
`~/.gbrain/.env`) and you have not configured these slots yourself:

| Slot | What it sends to TypeSafe | When | Measured effect |
|---|---|---|---|
| `triage` (dream triage) | transcript windows (conversation text) | each dream cycle's triage | caught 18/18 buried decisions vs 8/18; dream spend +73% ($1.50 to $2.60) in the end-to-end run |
| `conflict` (contradiction proposals) | fact text, including private facts | the sweep after `extract_facts` | found 94/97 updated facts vs 0/97; proposals only, nothing changes until you accept |

For these two slots the key is your opt-in for that data. Nothing is written
to config; `gbrain decide status` shows `on (default: Jev key present)`.
Opt out with `gbrain decide disable triage`, `gbrain decide disable conflict`
or `gbrain decide disable --all`. An explicit `decide.egress.private deny`
or `decide.provider none` turns the defaults off too. Details:
[System One defaults](../guides/system-one.md#defaults-on-with-a-key-for-what-measurably-helps).

## Key setup

Get a key at [console.typesafe.ai](https://console.typesafe.ai). Put it in
your shell environment or in the GBrain home environment file
(`~/.gbrain/.env`, or `$GBRAIN_HOME/.env`), never in a project `.env` and
never in chat:

```dotenv
TYPESAFE_API_KEY=<your-key>
```

`TYPESAFE_API_KEY` is the canonical name. `JEV_TYPESAFE_API_KEY` is accepted
as an alias. When both are set, `TYPESAFE_API_KEY` wins. The process
environment takes precedence over the home file.

Check it with one tiny live request that sends no brain content:

```bash
gbrain decide probe
```

```
TypeSafe Jev probe: resolved jev-1.13.0 (requested typesafe:jev-1.13.0) in 439 ms, 383 input tokens, $0.000016.
Key: TYPESAFE_API_KEY. No brain content was sent.
Next: gbrain decide probe --query "<a question your brain can answer>"
```

`gbrain decide status` names the variable that supplied the key
(`key: TYPESAFE_API_KEY`, `key: JEV_TYPESAFE_API_KEY` or `key: not set`).
`gbrain providers list` shows TypeSafe with its `RERANK` and `DECIDE`
capabilities and whether the key is present.

## Pinned versus alias models

| Model id | What it is | Use it for |
|---|---|---|
| `typesafe:jev-1.13.0` | A pinned, versioned model. The default. | Everything. Calibrations and thresholds are measured against one pinned id. |
| `typesafe:jev-latest` | An alias for the newest stable release. It moves when TypeSafe ships a release. | Trying a new release on purpose. `gbrain doctor` warns while you use it. |
| `typesafe:jev-preview` | An alias for the newest release, stable or not. | Same as `jev-latest`, earlier. Doctor warns. |

Every response names the versioned model that answered, and GBrain records
it. Within one logical decision (every batch of one request), answers from
two different resolved models fail the decision, which then takes its
documented fail direction. This closes the gap noted in the #5178 review,
where `jev-latest` batches could mix versions.

`gbrain decide enable` always writes the resolved pinned id, never an alias,
so a later GBrain release that changes the default pin does not move a brain
that already opted in. If the pinned id stops being served, calls fail with
`pinned_model_unavailable` and doctor names the recovery. See
[troubleshooting](../guides/system-one.md#pinned_model_unavailable).

## Reranker setup

Carried from #5178 by [dsandrade](https://github.com/dsandrade), who designed
the native Jev reranker adapter, its context-aware packing and its cost
accounting. GBrain now runs that adapter on the shared decide core.

The one-step way, which records what it changed so `disable` can restore it:

```bash
gbrain decide enable rerank          # shows what leaves the machine, asks, then writes
gbrain decide disable rerank         # restores your previous reranker settings
```

`enable rerank` writes `decide.provider`, `decide.slots.rerank.mode on`,
`search.reranker.model typesafe:jev-1.13.0` and `search.reranker.enabled
true`. `disable rerank` restores the previous `search.reranker.*` values, but
only the ones you have not changed since.

The manual way, exactly as #5178 documents it, still works:

```bash
gbrain config set search.reranker.model typesafe:jev-1.13.0
gbrain config set search.reranker.enabled true
gbrain search modes
```

How the reranker behaves:

- Each candidate gets one Score question over a four-level rubric: no useful
  answer evidence, same topic without specific evidence, evidence answering
  part of the query, direct evidence answering the query. Scores are
  normalized to 0..1, and ties keep the fused order. A score is relevance,
  not the probability that a stored fact is true.
- The query is shared state. Each question carries only its own candidate
  and tells the model to treat candidate text as data.
- Requests pack as many candidates as fit the published context limits (64k
  tokens per request, 32k for state plus the longest question) using a
  conservative 2x token estimate. Evidence is never truncated to fit; the
  planner splits into more requests instead. Up to 16 requests run at once
  under one deadline.
- A missing key, a rejected request, an incomplete answer, mixed resolved
  models or a timeout keep the fused (RRF) order. Search never fails because
  the reranker did.
- `search.reranker.top_n_in` bounds how many candidates are sent. The
  keyword-only search path returns before reranking, as it does for every
  reranker.
- Until the S1 eval publishes calibrated values, autocut's score cliff and
  CRAG's strong-evidence grade do not read Jev rubric scores.

With `decide.slots.rerank.mode on`, reranks also write decision receipts and
stamp `rerank.model_resolved` in search meta. `gbrain decide status` shows
the active reranker and whether Jev is being called. `decide.provider none`
stops decide slots and rerank shadow, but not a Jev reranker you selected
yourself; turn that off with `gbrain decide disable rerank` or
`gbrain config set search.reranker.enabled false`.

## Pricing

Per TypeSafe's [models page](https://docs.typesafe.ai/models), retrieved
2026-09-30: $0.042 per million input tokens for `jev-1.13.0`. Output tokens
are free. GBrain's price table carries the same figure for the pinned id and
both aliases.

Measured with a test key on 2026-09-30 (a two-page brain):

| Call | Input tokens | Cost |
|---|---|---|
| `gbrain decide probe` (two questions, fixed sentence) | 383 | $0.000016 |
| `gbrain decide probe --query` over one result | about 450 | $0.000019 |
| Reranking 1,000 queries, 30 candidates each (planner estimate) | | about $0.54 |

Third-party decide spend is capped by `decide.budget.daily_usd` (default
$1.00 per brain per UTC day). Over the cap, slots behave as if the provider
failed and take their fail direction. The cap is soft: buffered spend rows
and concurrent processes can overshoot it slightly. Two paths sit outside
it: the Jev reranker under `rerank` `on` uses the existing reranker spend
controls, and `llm:` providers use the chat spend controls. Spend triggered
by remote callers (MCP `query` and `think`) is limited to
`decide.budget.remote_share` of the cap (default 0.5). `gbrain decide status`
prints today's spend, the remote share and what the cap does not cover.

## Limits

Per the [models page](https://docs.typesafe.ai/models), retrieved 2026-09-30:

- Context: 64k tokens per request (state plus all questions), 32k tokens for
  state plus the longest question.
- Rate limits: 100K tokens per second and 40 requests per second for
  `jev-1.13.0`. TypeSafe says these limits "are adjusting dynamically" and can
  change without notice, and other TypeSafe sources have published different
  figures. GBrain hardcodes no rate constants.
- Input: text only.

How GBrain stays inside them: at most `decide.max_concurrency` (default 16)
requests in flight on hot paths and `decide.background_concurrency`
(default 4) on background paths. A 429 `retry-after` is honored once, and
only when it fits the deadline. There is no retry that extends a deadline.

## Data handling

TypeSafe states that Jev is not trained on customer requests or responses,
and that zero data retention is available to enterprise customers (see the
TypeSafe legal pages linked from the models page). GBrain treats TypeSafe as
a third party either way and gates every request.

A request carries only the data classes you consented to for TypeSafe:

| Data class | Sent when | Consent key |
|---|---|---|
| Query text | A search slot or the reranker is on | `decide.egress.typesafe.query` (the reranker selection counts as consent for rerank `on`) |
| Candidate page text | The reranker or a candidate slot is on | `decide.egress.typesafe.candidates` |
| Fact text | The contradiction sweep is on | `decide.egress.typesafe.facts` |
| Conversation text (prompts, transcripts) | Know-to-ask, dream triage or claim support is on | `decide.egress.typesafe.conversation` |

`gbrain decide enable <slot>` shows what leaves the machine and writes these
keys only after you confirm.

### What never leaves the machine

- Anything, while no key is set (every slot is off) and the reranker is not
  Jev.
- Pages whose visibility resolves private, including derived pages whose
  origin is private, unless you set `decide.egress.private allow`. The
  key-aware defaults never send pages.
- Facts, which default to private, and conversation text, which is always
  private, under the same rule, except for the key-aware defaults above
  (transcript windows for triage, facts for the sweep).
- Every page and fact from a source listed in `decide.egress.deny_sources`,
  for every provider.
- Evidence with missing provenance. It is refused before the request is
  built.
- Decision receipts. They stay in your database and hold hashes (HMAC-SHA256
  under a per-brain salt that no config surface prints), numbers and
  outcomes, never query, prompt, page or transcript text.
- Calibrations, proposals and the spend ledger.

The key-only `gbrain decide probe` sends one fixed sentence ("We decided to
ship the beta on Friday.") and nothing from your brain.

## Say to your agent

> Check whether my TypeSafe key works without sending anything from my brain,
> and tell me which model answered and what it cost.

> Use TypeSafe Jev as my search reranker, show me what leaves the machine
> first, and keep my search mode and embedding provider as they are.

> Stop calling TypeSafe from this brain.

The agent runs `gbrain decide probe`, `gbrain decide enable rerank`, and
`gbrain decide disable --all` (which also restores a reranker that
`decide enable rerank` set; a Jev reranker you configured by hand needs
`gbrain config set search.reranker.enabled false`). Give the key through the
home environment file or your shell, not the chat.

## References

TypeSafe [API](https://docs.typesafe.ai/api),
[models and pricing](https://docs.typesafe.ai/models),
[Score](https://docs.typesafe.ai/primitives/score) and the
[reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe).
The GBrain contract is [`docs/architecture/decide.md`](../architecture/decide.md).
