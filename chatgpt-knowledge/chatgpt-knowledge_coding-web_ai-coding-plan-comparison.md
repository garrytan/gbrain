---
title: "AI coding plan comparison"
type: guide
created: 2025-08-03
updated: 2025-08-03
source: chatgpt-export
topic: coding-web
message_count: 8
tags: [chatgpt, knowledge, coding-web]
---
# AI coding plan comparison

> **Source:** ChatGPT conversation
> **Date:** 2025-08-03T16:39:58Z
> **Messages:** 8
> **Topic:** coding-web

## Question

Hey, so I'm looking at, um, for, uh, AI-assisted coding, we use Cloud Code. Um, and then they have the Anthropic API billing, uh, API console billing, which seems expensive. And then they have their max plan, and their, like, whatever plan, it's like $20 a month, $200 a month. Their $200 a month max plan is what I used last month. Um, and it seems like that's significantly cheaper than doing the console billing, um, which is usage-based. Um, I could be wrong, but that seems to be my experience. Um, then I just checked out Cursor, and I'm on a two-week free trial of Cursor right now, and I'm loving Cursor. And Cursor says that it lets you use Cloud and OpenAI models. Um, and it says that they have a $20 a month plan, I think, and then a $200 a month plan. Oh, there's a $200 a month plan that says it's 20x the usage for both OpenAI and Cloud. Um, and then obviously OpenAI has a couple models. There's a $20 a month OpenAI plan and a $200 a month OpenAI plan, and OpenAI has Codex. Um, um, 

## Answer

Mr. White — here’s the clean take, then the details.

## Bottom line
- **If you mostly code in the IDE and prefer Claude:** **Cursor Ultra ($200/mo)** is the best value. It gives you **high usage of Claude _and_ OpenAI** inside one editor, plus agents and repo-aware tools. Anthropic’s **Claude Max ($200/mo)** is powerful but **Claude‑only** and now has **weekly rate limits** for Claude Code. citeturn0search5turn0search4turn1search3  
- **If your usage is light–moderate:** **Cursor Pro ($20/mo)** + (optionally) **bring your own API keys at cost** covers most day‑to‑day coding; you can top up as needed. citeturn0search1turn1search0  
- **Add for reviews/autopilot:** **GitHub Copilot Pro ($10) or Pro+ ($39)** is inexpensive and strong for inline suggestions, PR summaries, and automated code review. Keep it if you lean on GitHub workflows. citeturn0search3turn2search3turn2search5turn2search9  
- **ChatGPT Pro ($200)** is great for heavy research/reasoning (o1/o4), but less bang‑for‑buck purely for IDE coding if you already have Cursor Ultra. (Note: **Codex is deprecated**; use GPT‑4o/o1.) citeturn0search6  

---

## Plan-by-plan (coding focus)

**Anthropic (Claude) — consumer plans**
- **Pro — $20/mo.** General Claude access; Claude Code included but with lower limits than Max. **Weekly limits** announced for late Aug 2025. API usage is separate (metered). citeturn0search0turn1search3  
- **Max — $200/mo.** Claude‑only, **Claude Code** + advanced features; **new weekly rate limits** apply starting Aug 28, 2025. Good if you live in Claude.app, but no OpenAI access. citeturn1search9turn1news21  
- **Anthropic API (Console billing).** Pay‑as‑you‑go: e.g., **Sonnet 4 ≈ $3/MTok (input), $3.75/MTok (output)**. Heavy automation can outrun flat subscriptions quickly. citeturn0search8  

**Cursor (AI code editor)**
- **Pro — $20/mo.** Unlimited “Tab/Auto” usage **plus ~$20/mo of frontier model credits at API pricing**, with option to buy more at cost; supports **Claude + OpenAI + BYO keys**. citeturn0search1  
- **Ultra — $200/mo.** **“20× usage”** vs Pro across **OpenAI + Claude (and others)**; predictable flat cost for heavy coding/agents. **BYO keys** still supported. citeturn0search5turn0search4turn1search0  

**OpenAI (ChatGPT)**
- **Plus — $20/mo**; **Pro — $200/mo** (unlocks o1/o4 with higher limits). Good for reasoning/explanations; IDE integration depends on your editor. citeturn0search2turn0search6  

**GitHub Copilot (IDE + GitHub)**
- **Pro — $10/mo; Pro+ — $39/mo** (individual). Strong **inline completions, chat**, **PR summaries**, and **AI code review**; fits neatly with Actions/PR workflows. citeturn0search3turn2search2turn2search5turn2search9  

---

## Interpreting your pricing observation
Your read is right: **Claude Max ($200)** can feel cheaper than raw **API metering** if you’re hammering the tool; a small set of users have consumed massive compute on Max, which is why **Anthropic added week

*(Answer truncated — 4965 chars total)*

## Question

You keep mentioning that Codex is retired or depreciated. Are you referring to the Codex product, which allows you in the web to fire off multiple tasks that spin up in their own environments and open up pull requests? Are you referring to the actual Codex model? Or are you referring to the Codex CLI?

## Answer

Certainly, Mr. White. When I mentioned that “Codex is deprecated,” I was referring to **multiple distinct entities**—it’s crucial to distinguish between them:

---

## 🧠 1. **The original Codex *model*** (2021 GPT-3-based)
- Launched in 2021 as a GPT-3 derivatives trained specifically on code.
- OpenAI **officially discontinued support for the Codex API on March 23, 2023**. After that, developers were encouraged to switch to newer models like GPT-3.5-Turbo and GPT-4citeturn0search12turn0search26turn0search28.
- That version powered early tools like GitHub Copilot until more advanced GPT-4 models took overciteturn0search26.

---

## 2. **Codex as the cloud-based *agent tool*** (released May 2025)
- This is a **completely new product**, separate from the old model.
- Powered by the **codex-1 model**, a fine-tuned version of OpenAI’s o3 series optimized for software engineering.
- Functions as a **cloud-based agent**: can spawn parallel tasks, sandboxed environments, run tests, fix bugs, produce PRs, etc., all via ChatGPT Pro/Team/Enterprise interfaceciteturn0search0turn0news21turn0news23turn0news22turn0search4.

---

## 3. **Codex CLI** (terminal-based open-source tool)
- A **command-line interface**, initially in TypeScript, now **rewritten in Rust** for enhanced performance and securityciteturn0search14turn0search6turn0search17turn0search3turn0search15.
- The CLI **leverages OpenAI’s latest o-series models** (e.g. o4-mini, o3, GPT-4.1), *not* the old 2021 Codex model. OpenAI explicitly warns not to confuse the CLI tool with the deprecated modelciteturn0search3turn0search15turn0search1.

---

### ✔️ Summary Table

| Codex Variant            | Status / Model Used                  | Description                                                 |
|--------------------------|--------------------------------------|-------------------------------------------------------------|
| Original Codex **model** (2021) | Deprecated since March 23 2023     | GPT-3 code model, formerly powering older coding tools      |
| Codex **agent tool** (2025)     | Powered by **codex-1** (o3-based)  | Cloud agent in ChatGPT: PR generation, bug fixes, sandboxed execution |
| Codex **CLI** (2025)            | Uses o3/o4-mini, GPT-4.1            | Local terminal-based AI assistant—not the old model         |

---

### ✅ So when I said “Codex is deprecated,” I meant:
- The **old 2021 Codex model** is no longer supported.
- Meanwhile, **OpenAI revived the name** for an entirely new **cloud agent** and a separate **CLI tool**, both active and evolving in 2025—but neither rely on the original deprecated model.

Let me know if you'd like more on how the CLI compares to Claude Code or Cursor tools.

## Question

Yeah, so I'm really thinking I'm talking about the new Codex product, not the old model, when I was talking about it.

## Answer

Got it — you’re talking about **the new Codex product** (the 2025 cloud-based agent system that spins up isolated environments, runs tasks in parallel, and opens PRs), not the old 2021 Codex model.  

That means:
- It’s **not deprecated** — it’s actually one of OpenAI’s flagship pro features right now.
- It runs on **codex-1**, a fine-tuned variant of the o3 reasoning models, so it’s a lot stronger than the old GPT-3-based Codex.
- Its strength vs. Cursor/Claude Code is in **multi-step autonomy** — it can take a high-level objective, break it down into subtasks, execute them in parallel sandboxes, run tests, debug, and produce PRs without you babysitting every step.
- Pricing ties into your **ChatGPT Pro ($200)** or Team/Enterprise plan — no separate metered API billing for Codex itself. The “cost” is just that flat plan tier.

If you want, I can map out **new Codex vs. Cursor agents vs. Claude Code** for day-to-day repo work so you can see where each shines and what’s redundant. That way you can decide whether you even need more than one.  

Do you want me to run that side-by-side?

## Question

Yeah, let's do that.

## Answer

Alright, Mr. White — here’s the **side-by-side breakdown** of the new **Codex** (OpenAI cloud agent), **Cursor agents**, and **Claude Code**, focused on **day-to-day repo work**.  

---

## **1. Core Capabilities**

| Feature / Tool | **OpenAI Codex** (2025 cloud agent) | **Cursor Agents** | **Claude Code** |
|---|---|---|---|
| **Autonomy** | High — multi-step task planning & execution across *parallel* sandboxes; merges into PRs | Medium — works inside your repo with awareness; no multi-sandbox parallelization | Medium — strong reasoning, but single threaded; runs in Anthropic’s environment |
| **Context source** | Can ingest full repos, issue trackers, docs | Repo open in Cursor or uploaded context | Repo uploaded or linked (Claude.app or API) |
| **Model** | `codex-1` (fine-tuned o3 reasoning) | Any model you choose (Claude, GPT-4o, o1, etc.) | Claude 3.5 Sonnet / Haiku |
| **Parallelism** | Yes — runs subtasks in parallel environments | No — sequential requests | No — sequential requests |
| **PR integration** | Direct — creates PRs via GitHub integration | Direct — commits or PRs from inside editor | Indirect — can suggest diff or commit script |
| **Test execution** | Yes — runs, debugs, re-runs | Limited — can run commands inside local dev env if you allow | No built-in execution; must paste results back |
| **Multi-repo orchestration** | Yes | No | No |
| **Cost model** | Included in ChatGPT Pro/Team/Enterprise (no per-task billing) | Cursor Pro/Ultra credits or BYO API keys | Claude Max/Pro subscription or API billing |

---

## **2. Strengths for Day-to-Day Coding**

**OpenAI Codex**  
- Best when you have **large, vague objectives** (“Refactor auth flow & add social login”) and want it to break them into **subtasks → build → test → PR** without much back-and-forth.  
- Strong for **multi-file, multi-step** work.  
- No extra cost if you’re already paying for **ChatGPT Pro $200**.  
- Weakness: You’re in OpenAI’s web UI — not your IDE — so it’s less “live coding” and more “batch agent” style.

**Cursor Agents**  
- Best when you want **tight loop coding inside your IDE** — you edit, highlight, tell it what you want, it changes your files directly.  
- Repo context is **always current**; agents can use Claude or GPT models interchangeably.  
- Strongest for **incremental changes, quick experiments, inline debugging**.  
- Weakness: Doesn’t spin up parallel sandboxes or run autonomous task trees without you steering.

**Claude Code**  
- Best for **deep reasoning and language-heavy coding** (e.g., generating docstrings, rewriting code for clarity, explaining complex algorithms).  
- Handles very large context windows well (good for **full-repo comprehension**).  
- Weakness: Execution loop is manual — you have to run tests locally and feed results back.

---

## **3. Where They Overlap / Can Replace Each Other**
- **Codex vs. Cursor Agents:**  
  - Codex is a *macro* tool (project-scale autonomy).  
  - Cursor is a *micro* tool (file-sca

*(Answer truncated — 4384 chars total)*
