# T-Mem released-code reproduction: 20-case result

[Postmortem and decision](postmortem.md) · [Per-case results](paired-results.csv)

We found two genuine retrieval recoveries, offset by one retrieval loss, but did **not** reproduce the paper's answer-quality improvement. The recoveries already occur without Horizon triggers. This is evidence about a small reproduction of the released scene-only pipeline, not a completed replication of Table 4 or a result for the custom GBrain implementation.

## Matched results

| Variant | Target memory retrieved in top ten | Answers marked correct by released judge |
|---|---:|---:|
| Full Scene + Horizon | 14/20 (70%) | 9/20 (45%) |
| No Horizon, retaining Scene | 14/20 (70%) | 10/20 (50%) |
| No Scene or Horizon, retaining raw-dialogue retrieval | 13/20 (65%) | 10/20 (50%) |

Against raw-dialogue-only retrieval, full T-Mem recovered the source memory in `sample_116` and `sample_301`, lost it in `sample_166`, and tied on the other 17 cases. The recovered summaries actually contain the relevant facts, but the reader did not use them successfully. One recovery concerns motivation following a promotion; the other concerns a stated preference for confronting unfair treatment. Both were also recovered by the Scene-only arm. Horizon added no additional target-memory hits in this sample.

The primary answer metric has zero full-versus-baseline wins, one loss and 19 ties. Full versus no-Horizon has two wins, three losses and 15 ties. These are the original one-pass judge labels, preserved without regrading or hand correction.

**The judge is visibly noisy.** In `sample_128`, it incorrectly rejects a full-arm answer that recalls the right participant's neck-pain constraint; that is the sole scored full-versus-baseline loss. In `sample_166`, it incorrectly rejects the baseline's answer recalling the right participant's knee pain. These mistakes prevent treating the five-point score gap as clean evidence of a regression. They do not establish an improvement either.

The retrieval diagnostic uses the original injected cue turns' `dia_id` provenance in the selected scenes, not a second LLM judge or keyword similarity. Both cue turns are covered in all counted hits. It measures source-scene retrieval, not whether every summary or final answer preserves all details.

## What was reproduced

- Released T-Mem commit `dd9e1527bc75908485809580c9520af5a9a42879`, using its original construction, retrieval scoring, reader and judge callables. Thin orchestration preserves sparse original IDs and explicitly removes disabled RRF rank lists.
- Twenty cases selected before inference: five each of causal, state, goal and value. Original IDs: `9,27,47,54,58,116,128,148,160,166,214,215,244,265,294,301,302,349,367,398`. All 20 completed in all three arms; no cases were dropped.
- One shared constructed library and scored embedding pass per case. GPT-4.1-mini construction, BGE-M3 embeddings, GPT-4o reader and Gemini-2.5-Flash judge; temperature zero; released prompts; one judgment per answer; RRF 30 and top-ten scene summaries.
- 1,508 scenes, with 1,041 successful trigger packs and 467 skips required by the released turn-count rule. No pending summaries, trigger parse failures or empty/error predictions; no observed response ended at the length limit. This does not make the judge's substantive judgments reliable.

## Why this is not the paper's headline replication

The paper reports 74.81% full versus 52.62% without Scene/Horizon on all 401 Cognitive cases. Its released Plus runner instead skips the described hierarchical items/persona/reranker cascade, defaults to RRF 30 rather than 60, and constructs memory with access to the test query. The query-containing scene ranked first in 18/20 full-arm cases and all 20 raw-dialogue-only cases. No hidden correction to those behaviors was made here.

The small balanced sample spans only nine base-conversation indices; the paired cases are not twenty independent histories. It cannot establish equivalence, broad harm, or the paper's full-dataset effect size. Remote model serving revisions are not proven identical to those used by the authors. See `method-audit.md` and `protocol.md` for the source-level discrepancies and frozen protocol.

## Cost and artifacts

Reported cost for model compatibility checks, the initial one-case check and the full pilot was **$9.224531784**, including external BYOK charges. Three unresolved requests retain **$0.1653932** in reservations; they are not treated as free. Both experiment gateways are stopped. Historical custom GBrain costs remain separate.

The final pilot scope is `4b8e85146d3b6ff27422b208`; its receipt SHA-256 is `093a9e91fc3c5c92aac8e02caa8dac48b92d878325d2ad9fc9ba37a6d910519c`. The [reproduction bundle](tmem-reproduction-results.tar.gz) contains the frozen runner, tests, gateway, data pins, dependency inventory, per-case labels/provenance results and receipt hashes, but no credentials, raw benchmark conversations, rendered benchmark requests or generated personal-name text. Public prompt templates remain in the methods audit. The paired results are also available directly as [CSV](paired-results.csv).

The checked-in CSV uses LF line endings; its cells are identical to the original CSV in the unchanged bundle. The methods audit is a publication copy with portable source links. The protocol retains its original text beneath an archival note; the bundle preserves the unmodified research records.

**Conclusion:** a small descriptive-trigger retrieval signal exists, but this run supplies no demonstrated answer-quality benefit or additional target-memory recall from Horizon. It does not justify resuming or shipping the custom GBrain integration. An exact Table 4 claim still requires resolving the missing paper execution path, not merely running more cases through this released route.
