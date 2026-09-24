# Reading notes: real gains, with grading and output-limit caveats

**Keeping the evidence intact and asking for notes improved the automated
GBrain score, and source inspection confirms real examples of better answers.**
It also produced truncated responses and grading artifacts. This supports
further work on the reader, not switching the production default yet.

The 361-question GBrain comparison is complete. The separate 500-question
paper replication is still running. The [frozen protocol](READING_NOTES_REPLICATION.md)
records the cohorts, treatment, original prompt functions, model snapshots,
date differences, controls and receipt hashes. Neither this experiment nor
the earlier [failed excerpt selector](ANSWER_PACKET_RESULTS.md) changed
retrieval or production settings.

The [public paired-label receipt](reading-notes-transfer.ndjson) contains all
361 original comparisons, 12 baseline repeats and 28 repeat-graded
discordances, without conversation or answer text. Its SHA-256 is
`fe54ecf5193aab80005d330fa9173961f6c62da31b374e3a75159fa2fa296a9d`.

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

Notes used **2.8 times as many output tokens** and cost **5.0% more for the
reader calls**. The long, unchanged input accounts for most reader spending.
That extra generation is intended work, not evidence of a same-work latency
regression; no latency claim is made here.

The completed transfer phase, including its judges, repeated baselines and
repeat grading, used **1,524 settled calls and $36.609600** at the pinned
canonical prices. There were no recorded call errors or unknown-usage
settlements. Adding the earlier $8.0127305 pilot gives **$44.6223305** through
this completed phase, before the ongoing paper replication. The operator
removed the spending ceiling before this follow-up began. These are
usage-priced accounting estimates, not provider invoices.

## Remaining work

Finish the frozen four-condition, 500-question paper replication and report
its results separately. A separate model has now audited every transfer
discordance and cutoff without inspecting oracle outcomes; its source-level
findings were checked against the stored records, not treated as replacement
labels. Keep full-session presentation as the production default; do not
infer rollout approval from a positive benchmark comparison.
