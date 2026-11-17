# Hub dampening: dev result and the frozen held-out configuration

These are the `search.hub_dampening` development arms on hub-world seed 1, the development seed of the preregistered
hub-heavy world. It has 32,652 pages and 77,489 links; inbound degree p50 is 7, p90 is 149 and p99 is 20,008, with four
hubs of 5,000, 10,000, 20,000 and 30,000 inbound links.

The runner is gbrain-evals `eval/runner/hub-world-arms.ts` (branch `capy/p2-hub-world-arms`). It builds one shared index
per foresights build and runs every read-time arm on it. Each search must report the arm's half degree in its telemetry.
The path is keyword-only, with RELATIONAL_PINS and relational retrieval off.

Families:
- Cat 13 concept probes (the preregistered primary, nDCG@5, 428 probes);
- hub-as-answer probes (20);
- bridge probes (32);
- one-hop relational templates (145).

Bridge probes score 0 in every arm on the keyword path, so they say nothing here.

## Results

Each row is Δ against dampening off, with 95% bootstrap CIs, in nDCG@5 points unless the column says otherwise.

| Arm | Concept (primary) | Hub-as-answer | One-hop recall@5 | One-hop hit@1 |
|---|---|---|---|---|
| H = 32 | +3.0 (+2.3, +3.8) | −78.5 (−89.5, −66.1) | −0.8 (−3.1, +1.5) | −1.4 |
| H = 100 | +2.3 (+1.6, +3.1) | −83.0 (−93.8, −70.4) | −0.1 | +2.1 |
| H = 200 | +1.8 (+1.2, +2.4) | −83.0 | 0.0 | +2.1 |
| H = 600 | +1.4 (+0.9, +1.9) | −83.0 | +0.1 | +3.4 |
| Graph signals off | 0.0 | 0.0 | −4.5 (−7.2, −2.1) | −3.4 |
| Control: backlink boost removed | +6.5 (+5.5, +7.8) | −13.5 (−23.2, −5.0) | −11.0 (−15.3, −6.9) | −10.3 |
| Control: boosts capped at +2% | +6.0 (+4.9, +7.1) | −12.8 (−22.7, −3.8) | −10.5 (−15.0, −6.0) | −7.6 |

Absolute values with dampening off: concept 38.0, hub-as-answer 98.2, one-hop recall@5 74.0.

## What it means against the preregistered gate

The gate passes only if all of these hold:
1. Primary Δ ≥ +1.0 pt with CI > 0.
2. Better than both controls.
3. Hub-as-answer Δ ≥ −0.5 pt.
4. One-hop Δ ≥ −0.5 pt.

Every half degree clears condition 1 and fails conditions 2 and 3. Removing or capping the backlink boost gains about
twice as much concept recall as any dampening setting. Every dampening setting removes most of a hub's boost: for
degrees of 5,000 to 30,000 the weight is below 0.02 even at H = 600. Questions whose answer is the hub page then lose
the page, because the backlink lift is what ranks a hub above its many routine mentions.

Development predicts that hub dampening fails the held-out gate. Under the preregistration, the setting then stays off
and the search-side mechanism is removed. The `hubWeight` helper stays either way, because the multi-hop chain executor
on master (`relational-chain.ts`) imports it.

The sealed held-out run confirmed it: FAIL (`../p2-e1-heldout/`).

The controls show something separate: on a hub-heavy brain the backlink boost costs concept recall (+6.5 pts without it)
but carries one-hop and hub-as-answer recall. No change to it is proposed here.

## Frozen held-out configuration

- **Candidate build:** foresights#6020 at af1225d7b.
- **Arms:**
  - off;
  - H = 32, the dev choice with the highest primary;
  - graph signals off;
  - control "backlink boost removed": branch `p2-e1-rival-remove`, 31a792c94 (af1225d7b plus `BACKLINK_BOOST_COEF = 0`);
  - control "boosts capped at +2%": branch `p2-e1-rival-cap`, 4e2bd760e (af1225d7b plus the backlink and graph-signal factors capped at 1.02).
- **Workloads:** sealed seeds 2 and 3, keyword path and hybrid (`text-embedding-3-large`), reranker off.

Runs:

```bash
bun eval/runner/hub-world-arms.ts --corpus-dir <seed-dir> --gbrain <foresights>@af1225d7b --arms off,32,graph-off --output <dir>
bun eval/runner/hub-world-arms.ts --corpus-dir <seed-dir> --gbrain <foresights>@31a792c94 --arms off --output <dir>
bun eval/runner/hub-world-arms.ts --corpus-dir <seed-dir> --gbrain <foresights>@4e2bd760e --arms off --output <dir>
```

Add `--embed openai --paid --budget-run-id <id>` for the hybrid cells.

Not run on development:
- The hybrid path. The hub-as-answer loss comes from the dampened boost itself, not from retrieval.
- The per-site split (backlink only, graph only), because one knob drives both sites.
- The reranker-on cells.

Dev spend was $0 (keyword path, no model calls).
