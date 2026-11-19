# Speaker attribution: held-out verdict (PASS)

This is the sealed E3 run under preregistration amendment 2 (gbrain-evals `docs/benchmarks/2026-10-04-p2-ranking-extraction-preregistration.md`).
The evaluation custodian ran it on build 6fa1a77b3, using 60 sealed synthetic user–assistant conversations across five
case families: rejection, quotation, correction, repeated suggestion and acceptance.

The candidate was `facts.attribution=true`. The baseline was the same build with the setting absent. Both arms ran
foresights's conversation-facts extractor through the decision kit's facts lane, with two extractions per arm, and a fixed
reader that answers from the saved facts of the top five sessions with 5 replicates.

| Gate | Baseline → candidate | 95% CI | Result |
|---|---|---|---|
| Primary: assistant-said QA from saved facts | 44.1% → 95.8% (+51.7 pts; 73 wins, 0 losses) | [+42.9, +60.3] | pass |
| Guard 1: user-said QA from saved facts (lower bound ≥ −2 pts) | 97.2% → 98.6% | [−0.4, +3.4] | pass |
| Guard 2: rejected suggestions saved as the user's plan | 0 confirmed | — | pass |
| Guard 3: stored speaker correct (≥ 90% of 200 sampled facts) | 194 / 200 (97%) | — | pass |

**Guard 2 adjudication.** The pinned judge flagged 32 of 1,208 candidate facts in the rejection family. The custodian read
all 32 and confirmed none. Each one was one of these:
- an assistant recommendation that matched the user's own plan;
- a neutral note;
- a choice the user made themselves.

**Reported only.**
- **Facts per conversation: +41%** with attribution on. The extractor now saves what the assistant said (answers,
  recommendations, plans) as its own facts, where the baseline dropped it. Storage, extraction output tokens and
  hot-memory volume grow by about that much on assistant-heavy conversations.
- **Guard 3 method:** the judge located each fact's source turn itself, because `facts.ndjson` records the session but
  not the turn.

## Default

`facts.attribution` defaults on. `false`, `off` or `0` opts out. With it on:
- the extractor phrases assistant claims as their own facts ("Assistant recommended …") and stores
  `facts.attributed_to`;
- dedup never merges claims from different known speakers;
- recall and hot memory return the speaker, and context packs render "(assistant said)";
- `consolidate` never promotes an assistant claim into the user's takes.

Facts saved earlier keep `attributed_to` NULL (unknown) and stay compatible with either speaker.

Development records: `../p2-attribution-gate-dev/` (the facts lane trailed pages by 73 pts on assistant-said questions)
and `../p2-attribution-dev/`.
