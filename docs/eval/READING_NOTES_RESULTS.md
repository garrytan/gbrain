# Reading notes: real gains, with grading and output-limit caveats

**Keeping the evidence intact and asking for notes helped in both completed
comparisons.** We reproduced the paper's positive reading effect and measured
a smaller positive transfer to the existing GBrain reader. Source inspection
confirms real improvements, but grading artifacts and nine truncated GBrain
responses mean this is not a production-default recommendation.

Both frozen experiments completed: 361 fresh GBrain comparisons and all 500
questions in the four-condition paper replication. The
[protocol](READING_NOTES_REPLICATION.md) records the cohorts, treatment,
original prompt functions, model snapshots, date differences, controls and
receipt hashes. Neither this experiment nor the earlier
[failed excerpt selector](ANSWER_PACKET_RESULTS.md) changed retrieval or
production settings.

The [public paired-label receipt](reading-notes-transfer.ndjson) contains all
361 original comparisons, 12 baseline repeats and 28 repeat-graded
discordances, without conversation or answer text. Its SHA-256 is
`fe54ecf5193aab80005d330fa9173961f6c62da31b374e3a75159fa2fa296a9d`.

## Published reading experiment: effect reproduced

Using only the published oracle supporting sessions, the authors' original
prompt builder and grader, and the pinned GPT-4o snapshot:

| Format and reading method | Published Figure 6 | This run | Correct / 500 |
|---|---:|---:|---:|
| Natural language, direct | 86.2% | 84.8% | 424 |
| JSON, direct | 82.2% | 85.0% | 425 |
| Natural language, notes | 91.0% | 92.2% | 461 |
| JSON, notes | 92.4% | 92.6% | 463 |

The primary combined contrast improved by **7.8 percentage points**, with
**49 judged wins and 10 losses**. Its paired 95% bootstrap interval was
**[+5.0, +10.8] percentage points**. This reproduces the direction and rough
size of the published effect, not every historical percentage or completion.

The factorial controls matter more than the best single cell:

| Matched contrast | Net answers | Difference | Paired 95% interval |
|---|---:|---:|---:|
| Notes versus direct, natural language | +37 | +7.4 points | [+4.4, +10.6] |
| Notes versus direct, JSON | +38 | +7.6 points | [+4.8, +10.4] |
| JSON versus natural language, direct | +1 | +0.2 points | [-1.4, +1.8] |
| JSON versus natural language, notes | +2 | +0.4 points | [-1.8, +2.6] |

**Notes helped in both formats; JSON alone did not demonstrate a benefit.**
There is no evidence here that GBrain needs a new JSON memory representation.
All intervals describe question sampling, not grader validity or generation
variability. The corpora and readers differ across phases, and the full
oracle set overlaps the fresh transfer cohort; these are not two independent
confirmation datasets.

All 2,000 primary oracle responses finished without hitting the 800-token
output limit. Regrading the 59 primary discordances changed **0/118 labels**.
The 12 identical-prompt baseline controls went **10/12 → 9/12**; nine outputs
were byte-identical, and the score-changing case had different output text.
Stable repeat grading still does not establish factual correctness.

The [oracle paired-label receipt](reading-notes-oracle.ndjson) records all four
grades on every question, plus controls and repeat grading. Its SHA-256 is
`f411f222d003f71240d8fcccc6c1677baad67971dba9618a8789797bc0e70cb3`.

### Every initial oracle regression

The following observations retain all original labels. They distinguish real
reasoning problems from reference/rubric ambiguity, rather than discarding
unfavorable rows.

| Question ID | Source-aware observation |
|---|---|
| `c8090214_abs` | Notes assume an unmentioned tablet purchase occurred alongside a recorded phone purchase, then fabricate the requested interval. The baseline correctly says the date is unavailable. |
| `9a707b81` | Notes use the session date instead of “yesterday” and answer 20 rather than 21 days. That is an actual one-day reasoning error, but rejecting it conflicts with the official grader's stated off-by-one tolerance. |
| `00ca467f` | Notes add a physical-therapy visit to the count of doctor appointments. This changes the category rather than finding an omitted doctor appointment. |
| `ec81a493` | Both answers contain 500, but the source's limited-edition object is a poster, while the question asks about album copies. Notes expose that distinction and still infer the album count. This is a source/reference ambiguity, not a clean numeric regression. |
| `71017277` | The source names a chandelier, not jewelry. Notes reject the question's premise; the baseline gives the reference relative while describing the chandelier. A lower benchmark score does not establish a worse source-grounded answer. |
| `8077ef71` | Notes make a one-day calendar arithmetic error, 25 instead of 26. As with `9a707b81`, the negative grade is inconsistent with the stated off-by-one tolerance. |
| `gpt4_7bc6cf22` | Notes answer the interval between publication and reading, rather than between reading and the question date. This is a genuine wrong-interval failure. |
| `d24813b1` | Notes omit the previously successful cake that anchors the personalization rubric; the baseline includes a related option. Rubric sensitivity limits a binary interpretation. |
| `gpt4_15e38248` | Notes infer a recent sofa purchase merely from interest in matching cushions, inflating the count from four to five. |
| `46a3abf7` | Notes stop counting an older tank without evidence that it was disposed of. The reference retains all three tanks; “old” versus “currently have” leaves a wording caveat. |

Concrete oracle gains include recovering the two purchases totaling $300,
applying the update from 37 to 38 coins, using the correct audiobook start
date to total eight rather than nine weeks, and explicitly distinguishing
tennis from table tennis in `f685340e_abs`. That last case is a real oracle
improvement but a false-positive transfer grade: a shared question ID does
not make outputs from different reader conditions equivalent.

Not every oracle win is equally convincing. In `a2f3aa27`, both outputs say
the count is near 1,300, yet only notes receive credit; that is not a verified
information gain. In `37f165cf`, the page counts fit the reference, but notes
assign unrecorded completion months to the books. In `gpt4_d9af6064`, notes
treat a device-acquisition date as its setup date. The latter inference is
plausible, but not explicitly established. These findings remain caveats,
not a post-hoc replacement score.

## Completed GBrain comparison

| Metric | Full-session baseline | Same sessions, notes first |
|---|---:|---:|
| Judged correct | 308 / 361 (85.3%) | 324 / 361 (89.8%) |
| Answerable questions | 302 / 354 | 317 / 354 |
| Abstention questions, automated labels only | 6 / 7 | 7 / 7 |
| Output-limit finishes | 0 | 9 |
| Mean output tokens | 87.3 | 244.0 |
| Reader-only usage-priced cost | $17.220423 | $18.086391 |

There were **22 judged improvements and six judged regressions**, a net gain
of 16 answers, or **4.4 percentage points**. Both arms were right on 302
questions and wrong on 31. The paired 95% bootstrap interval was
**[+1.7, +7.2] percentage points**. It describes question-sampling uncertainty,
not reader/judge variability or the reliability of the reference answers.

The predeclared quantitative transfer gate passes under the original grader:
the interval is positive and the abstention score does not decrease. That is
not a production-readiness gate. In particular, the apparent abstention gain
is a grading artifact described below, not a verified improvement in refusal.

| Category, including abstention variants | Questions | Baseline correct | Notes correct | Net |
|---|---:|---:|---:|---:|
| Knowledge update | 52 | 45 | 50 | +5 |
| Multi-session | 96 | 76 | 79 | +3 |
| Single-session assistant | 40 | 40 | 40 | 0 |
| Single-session preference | 20 | 15 | 16 | +1 |
| Single-session user | 49 | 48 | 49 | +1 |
| Temporal reasoning | 104 | 84 | 90 | +6 |

The gain was concentrated where all recorded supporting sessions were
retrieved: **303 → 320 correct out of 345**. The 16 cases with incomplete
gold-session coverage went **5 → 4**. Notes do not repair missing retrieval;
gold-ID coverage also does not prove that every relevant fact is present.

## Concrete improvements checked against original turns

These are source-grounded examples, not just favorable grader votes. Both
arms received the same full source text.

| Question ID | Baseline failure | What notes got right |
|---|---|---|
| `ef9cf60a` | Counted only a $100 gift. | Combined the separately recorded $200 and $100 purchases into $300, excluding a still-planned purchase. |
| `69fee5aa` | Repeated the old count of 37 coins. | Applied the later purchase: 37 + 1 = 38. |
| `a9f6b44c` | Counted three service events as three bikes. | Deduplicated two visits for the same bike, giving two distinct bikes. |
| `d7c942c3` | Used an older paper-list preference. | Used the later explicit switch to the shared list app. |
| `59524333` | Used the earlier 7 p.m. schedule. | Preferred the later explicit 6 p.m. statement. |
| `aae3761f` | Included a suggested future trip in the driving total. | Added the three completed drives: 4 + 5 + 6 = 15 hours. |
| `gpt4_2312f94c` | Compared a preorder date with a purchase date. | Compared actual receipt dates, correctly putting the 20th before the 25th. |

The useful mechanism is visible: retain all the evidence, then reconcile
updates, distinguish plans from completed events, deduplicate entities, and
perform the calculation. This is different from selecting a smaller packet
and hoping the omitted text was irrelevant.
The comparison tests the complete notes instruction, not whether it beats an
equally verbose alternative instruction.

## Grading and variability audit

Rejudging both saved responses for all 28 discordant pairs changed **two of
56 labels**. The repeat grading retained **20 wins and six losses**; two
initial wins became ties. These are selected discordances, not an unbiased
estimate of overall grader accuracy. Initial benchmark labels remain intact.

The 12 predetermined identical-prompt baseline repeats went from **11/12 to
10/12**. Two repeated answers were byte-identical, and one score flipped.
These small controls demonstrate variability; they do not justify subtracting
a guessed noise allowance from the primary result.

Source inspection exposes limitations that repeat grading alone missed:

- `f685340e_abs`: both answers conflate tennis with table tennis and give a
  frequency, although the reference requires refusing that substitution.
  The longer notes answer received credit twice. Do **not** call the reported
  7/7 score verified abstention accuracy or this case a genuine win.
- `66f24dbb`: both answers correctly name the same gift. The initial baseline
  rejection disappears on regrade; this was not a reading improvement.
- `4d6b87c8`: both answers ultimately give 27 against a reference of 25.
  The notes answer's initial credit disappears on regrade. Its reasoning
  treats planned additions as completed, so the initial win is not evidence
  of better updating.
- `51c32626`: notes equate a conference deadline with the individual's actual
  submission date. The baseline correctly notices that the latter is not
  explicitly given. Matching the reference here does not establish a safer
  inference.
- `9aaed6a3`: the notes answer notices that “last Thursday” relative to the
  question date is a different day from “last Thursday” in the older source.
  It loses the benchmark point but identifies a genuine date mismatch.
- `81507db6`: the baseline counts a ceremony the source explicitly says was
  missed. Notes exclude it, but lose against the complete-history reference
  because some supporting sessions were not retrieved. This is not a clean
  example of notes destroying an otherwise supported answer.

These observations do not replace the original scores with hand-adjusted
ones. They narrow the claim: there are real improvements, but the automated
22/6 split is not a literal count of verified better/worse answers.

### Every initial judged regression

| Question ID | Source-aware observation |
|---|---|
| `gpt4_483dd43c` | Notes abstain about which show started first, overlooking an explicit 14-day viewing duration. The baseline matches the reference, although its rationale also expresses uncertainty. Season-versus-series wording limits a strong causal interpretation. |
| `afdc33df` | Notes offer fewer, less specific kitchen-maintenance suggestions and end by offering fresh advice instead. The reference is a personalized-advice rubric, so the binary grade is also a subjective boundary. |
| `9aaed6a3` | Notes correctly distinguish the question's “last Thursday” from the older source's Thursday; the fixed reference does not. |
| `gpt4_e05b82a6` | Notes extract an additional ride as at least one, then omit it from the final total of nine rather than ten. Unnecessary uncertainty discards useful evidence already identified. |
| `81507db6` | Notes correctly exclude a missed ceremony. The third attended ceremony is in an unretrieved supporting session; the baseline reaches the reference count by including the wrong event. |
| `6d550036` | Supporting sessions for an academic project are missing, while a non-gold retrieved session contributes work projects. The baseline reaches the reference number using those work projects; notes count three from the mixed context. Matching the number does not demonstrate the expected supporting reasoning. |

## Response quality and cost

Nine notes responses reached the unchanged 512-token limit, versus none for
the baseline. Their IDs are `95228167`, `0a34ad58`, `75832dbd`,
`gpt4_7fce9456`, `gpt4_a1b77f9c`, `gpt4_f420262c`, `06878be2`,
`a89d7624` and `1a1907b4`. Several end mid-sentence. Seven still received
rubric credit, including the property-count improvement whose explanation
contains the answer before its final list is cut off. A correct benchmark
label is not proof of a complete, usable response.

**Conservative completion sensitivity (existing 512-token receipts, not a new
accuracy run):** If every output-limit finish is counted incorrect, including
the seven of nine notes cutoffs that originally received rubric credit, the
unchanged direct arm stays **308/361** and notes becomes **317/361**. The
paired count is **21 wins and 12 losses**, net **+9 answers (+2.493 percentage
points)**. This stricter treatment explains the released reader's incomplete-
completion policy; it does not replace the original **324/361** notes label,
the frozen protocol, or any original receipt.

Notes used **2.8 times as many output tokens** and cost **5.0% more for the
reader calls**. The long, unchanged input accounts for most reader spending.
That extra generation is intended work, not evidence of a same-work latency
regression; no latency claim is made here.

| Experiment phase, including its grading and controls | Settled calls | Usage-priced USD |
|---|---:|---:|
| Earlier excerpt pilot | 348 | $8.0127305 |
| GBrain notes transfer | 1,524 | $36.6096000 |
| Full four-condition oracle replication | 4,142 | $34.5237000 |
| **Total** | **6,014** | **$79.1460305** |

All **5,666 follow-up calls** have exactly one admission, known-usage
settlement and accepted response, with no error events. The recorded physical
models are Sonnet 4.6 and the specified GPT-4o snapshot. The operator removed
the spending ceiling before the follow-up began. Prices are pinned canonical
accounting estimates, not provider invoices.

The final follow-up call journal hashes to
`effa6227e63abc1c07342cbd7f8e40f3c9e8cd6903dcfcfcf21e48d4b5b45680`;
the outcome journal hashes to
`1a43f83b4613c729120001e9603709cf20d60cf0c2e8b9f28cae51811dfcbd43`.

## Decision

Pursue intact-evidence reading, not another excerpt selector or a JSON memory
rewrite. The original selector still failed; notes now have positive matched
evidence and concrete source-verified wins. The experiment does not isolate
notes from extra deliberation, prove every automated label, or authorize a
production rollout.

A separate model audited every transfer discordance and cutoff without
inspecting oracle outcomes; its findings were checked against the stored
sources, not treated as replacement labels. A separate pass then audited all
59 oracle discordances. Public scores, repeat grades and source-aware
qualifications are kept separate. Keep the existing direct-answer,
full-session production prompt unchanged for now. A subsequent reader change
needs bounded output and fresh validation, not tuning on this now-inspected
benchmark and calling it confirmation.

## Release follow-up (2026-09-25)

The preceding decision was the study-completion recommendation on 2026-09-24,
before an implementation or larger-output completion check. In v0.59.0.0,
the **LongMemEval benchmark reader only** defaults to the tested notes-first
instruction with a 1024-token output cap; `--reader-mode direct` retains the
exact historical v3 prompt and 512-token cap. This does not change `gbrain think`
or external agents, and the failed excerpt selector remains inactive.

A separately authorized bounded [completion smoke](reading-notes-completion-smoke.json)
replayed only the nine original cutoff inputs at 1024 tokens through the
packaged reader request and gateway. All nine ended naturally with nonempty
answers (445–603 output tokens), across nine accounted calls costing $0.562143;
there were no retries. The two previously unusable endings were complete on
inspection. This selected-case check verifies completion, **not a new accuracy
or cost comparison**. All original 512-token grades, paired labels, caveats,
protocol and study spending totals above remain unchanged. The benchmark
records output-limit, empty or unknown finishes as incomplete errors rather
than successful answers and keeps those questions in the judged denominator.
