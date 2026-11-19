# Date-grounded extraction: dev verdict

`extraction.date_grounding` on (candidate, build 5d5375d43) against the branch base 5bd9e8497 with the setting
absent (baseline), on development splits only, through the gbrain-evals decision kit's memory-qa facts lane
(gbrain-evals branch `capy/p2-facts-lane`). Each conversation's sessions are imported as dated conversation
pages and foresights's conversation-facts extractor runs on them; the stored facts are then scored. The
"unresolved" metric is the share of saved facts that still contain a relative time phrase ("yesterday",
"last week", "3 days ago") with no absolute date. A fixed reader answers temporal questions from the saved
facts (fact text and stored date) of the top five retrieved sessions, never from the raw sessions. The
verdict is `dev`, so it cannot set a default. The held-out run is the custodian's.

| Source | Unresolved relative-time facts | QA from saved facts | Guards |
|---|---|---|---|
| LoCoMo temporal (3 conversations, 100 questions) | 6.2% → 1.2% (CI −7.3 to −2.7 pts) | 64.0 → 66.0 (CI −5.9 to +8.3, inconclusive) | recall@5 unchanged; facts per conversation 316 → 314 |
| LoCoMo non-temporal (150 questions) | — | 52.0 → 51.3 (CI −5.6 to +4.7, inconclusive) | recall@5 unchanged |
| LongMemEval-S temporal (11 questions) | 5.5% → 1.7% (CI −4.6 to −2.9 pts) | 54.5 → 54.5 (no question changed) | recall@5 unchanged |

The rule changed once during development. Version 1 kept the phrase beside its date ("two days ago
(2022-09-02)") and stored the event date as `valid_from`. A reader shown the fact under its event date then
applied "two days ago" a second time, so temporal QA from facts fell on LoCoMo (13 questions lost, 4 gained)
although the resolved dates were correct. Version 2 (`date-grounding-v2`) rewrites the phrase as the absolute
date, and the table above measures version 2.

Re-extracting one conversation with the same build moved its temporal QA by up to 9 points between runs, so
extraction variance is as large as the effect being measured. Dev spend was $26.06.

The verdict above counted the extractor's audit rows (one `EXTRACTION_COMPLETE` marker per processed page)
as saved facts. Without them, the pooled unresolved shares are 6.9% → 1.3% on LoCoMo and 6.8% → 2.3% on
LongMemEval-S. The relative drops (−81% and −67%) and every conclusion stand. The held-out run uses the
corrected harness.
