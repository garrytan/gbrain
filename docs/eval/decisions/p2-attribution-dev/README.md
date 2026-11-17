# Speaker attribution: dev verdict

This compares `facts.attribution` on (candidate) and off (baseline) on the same build, 5d5375d43, which carries the
extractor's speaker rule. The storage work that followed (`facts.attributed_to`, migration v204) also adds an
`attributed_to` field to the extractor schema; that change was not part of this run. Both arms ran on the
LongMemEval-S development questions through the decision kit's memory-qa facts lane. foresights's conversation-facts
extractor runs on the dated conversation pages, and a fixed reader answers from the saved facts of the top five
retrieved sessions. This is a `dev` verdict, so it cannot set a default.

| Questions | Off | On | Δ (95% CI) |
|---|---|---|---|
| single-session-assistant (30) | 23.3% | 60.0% | +36.7 pts (+20.0 to +53.3), superiority pass |
| single-session-user (19, guard) | 73.7% | 73.7% | 0 (no question changed), non-inferiority pass |

On the baseline, the extractor keeps the user's side of each conversation and drops what the assistant said (see
`../p2-attribution-gate-dev/`). With the speaker rule on, assistant answers and recommendations are saved as their
own facts ("Assistant recommended …"), so questions about them become answerable from memory.

One question per arm lost its facts: an extractor `malformed_output` error stopped that conversation's extraction.
These rows score 0 and stay in the comparison. The fact-count comparison is left out because those rows have no
count. Dev spend was about $62.
