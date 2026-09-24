# Experimental answer-evidence packets

The completed [pilot results](ANSWER_PACKET_RESULTS.md) were negative: zero wins
and five losses on 60 holdout questions. Production defaults remain unchanged.

This experiment changes only the text shown to the answering model. It compares
the current full-session reader with original conversational-round excerpts over
the same saved retrieved sessions. It does not run retrieval, generate summaries,
change gold answers, or enable a production feature.

Inputs are the public LongMemEval-S cleaned dataset and the September 6 D1 receipt
from `garrytan/gbrain-evals`. Their SHA-256 pins are checked before use. That
receipt preserves session IDs and order, not historical chunk rankings or answer
text. Results describe fresh answers over historical candidates, not the current
retrieval system's accuracy.

## Run the comparison

From the repository root, with Bun dependencies installed:

```bash
bun scripts/eval-answer-packet.ts prepare OUT DATASET RECEIPT
bun scripts/eval-answer-packet.ts dev OUT DATASET RECEIPT v1
bun scripts/eval-answer-packet.ts freeze OUT DATASET RECEIPT v1
bun scripts/eval-answer-packet.ts holdout OUT DATASET RECEIPT v1
bun scripts/eval-answer-packet.ts report OUT
```

`prepare` is keyless and makes no provider calls. `dev` and `holdout` require
`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` and spend money. They share a $20 ceiling
in one output directory. Development stops at $8, leaving $12 for holdout. Do not
start a new directory to bypass exhausted or uncertain accounting. Models are
Sonnet 4.6 for reading and GPT-4o for judging, without automatic substitution.

Before freezing, an optional second development run with `v2` widens the selected
rounds and neighboring context. It reuses baseline answers and judges, preserving
both candidates' results. Freeze the chosen variant once. Development cannot run
after freezing. Holdout checks the code, data, model, prompt, pricing and selection
hashes. Never tune on holdout.

The split is deterministic: 12 answerable development questions, two per category
from dev40, plus six abstention questions; 48 holdout questions, eight per category
from decision430, plus 12 abstention questions. Related IDs, duplicate question
text and identical history-ID sets are grouped. Historical judgments and gold
answers do not participate in selection.

## What changes

The formatter accepts only a question and supplied original sources. It scores
whole rounds using lexical query terms, keeps adjacent rounds and user
qualifications, preserves within-session order, and retains assistant text.
Selected turns carry composite source/session identities, turn indices, substring
bounds, original speakers and content hashes. Missing dates stay missing. The
formatter cannot read a brain or resolve source pointers.

Omitted turn indices are visible. Sessions without a lexical anchor stay whole.
Sources that would hit the existing reader's per-session cap are rejected before
dispatch instead of claiming truncated turns were presented.
Oversized packets fall back to the unchanged baseline. Complete requests are
also checked with Anthropic's free token-count endpoint; candidates that count
larger fall back again. That endpoint returns an estimate, so the common
input/output ceiling includes 1,024 input-overhead tokens and the unchanged
512-token output allowance. Reported usage is checked against it. Neither arm is
padded.

System prompts, question dates, generation settings, the existing data boundary
and judge rubrics stay fixed. Structured speakers never become API message roles.
Sanitizer changes and fallbacks are recorded separately from original text.
Selection remains heuristic, not a guarantee that every answer detail survives.

## Spending and interruption

Each paid provider attempt acquires a durable reservation through the existing
invocation guard before dispatch. Admission uses a conservative UTF-8 byte bound,
input overhead, the output cap, and cache-write pricing. SDK retries are disabled.
The journal records full gateway requests and responses, untruncated judge text,
provider model IDs, usage and priced cost. Unknown usage retains its reservation
and blocks automatic replay, including after restart.

Completed calls are reused only for matching requests. Partial journals, changed
manifests, ambiguous interrupted calls, or leftover writer locks require
inspection. Never delete paid journals or assume a timeout was free. Artifacts
use owner-only permissions; keep raw benchmark text out of public commits because
it can contain real names.

Costs are estimates from reported usage and pinned canonical prices, not provider
invoices. If a canonical cache-read discount is absent, full input pricing is
conservative. Reports separate priced usage from unknown reserved exposure and
include development as well as holdout spending.

## Interpretation

Report both-right, both-wrong, improved and worsened answers, all six categories,
abstention, retrieval-complete/incomplete subsets, errors, and the paired
question-bootstrap interval. Keep every regression and incomplete pair visible.

The predeclared pilot threshold is at least three net improvements in 60 cases,
no correct-to-wrong abstention changes, no negative-net category, no provenance
violation, and candidate reader-plus-judge cost no higher than baseline. A tie or
loss means the packet did not help on this set. Even a passing pilot is not
permission to change the production default or a claim of general superiority.
