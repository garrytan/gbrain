# P4 always-loaded core memory: held-out verdict

The custodian ran the core gate on BEAM-100k sealed (all 14 conversations,
the 56 `preference_following` and `instruction_following` questions) under
the preregistration in
[`docs/eval/CORE_MEMORY_PREREGISTRATION.md`](../../CORE_MEMORY_PREREGISTRATION.md).
Every arm got the same question-blind standing-preferences page; only arm C
marked it core, so C − A′ measures always-loaded delivery against retrieval of
the same page. The sealed receipts stay with the custodian; the eval records
are in garrytan/gbrain-evals#82. Verdict: **fail**, so `memory.core.enabled`
defaults to `false`. Core stays available as an opt-in.

## Gate

The preregistered bar is C − A′ ≥ 0 on every model not at ceiling, and
neither category's CI entirely below −2.0 points. 95% cluster bootstrap
intervals resample whole conversations.

| Model | Questions | A′ | C | C − A′ (points) | 95% CI |
|---|---|---|---|---|---|
| claude-sonnet-5-5 | 56 of 56 | 86.8% | 91.4% | +4.6 | [−0.4, +10.7] |
| gpt-6.1-sol | 56 of 56 | 88.1% | 85.7% | **−2.4** | [−5.4, +0.3] |
| claude-opus-5-5 | 32 of 56 | | | +3.4 | |
| claude-fable-5-1 | 28 of 56 | | | +2.3 | |

gpt-6.1-sol is below zero, so the model-level rule fails. No category's CI
lies entirely below −2.0, so the category guard alone would not have failed.
claude-opus-5-5 and claude-fable-5-1 stopped at their budget caps; their
remaining questions are still running and are recorded here when they land.
They cannot change the outcome, which gpt-6.1-sol already decides.

By category:

- claude-sonnet-5-5, preference following: +8.6 points, CI [+1.8, +17.5].
- gpt-6.1-sol, instruction following: 91.1% → 85.7% (−5.4 points). This is
  the drop that fails the gate.

## Cost per correct answer (reported, not gated)

| Model | A′ | C |
|---|---|---|
| claude-sonnet-5-5 | $0.78 | $0.83 |
| gpt-6.1-sol | $0.32 | $0.37 |
| claude-opus-5-5 | $1.19 | $1.39 |
| claude-fable-5-1 | $2.97 | $2.83 |

## Diagnosis lead

The failure is gpt-6.1-sol on instruction following: with the standing
instructions loaded at the top of every session, it followed them less often
than when it found the same page by retrieval. Where to look first is how the
core block reads to that model (its placement before the conversation, its
"always loaded" framing, and whether instructions in a profile block are
treated as context rather than as instructions in force), comparing its C and
A′ answers on the failing instruction questions. A change there needs a new
preregistered run; this verdict stands for this build.

## Defaults

- `memory.core.enabled`: `false`. An owner who wants it turns it on with
  `gbrain config set memory.core.enabled true` and marks pages with
  `gbrain core init` or `gbrain core add`; `gbrain core` and `gbrain doctor`
  say so when pages are marked while it is off.
- `memory.pressure.enabled`: `true`, from its own pass
  ([pressure verdict](../p4-heldout-pressure-2026-10-05/README.md)).
