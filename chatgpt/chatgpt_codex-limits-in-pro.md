---
title: "Codex Limits in Pro"
type: note
created: 2026-03-10
updated: 2026-03-10
source: chatgpt-export
conversation_id: 69b08dd6-b9b4-8331-8041-71740108af08
message_count: 4
tags: [chatgpt, import, long-form]
---
# Codex Limits in Pro

> Conversation ID: 69b08dd6-b9b4-8331-8041-71740108af08
> Created: 2026-03-10T21:33:19Z
> Updated: 2026-03-10T21:36:39Z
> Messages: 4

---

## User

So I'm looking at the pricing for ChatGPT right now, and it says, and I'm currently on a Plus account, the pro account is saying currently pro reasoning with GPT 5.4 Pro, unlimited 5.4 and file uploads, unlimited and fast image creation, maximum deep research and information mode, maximum memory and context, expanded project tasks and custom GPTs, expanded access to Sora, expanded priority speed, codex, agent. So I guess my question is, does that mean if I get this for codex, I'm just unlimited, like unlimited all week or all month? Like I can just keep running jobs in codex, in which case it would be cheaper than Claude, which right has limits. Is that, am I understanding this correctly? There's no message cap or anything.

---

## Assistant

Mr. White, no. ChatGPT Pro does **not** currently mean uncapped Codex usage with no cap at all. OpenAI’s Pro plan page says Pro includes **access to the Codex agent**, while the Codex docs separately say Plus and Pro have **included usage limits**, and that once you hit them you can **buy additional credits** or run extra local tasks with an **API key** at standard API rates. citeturn790483view2turn790483view1turn737228view4

OpenAI’s current Codex limits for **ChatGPT Pro** are published as variable ranges because heavier tasks consume more allowance. For **GPT-5.3-Codex**, Pro shows about **300–1500 local messages per 5 hours**, **50–400 cloud tasks per 5 hours**, and **100–250 code reviews per week**. For **GPT-5.1-Codex-Mini**, Pro shows about **1200–6000 local messages per 5 hours**. For **GPT-5.4 in Codex**, Pro shows about **223–1120 local messages per 5 hours**. OpenAI also says the **local-message and cloud-task limits share a five-hour window**, and that **additional weekly limits may apply**. citeturn790483view1

So the practical answer is: **Pro gives you much higher Codex limits than Plus, but it is not unlimited all week or all month. There is a cap.** citeturn790483view1turn737228view5

You can also verify this inside Codex itself: OpenAI says your current limits are visible in the **Codex usage dashboard**, and in the CLI via **`/status`**. citeturn790483view1

If you want, I can help you translate those Codex limits into a rough “hours of real use per week” estimate for your workflow.

---

## User

So then I guess my other question is, how is fast mode impacted by this? The two things that I wanna do is fire off jobs in Premier to Codex agents and have them just fully take small scoped issues. And then And then the other thing I wanna do is using the Codex desktop app, run GPT-5.4 in fast mode to just debug our app extensively. How am I gonna be impacted specifically by these?

---

## Assistant

Mr. White, for those two workflows, Pro gives you a lot more room, but it still behaves like a **metered Codex plan**, not a true no-cap engineering seat. OpenAI’s ChatGPT Pro docs say Pro has unlimited GPT-5 access in ChatGPT subject to abuse guardrails, while Codex has its **own separate usage model and limits** based on model, task size, and whether the work is local or cloud-run. citeturn943965search9turn842016view2turn842016view1

For **parallel small-scoped agent jobs**, the main impact is that parallelism burns the same pool faster. The Codex app is built for running threads in parallel, and Codex CLI multi-agent workflows can spawn multiple workers, but usage still comes out of your plan’s Codex allowance. For ChatGPT Pro on **GPT-5.4**, OpenAI currently publishes about **223–1120 local messages per 5 hours**. That is the pool your local debugging and local agent work draw from, so four similar parallel issue-fix threads will usually eat that window roughly four times faster than one thread would. citeturn842016view3turn258990view0turn842016view1

If by “fire off jobs” you mean **cloud-delegated Codex tasks**, the published included Pro limits are much better on **GPT-5.3-Codex** than on GPT-5.4. OpenAI’s current Pro table shows **GPT-5.3-Codex** at roughly **50–400 cloud tasks per 5 hours** and **100–250 code reviews per week**, while the **GPT-5.4** row currently shows **no included cloud-task or code-review allotment** in that table. GPT-5.4 is available in Codex Cloud, but the included-usage table does not currently grant a GPT-5.4 cloud-task bucket the way it does for GPT-5.3-Codex. citeturn842016view1turn514843search4

For **GPT-5.4 Fast mode in the Codex desktop app**, the rule is straightforward: Fast mode is available on **GPT-5.4 only**, it gives about **1.5x speed**, and it consumes credits at **2x the normal rate**. It works when you sign in with your **ChatGPT account**; with an API key, Codex uses standard API pricing and `/fast` is unavailable. citeturn842016view0turn514843search11

So for your “debug our app extensively” use case, **Fast mode will make you hit your included GPT-5.4 local allowance much sooner** than normal GPT-5.4. OpenAI does not publish a separate Fast-mode message cap, but because Fast mode doubles credit consumption and GPT-5.4 local tasks average about **7 credits per message**, the practical effect is roughly **half as many comparable debugging turns** before you exhaust the same included pool. Using the published GPT-5.4 Pro local range, that works out to a rough **Fast-mode equivalent of about 112–560 comparable local turns per 5 hours**, with real results varying by repo size, context retained, and task complexity. citeturn842016view0turn842016view1turn943965search1

The clean takeaway is this: for **small delegated issue work**, Pro is strongest if you use **GPT-5.3-Codex** for cloud tasks and reviews; for **interactive local debugging**, Pro + **GPT-5.4** is strong, but **Fast mode is a premium convenience, not free extra throughput**. If you want very fast local iteration, Pro also includes **GPT-5.3-Codex-Spark** in research preview, which OpenAI describes as optimized for near-instant coding iteration and governed by its **own separate usage limit**. citeturn842016view1turn842016view4turn754262search1

You can check the live truth for your account in the **Codex usage dashboard**, and in the CLI with **`/status`**. citeturn842016view1

If useful, I can turn this into a practical recommendation for your team like: “use model X for cloud issue delegation, model Y for local debugging, and switch to Fast only in these cases.”
