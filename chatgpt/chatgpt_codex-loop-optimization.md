---
title: "Codex Loop Optimization"
type: guide
created: 2026-03-29
updated: 2026-03-29
source: chatgpt-export
conversation_id: 69c95a97-c6fc-83e8-bec1-23b0887a8823
message_count: 5
tags: [chatgpt, import, code]
---
# Codex Loop Optimization

> Conversation ID: 69c95a97-c6fc-83e8-bec1-23b0887a8823
> Created: 2026-03-29T17:02:03Z
> Updated: 2026-03-29T19:03:33Z
> Messages: 5

---

## User

im using gstack in confuctor. now one thing i really need is to get pages to pass the gmail 100ms test. the problem is that when i use codex gpt-5.4 particularly but also sometime in claude opus 4.6, it will run one loop of experiemtns decide they made things worse not better than loop again get it right shave off 100ms then loop again etc. except with 5.4 it loves to stop at the end of each loop. for no reason. it should have everything it needs to run all night and only stop when an experiement stack gets it down to passing the ligthchouse budget.

---

## Assistant

I’m checking whether “gstack” and “confuctor” map to specific product settings, then I’ll translate your goal into a concrete workflow that prevents the model from stopping after each optimization loop.

---

## User

conductor

---

## Assistant

I’m narrowing this to two parts: how Codex behaves in agent loops, and how to structure the stop condition so it only exits on success criteria instead of after a single pass.

---

## Assistant

Mr. White, the main fix is to change the **exit condition**, not the optimizer. In OpenAI’s agent loop, a run commonly ends when the model emits a normal response instead of another tool call, and the Codex prompting guide specifically warns that asking for plans, preambles, or status updates during the rollout can make Codex stop before the rollout is actually complete. citeturn805441view0turn805441view1turn221471view0

For your setup, I would do four things.

1. **Run it in non-interactive mode for overnight jobs.** `codex exec` is the official mode for scripted runs that should finish without human interaction, and `--ask-for-approval never` is the documented approval mode for non-interactive runs. `--full-auto` still uses `on-request` approvals, so it can pause. citeturn221471view2turn311060view0turn311060view2

2. **Put the persistence rules in `AGENTS.md` or the Conductor skill, not only in the prompt.** Codex reads `AGENTS.md` before work starts, and OpenAI recommends using it for durable guidance. Their best-practices doc also says to define a clear “done when” condition. citeturn221471view1turn221471view3

3. **Remove any instruction that encourages loop-by-loop narration.** For Codex, that chatter is counterproductive. The Codex prompting guide explicitly says to remove prompting for upfront plans, preambles, and status updates because those can cause abrupt stopping. citeturn221471view0

4. **Make the only valid terminal states measurable.** gstack already gives you `/benchmark` for baselining page load times and CWV/resource sizes, and `/browse` for real Chromium actions at about 100 ms per command. Use those as the inner verifier, and only let the run end on pass, true blocker, or attempt cap. citeturn805441view2

Use something like this in your repo `AGENTS.md` or in the Conductor performance agent:

```md
## Overnight performance optimization mode

You are responsible for reducing target pages until they pass the Lighthouse performance budget.

Rules:
- Do not stop after an iteration summary.
- Do not hand back control just because one experiment failed.
- Do not ask for confirmation between iterations.
- Do not produce interim status messages unless you hit a hard blocker.

Loop:
1. Establish a fresh baseline with the project benchmark command.
2. Identify the biggest bottleneck affecting the current budget miss.
3. Apply the smallest high-confidence change likely to improve the metric.
4. Re-run the benchmark on the same page and compare before/after.
5. If worse, revert and try a different hypothesis.
6. If better, keep the change and continue.
7. Repeat until one terminal condition is met.

Terminal conditions:
- PASS: all target pages meet the Lighthouse budget.
- BLOCKED: a concrete external blocker prevents further progress.
- EXHAUSTED: 12 consecutive non-improving experiments after the best result.

Output policy:
- Return only when PASS, BLOCKED, or EXHAUSTED.
- Final response must include: best before/after metrics, exact changes kept, exact changes reverted, and next best hypotheses.
```

Then run it as a non-interactive task instead of a chatty session:

```bash
codex exec \
  -m gpt-5.3-codex \
  --ask-for-approval never \
  --sandbox workspace-write \
  "Reduce the target pages until they pass the Lighthouse budget. Follow AGENTS.md exactly. Keep iterating without stopping after intermediate results. Revert regressions. End only on PASS, BLOCKED, or EXHAUSTED."
```

I would also add a final schema so the client only accepts one of those terminal states:

```json
{
  "type": "object",
  "properties": {
    "status": { "enum": ["PASS", "BLOCKED", "EXHAUSTED"] },
    "best_before": { "type": "object" },
    "best_after": { "type": "object" },
    "kept_changes": { "type": "array", "items": { "type": "string" } },
    "reverted_changes": { "type": "array", "items": { "type": "string" } },
    "next_hypotheses": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["status", "best_before", "best_after", "kept_changes", "reverted_changes", "next_hypotheses"]
}
```

Then invoke with `--output-schema`. Codex supports output schemas for `codex exec`, which helps make the final response shape explicit. citeturn221471view2

One more point: for long autonomous coding runs, OpenAI’s Codex guide recommends the **codex-tuned model** and says it is built for long-running autonomy; it specifically names `gpt-5.3-codex` as the Codex-tuned API model and recommends higher reasoning for harder agentic work. I would use that for overnight perf loops before plain GPT-5.4 unless you specifically need GPT-5.4’s browser-debugging behavior. citeturn221471view0turn631036search12

So the short diagnosis is this: your stack is probably rewarding “report progress” as a valid completion event. Change it so only **budget pass / blocker / attempt cap** can terminate, move the rule into `AGENTS.md` or a skill, and run it through `codex exec` non-interactively.


## See Also
- [[chatgpt/chatgpt_codex-52-prompt-optimization]]
- [[chatgpt/chatgpt_add-column-index-to-loop]]
- [[chatgpt/chatgpt_claude-ralpha-loop]]
- [[chatgpt/chatgpt_cloud-automation-loop]]
- [[chatgpt/chatgpt_coderabbit-auto-loop]]
