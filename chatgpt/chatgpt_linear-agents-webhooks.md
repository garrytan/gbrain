---
title: "Linear Agents Webhooks"
type: guide
created: 2025-12-23
updated: 2025-12-23
source: chatgpt-export
conversation_id: 694a3c0d-5834-8326-9bc5-7f49633b9481
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# Linear Agents Webhooks

> Conversation ID: 694a3c0d-5834-8326-9bc5-7f49633b9481
> Created: 2025-12-23T06:51:58Z
> Updated: 2025-12-23T06:54:22Z
> Messages: 4

---

## User

when using linear for agents can we set a hook to get them to auto run a code review or open a pr etc?

---

## Assistant

Yes, Mr. White — **partially**, but not natively in the way you’re probably thinking.

### Short answer
**Linear Agents don’t currently support custom webhooks or lifecycle hooks** (e.g., “on issue created → run code review / open PR”).  
However, you *can* achieve this behavior reliably using **Linear webhooks + external automation**.

---

### How it works in practice (current state)

#### 1. **Linear Webhooks (the trigger)**
Linear supports webhooks for events like:
- Issue created
- Issue moved to a specific state
- Label added (e.g. `ready-for-review`)
- Assignee changed

These are configured via the **Linear API**, not Agents.

#### 2. **External Automation Layer (the brain)**
You listen to those webhooks in:
- A small service (Node, Python, etc.)
- Or automation tools (Zapier, Make, n8n — though code is cleaner)

From there you can:
- Call GitHub / GitLab APIs
- Run CI jobs
- Invoke an LLM-based code review
- Create or update PRs
- Comment back on the Linear issue

#### 3. **Agents are consumers, not triggers**
Linear Agents can:
- Respond to comments
- Generate content
- Perform guided actions

But they **cannot**:
- Register event hooks
- Auto-run without a webhook or comment
- Directly open PRs unless invoked via API tooling you own

---

### Common production pattern (works well)

**Flow**
1. Issue created or moved to “Ready for Dev” in entity["company","Linear","issue tracking software"]
2. Linear webhook fires
3. Your service:
   - Inspects repo + branch
   - Runs automated checks (tests, lint, diff scan)
   - Calls an LLM for review (optional)
4. Service:
   - Opens a PR via GitHub API **or**
   - Comments review results on the Linear issue
5. (Optional) Agent summarizes or discusses results

---

### If you want “Agent-like” behavior
Use a **label or comment convention**, e.g.:
- Label: `agent:open-pr`
- Comment: `/agent review`

Your webhook watches for that signal and runs the workflow.

This is how most teams are doing it today.

---

### Bottom line
- ❌ No native “Agent hooks” yet  
- ✅ Linear webhooks + external automation = full control  
- ✅ You can auto-run reviews, open PRs, and post results back cleanly  

If you want, I can outline a **minimal webhook → GitHub PR → code review architecture** in ~15 minutes of setup time.

---

## User

can you dive into the internet and see if theres a best way to do this.

we currently have paid plans for linear, coderabbit, codex, claude code max, cursor, and codegen.
we also have githubs CI and vercel. 



---

## Assistant

Here’s what the **current industry best practices look like** for tying Linear → GitHub → automated code review / PR creation, based on live integration docs and tooling searches:

---

## 1) **Direct Integrated Agents (fastest path)**

### **Codegen (Linear built-in agent)**
Linear has a native integration with **Codegen** that *already lets the agent create PRs and resolve issues directly from issues* — you can tag `@codegen` in a Linear issue and it will act to generate commits/PRs in GitHub and attach them to the issue. citeturn0search1

**Pros**
- Built-in, zero ops
- Works from Linear UI directly
- Creates PRs and updates GitHub

**Cons**
- Less configurable than self-hosted automation
- Likely tied to Codegen’s permission scope

**When to use**
- Want *agentic behavior without building infrastructure*
- Codex/Claude usage is fine but you want something that triggers from Linear itself

---

## 2) **Webhook + External Automation Layer (most flexible)**

### **Linear Webhooks → GitHub Actions / Vercel**
The most reliable pattern is:

1. **Linear issues emit webhooks** on events (create/transition/label).  
2. Your automation service (serverless function / GitHub Action) listens.  
3. On the event, the service:
   - Parses issue metadata (title/description)
   - Calls underlying tools or LLM services (Codex, Claude, Cursor, CodeRabbit)
   - Opens/updates a **GitHub PR**
   - Posts back a link to Linear

This pattern is how teams integrate issue tracking → PR creation reliably. Linear’s API makes this possible; there is no native “hook to run code” inside Linear itself.  

**Pros**
- Full control over triggers, logic, and review policies
- Centralized in CI/CD pipeline (e.g., GitHub Actions triggers)
- Easy to combine code review tooling

**Cons**
- Requires some devops work
- You host the automation service

**Example high-level flow**
```
Linear webhook (issue ready) 
   ↓
Serverless handler (Node/Python)
   ↓
Trigger: LLM code gen (Codex/Claude/CodeRabbit CLI)
   ↓
Create branch + commit
   ↓
GitHub API: open PR
   ↓
Trigger GitHub Action tests/review
   ↓
LLM code review comment bot (or CodeRabbit)
   ↓
Back-populate Linear with PR link/comments
```

**Tooling you already have that fits**
- **GitHub Actions** for PR ops
- **GitHub CI** → trigger static analysis + tests
- **Vercel** → optional preview deployments for every PR
- **Claude / Codex / Cursor / CodeRabbit** for code gen + review

---

## 3) **AI-Driven Code Review Tools**

Lookup(/integrations/AI review tools) that integrate into GitHub and comment on PRs automatically:

- **CodeRabbit** — integrates with Linear + GitHub, and *automatically reviews PRs* and links content back to issues. citeturn0search5
- **GitHub built-in + Copilot Review** — you can trigger Copilot’s PR review via GitHub API/Actions (e.g., request Copilot review on PRs via Action). citeturn0search14
- **Other static and AI review tools** — integrate into GitHub CI (SonarQube, Codacy, DeepSource) for quality gates. citeturn0search8

These typically *don’t create PRs*, but they automate review steps once a PR exists.

---

## 4) **Codex + CodeRabbit Tight Loop**
If you want *continuous automated review + auto fixes*:

- You can integrate **Codex + CodeRabbit CLI** so Codex *runs CodeRabbit’s review and applies fixes*, forming a closed loop where an LLM generates a fix and then reviews it. citeturn0search11

**Pros**
- Reduces manual review burden
- Can auto-fix many issues

**Cons**
- Could generate incorrect fixes
- Needs prompt engineering / configuration

---

## 5) **CI Triggered Reviews via GitHub Actions**
You can configure *GitHub Actions* to:
- On PR open/update → run tests → run AI reviewer step
- That reviewer step can call Claude/Codex/CodeRabbit API and comment on the PR
- No direct Linear involvement beyond issue → branch/PR

This is lightweight and effective if you already use GitHub CI.

---

## **Recommended practical stack (given what you already have)**

**Trigger & orchestration**
- Linear webhook → GitHub Action (trigger on issue labels like `create-pr`)
- GitHub Actions then:
  - Create branch
  - Invoke LLM agent (Codex/Claude/Codegen) to generate commit + PR
  - Push to GitHub

**Review automation**
- Integrate **CodeRabbit** in the PR review workflow
- Use *GitHub Actions step* to call an LLM reviewer (e.g., Claude code review API) to generate comments

**Quality gates**
- Run static analysis in CI (ESLint/flake8/Sonar/DeepSource)
- Fail PR if quality checks don’t pass

**Feedback loop**
- GitHub Action updates Linear issue with PR link / review summary

---

## **Best practice notes**
- Use labels/state transitions in Linear as automation triggers (not comments).  
- Keep provisioning of tokens/permissions secure (GitHub + LLM APIs).  
- Combine *static analysis + AI review* — static catches surface level issues, AI catches context nuances. citeturn0search8

---

If you want, I can produce a **starter GitHub Actions YAML + serverless webhook handler** that implements this flow with your specific tools.


## See Also
- [[chatgpt/chatgpt_auto-assign-linear-agents]]
- [[chatgpt/chatgpt_add-coderabbit-in-linear]]
- [[chatgpt/chatgpt_automation-in-linear]]
- [[chatgpt/chatgpt_changelog-automation-in-linear]]
- [[chatgpt/chatgpt_chatgpt-linear-integration]]
