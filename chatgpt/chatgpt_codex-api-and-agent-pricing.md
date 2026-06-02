---
conversation_id: 694091fd-fe54-832b-a954-27696cca2637
created: 2025-12-15
links:
- '[[chatgpt-clusters/business_startup]]'
message_count: 6
source: chatgpt-export
tags:
- chatgpt
- import
- long-form
title: Codex API and agent pricing
type: note
updated: 2025-12-15
---

# Codex API and agent pricing

> Conversation ID: 694091fd-fe54-832b-a954-27696cca2637
> Created: 2025-12-15T22:56:12Z
> Updated: 2025-12-15T22:58:07Z
> Messages: 6

---

## User

Pricing for codex over API and also agent use in the browser

---

## Assistant

Here’s the **current* pricing landscape for OpenAI **Codex usage via API** and **AI agents (including browser-style agents)** — concise and fact-based.

---

## 🧠 **Codex Pricing (API & Subscription)**

### 📌 Subscription Access
- Codex is included with ChatGPT **Plus (~$20/mo)**, **Pro (~$200/mo)** and higher subscription tiers; you get usage caps included in those plans. citeturn0search0turn0search19  
- These plans give you a blend of message/task allowances — *not unlimited API token access*. citeturn0search0

### 📌 API Token Pricing
OpenAI no longer offers the old standalone Codex API exactly as it once did; modern pricing uses related models like **codex-mini-latest** or GPT-5 family models optimized for coding tasks:

- **codex-mini-latest**: ~**$1.50 per million input tokens** (text) — output is typically priced higher (e.g., ~$6 per million tokens). citeturn0search36  
- **Regular GPT-5 models** (used for code tasks if you choose): about **$1.25 per million input tokens** and **$10 per million output tokens** in practice. citeturn0search36

**Summary implication:** Codex-style API use costs scale with tokens used — both prompt and output. For high-volume coding automation, budget per million tokens rather than flat monthly. citeturn0search36

---

## 🤖 **Agents & Browser-Style Agent Pricing**

### 🧩 OpenAI “Agents” (general)
OpenAI’s **Agent Builder / Agents SDK** itself incurs no charge for **design/iteration** — you pay when you **run agents using models and tools**, billed at normal API rates. citeturn0search21  
- Models/tools invoked by the agent cost tokens like any other API use.

### 🌐 Browser-style Agent (“Operator”, “ChatGPT agent”)
- Tools like **Operator** (capable of interacting through a browser on your behalf) have been offered as part of **ChatGPT Pro** or higher subscription tiers (e.g., Pro is ~$200/mo). citeturn0news39  
- Operator was a research preview limited to Pro users initially and was tied to that subscription access. citeturn0search42

**Note:** *There’s no separate published per-use pricing for browser-agents apart from subscription requirements and the token costs of any model calls they make.*

---

## 💼 **Enterprise/Custom “AI Agents” Pricing (Reported)**

Independent reporting (not official pricing docs) suggests OpenAI plans **tiered monthly pricing for specialized agents**:

- ~$2,000/mo for basic knowledge-worker agents  
- ~$10,000/mo for developer-focused agents  
- ~$20,000/mo for advanced research/PhD-level agent assistants citeturn0search24turn0search34

**Important:** These figures come from industry reporting (e.g., The Information) — not official OpenAI published pricing pages. They indicate enterprise positioning, not general API token billing.

---

## 🧾 **Key Takeaways for Cost Structuring**

1. **API usage = tokens**  
   Codex-oriented API calls are priced per token — input and output — billing at model rates (codex-mini or GPT-5 class). citeturn0search36

2. **Subscription tiers matter**  
   Using Codex through ChatGPT Plus/Pro gives you included usage but not unlimited token access; heavy API use still costs. citeturn0search0

3. **Agents run on models**  
   Agent Builder is free until execution — but execution costs are token charges to underlying LLMs/tools. citeturn0search21

4. **High-end custom agents could have flat pricing**  
   For enterprise use, bespoke agents may have significant monthly fees — separate from token costs. citeturn0search24

---

If you want an **estimated cost for a specific usage pattern** (e.g., lines of code generated per day), I can calculate a more concrete number.

---

## User

10k lines of code a day

---

## Assistant

Mr. White,

Below is a **clean cost estimate for generating ~10,000 lines of code per day via API**.

---

## Assumptions (explicit)
- **Avg tokens per line of code:** ~20 tokens  
  (Typical for Python/JS/Go; comments included)
- **Daily output tokens:**  
  10,000 lines × 20 = **200,000 output tokens/day**
- **Input tokens:** ~25% of output (prompts, context, instructions)  
  → **50,000 input tokens/day**

---

## Using a Codex-style coding model (e.g. `codex-mini-latest`)

### Token pricing (typical)
- **Input:** ~$1.50 / 1M tokens  
- **Output:** ~$6.00 / 1M tokens  

### Daily cost
- Input:  
  50,000 × $1.50 / 1,000,000 ≈ **$0.075**
- Output:  
  200,000 × $6.00 / 1,000,000 ≈ **$1.20**

**Total per day:** ≈ **$1.28**

---

## Monthly cost (30 days)
**≈ $38–40/month**

---

## Sensitivity (realistic range)
- If code is denser (30 tokens/line): **~$55–60/month**
- If you regenerate/refactor heavily (2× output): **~$75–80/month**

Still trivial relative to engineering labor.

---

## Important caveats
- **Browser/agent execution** (CI runs, tool calls, browsing) adds cost only if it triggers additional model calls.
- **ChatGPT Pro / Operator** subscriptions do *not* cover API token usage.
- Enterprise agents may add **flat fees**, but raw code generation remains token-cheap.

---

### Bottom line
**10k LOC/day via API costs on the order of $40/month.**  
Cost is not the constraint; orchestration, validation, and review are.

If you want, I can size this for **multi-repo agents, tests included, or refactor-heavy workflows**.

---

## User

Vs plans

---

## Assistant

Mr. White,

Here’s a **clean comparison: API usage vs ChatGPT plans** for **~10k LOC/day**.

---

## 🔁 **API vs Plans — Cost & Capability**

| Option | Cost | Covers 10k LOC/day? | Automation / Agents | Determinism & Scale |
|------|------|---------------------|---------------------|---------------------|
| **API (Codex-style / GPT-5 coding)** | **~$40–80/mo** (tokens) | ✅ Yes | ✅ Full (CI, tools, repos) | ✅ High |
| **ChatGPT Plus** | $20/mo | ⚠️ Maybe (soft caps) | ❌ No real automation | ❌ Low |
| **ChatGPT Pro** | $200/mo | ⚠️ Yes, but capped | ⚠️ Limited (Operator UI) | ❌ Low |
| **ChatGPT Team** | ~$30–50/user/mo | ⚠️ Shared caps | ❌ | ❌ |
| **ChatGPT Enterprise** | Custom (high $$$) | ✅ Yes | ⚠️ Some | ⚠️ |
| **Enterprise Agents (custom)** | $2k–$20k+/mo | ✅ Yes | ✅ Yes | ⚠️ |

---

## What actually matters

### **API**
- Cheapest by **5–10×** for pure code volume
- Required for:
  - Multi-repo agents
  - CI/test loops
  - Deterministic outputs
  - Scaling past human-in-the-loop
- You already saw the math: **code is cheap**

### **Plans (Plus / Pro)**
- Optimized for **interactive use**
- Soft limits, throttling, no guarantees
- Operator/browser agents are **UI tools**, not production systems
- Pro is convenience, not leverage

---

## Recommendation (founder-grade)

- **Use API for all real work**
- Optionally keep **1× Pro seat** for exploration/debugging
- Do **not** rely on plans for production codegen or agents

**Rule:**  
Plans = thinking.  
API = execution.

If you want, I can map this to a **10-engineer-equivalent agent stack** with CI, tests, and review gates.


**Topic:** [[chatgpt-clusters/business_startup]]
