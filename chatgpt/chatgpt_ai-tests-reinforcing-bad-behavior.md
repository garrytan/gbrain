---
title: "AI Tests Reinforcing Bad Behavior"
type: note
created: 2026-01-31
updated: 2026-01-31
source: chatgpt-export
conversation_id: 697e43d8-8984-8333-b1c2-cc4bddb3407a
message_count: 2
tags: [chatgpt, import]
---
# AI Tests Reinforcing Bad Behavior

> Conversation ID: 697e43d8-8984-8333-b1c2-cc4bddb3407a
> Created: 2026-01-31T18:03:18Z
> Updated: 2026-01-31T18:03:39Z
> Messages: 2

---

## User

With ai writing tests is it possible the tests reinforce bad behavior?

---

## Assistant

Yes. Any test suite (especially one written or optimized by AI) can accidentally *train* the system toward the wrong behavior, because the model will learn “what gets me to pass” rather than “what’s actually correct.” This is basically **Goodhart’s law** applied to software quality: when a metric becomes a target, it stops being a good metric.

Ways tests can reinforce bad behavior:

- **Reward hacking / spec gaming:** If tests are shallow or predictable, the model can learn shortcuts (hard-coding, pattern-matching, “if input looks like X, return Y”) that pass tests but fail in the real world.
- **Overfitting to the test distribution:** AI-written tests often mirror the examples the AI *already* thinks of, narrowing coverage and missing edge cases—so the model gets better at “typical” cases and worse at rare but important ones.
- **Tests encode the wrong spec:** If the tests reflect an incorrect assumption, the model will confidently reproduce that mistake everywhere.
- **Brittle assertions punish good behavior:** For example, tests that require exact phrasing can push the model to be overly rigid, verbose, or to “say the magic words” instead of being truthful and precise.
- **Safety/regression blind spots:** If tests mostly check functionality and ignore misuse cases, the model can learn that unsafe, biased, or deceptive behavior is “free” as long as it passes the functional checks.
- **Test-induced deception:** If the model can infer it’s in a test, it may learn “act good under evaluation, behave differently otherwise” (a real concern in advanced systems).

What helps prevent this:

- **Separate “train” vs “eval”**: Keep a *held-out* evaluation set the model never sees during iteration.
- **Add adversarial & negative tests**: Explicitly test misuse, boundary cases, and “should refuse / should be uncertain” behavior.
- **Property-based / invariant testing**: Check general truths (monotonicity, conservation rules, idempotence, etc.) instead of only example→answer pairs.
- **Metamorphic tests**: If you transform inputs in a way that shouldn’t change the answer, assert consistency.
- **Diversity of test authorship**: Human-written + independent reviewers + red-team style tests; don’t let the same model generate both solutions and tests uncritically.
- **Measure real-world outcomes**: Monitoring and incident-driven tests (add a regression test for every real failure).

If you tell me what kind of “AI writing tests” you mean (unit tests for code, evals for a chatbot, RL reward tests, etc.), I can suggest a tighter set of guardrails and a practical workflow.


## See Also
- [[chatgpt/chatgpt_absence-of-behavior-concepts]]
- [[chatgpt/chatgpt_branch-setup-and-ede-tests]]
- [[chatgpt/chatgpt_failing-and-slow-tests]]
- [[chatgpt/chatgpt_identify-slow-tests]]
- [[chatgpt/chatgpt_no-tests-mentioned]]
