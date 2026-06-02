---
title: "Pricing and workflow comparison"
type: essay
created: 2025-12-20
updated: 2025-12-20
source: chatgpt-export
topic: coding-ai
message_count: 14
tags: [chatgpt, knowledge, coding-ai]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-ai]]

# Pricing and workflow comparison

> **Source:** ChatGPT conversation
> **Date:** 2025-12-20T02:58:35Z
> **Messages:** 14
> **Topic:** coding-ai

## Question

Yo, so talk to me about the pricing on Cursor vs. Cloud Code vs. Windsurf vs. OpenAI Codex on plans vs. bringing your own key. I'm liking the pair of programming in Windsurf, and generally they have a lot of promos and stuff that make it incredibly effective cost-wise. I also have currently ChatGPT+, and Codex is good. Usage is limited, but they seem to be increasing the amount of usage and stuff. I have Linear, and I have a paid plan on it, and basically I'm the only human dev in the team. We have CI in place that does a good job of going through and everything and putting things in merge queues and stuff. And then we have GitHub, which has Copilot and stuff. And what I'm looking for is, basically, I'm trying to figure out what the perfect workflow is for me. Now, I really find Windsurf to be great for local programming. I'm able to open up a tab in Windsurf, give it a complex prompt, let it work, and then open up a new Cascade tab and do the same and let it work. One big pet peeve is

## Answer

Mr. White — here’s a **pricing + BYOK** reality check, then a **workflow that fixes your “1 hour flow + 1.5 hour cleanup” problem** (it’s mostly a git/CI/branching architecture issue, not you).

## Pricing and BYOK: Cursor vs Windsurf vs Cloud Code vs Codex

### Cursor (IDE + agents)
- **Pro: $20/mo**; **Pro+: $60/mo**; **Ultra: $200/mo**. citeturn1view2  
- Cursor’s positioning is basically: pay subscription for integrated UX + some included usage, then pay more for higher usage tiers. citeturn1view2  
- **BYOK:** Cursor supports adding your own API keys (OpenAI/Anthropic/etc.) in settings. citeturn2search26  
  - In practice, BYOK often helps when you want a specific model or want costs to hit your own provider bill; but some “core” IDE features may still run on Cursor’s side depending on how they route features/models.

**When Cursor wins for you:** background agents + “fire off tasks into cloud-ish environments” without blocking your local working directory, plus multi-model convenience on one bill. citeturn1view2

---

### Windsurf (IDE + Cascade)
- **Free: $0** (25 credits/mo), **Pro: $15/mo** (500 prompt credits/mo), **Teams: $30/user/mo**. citeturn2search0turn2search8  
- **BYOK:** Windsurf supports **Bring Your Own Key** for certain models on Free/Pro (you add keys in subscription settings; BYOK models are labeled). citeturn2search1turn2search21  

**When Windsurf wins for you:** it’s extremely cost-effective for local “pairing” and parallel Cascades at a low fixed monthly price, and BYOK lets you selectively pay provider rates for the expensive stuff. citeturn2search0turn2search1turn2search8turn2search21

---

### OpenAI Codex (cloud tasks + CLI/web + integrations)
- Codex is **included with ChatGPT plans**:
  - **Plus: $20/mo**
  - **Pro: $200/mo**
  - **Business: $30/user/mo** citeturn1view4  
- It explicitly supports extending via **ChatGPT credits** when you hit limits. citeturn1view4  

**When Codex wins for you:** “give it a ticket, let it work in isolation, get a PR-quality artifact” — especially if you structure tasks as PR-sized units (more on that below). citeturn1view4

---

### “Cloud Code” (Google)
This is usually two different things people conflate:

1) **Google Cloud Code** (the Google Cloud IDE plugin tooling): **free** for Google Cloud customers. citeturn1view3  
2) **Gemini Code Assist** (Google’s AI coding assistant): has an **individual free tier** (public preview) per reporting, and paid tiers exist. citeturn0news39  

So: Cloud Code itself isn’t your budget driver; AI usage (Gemini Code Assist / Vertex) is.

---

## The core problem you described (and the fix)
Your pain isn’t primarily “which IDE,” it’s this:

> **10 agents working in the same working tree → you can’t commit/push until they stop → you batch huge changes → lint/type/CI failures explode → you leave flow-state.**

### Fix in one sentence
**Give each agent its own branch + its own working directory (git worktre

*(Answer truncated — 7233 chars total)*

## Question

Okay, so I'm just looking now at Cursor, and it seems like it has a built-in work tree mode. Can you tell me about that, and if that effectively does what you're describing without the need for additional setup? And then if that's the case, then one, I guess, anyway, any native support for that in Windsurf? And if not, any support for that in Codex? I guess Codex gives me... let's see, I get local workspace in cloud environment in the IDE plugin, which I guess is cool, but it doesn't seem like I can side-by-side those windows, those windows, and it doesn't seem to have native work tree support as far as I can tell. One thing I am seeing in Cursor though is it totally allows me to side-by-side multiple clod code instances, which I can also do in Windsurf for any IDE. It doesn't seem like it wants me to side-by-side OpenAI Codex. It seems like I can only get one Codex up at a time, even no matter what interface I'm in, but it does seem like I can open multiple clod codes in any IDE, and 

## Answer

Mr. White — short answer first, then detail:

**Yes: Cursor’s built-in worktrees already solve ~80–90% of the pain you described, without extra setup.**  
**Windsurf does not natively solve it.**  
**Codex partially solves it, but in a very different (cloud-first, not side-by-side) way.**

Below is how they actually compare in practice, not marketing.

---

## 1. Cursor “Worktrees”: does it really do what you want?

Cursor’s **Worktrees** are effectively first-class `git worktree` management, but with UI and agent awareness.

### What Cursor Worktrees give you
- One repo → **many isolated working directories**
- Each worktree:
  - has its **own branch**
  - has **independent file state**
  - can run **its own agent**
- You can:
  - open **multiple Cursor windows side-by-side**, each attached to a different worktree
  - run agents concurrently without blocking commits
  - commit/push one worktree while others keep running

**This directly fixes your “wait for all agents to stop before pushing” problem.**

You no longer have:
- shared filesystem contention
- giant batched commits
- synchronized stopping points

Each agent → one branch → one PR.

### Background agents + worktrees
This is where Cursor is uniquely strong right now:
- You can fire a **background agent** into a specific worktree
- It works asynchronously
- When it’s done, you already have:
  - clean branch
  - commit history
  - PR-ready diff

You stay in flow in your “main” worktree while others cook.

**Bottom line:** Cursor worktrees are *exactly* what I was describing — but with UX and agent plumbing built in.

---

## 2. Does Windsurf have anything comparable?

### Short answer: **No, not natively.**

Windsurf:
- Runs all Cascades against **one working directory**
- Has no first-class concept of:
  - per-agent branch isolation
  - per-agent filesystem state
- You *can* manually:
  - create branches yourself
  - juggle them in one workspace
…but the agents are unaware of that structure.

That’s why you’re seeing:
- coordination delays
- massive diff accumulation
- pre-commit + CI explosions

### Can you hack it?
Yes, but it’s clunky:
- manually create git worktrees in terminal
- open each in a separate IDE window
- point Windsurf at each directory

At that point, **Cursor is strictly better UX for the same underlying model**.

---

## 3. Codex: what it solves, and what it doesn’t

Codex (via ChatGPT / IDE plugin) is **not designed for side-by-side interactive concurrency**.

### What Codex is good at
- Task → isolated environment → result
- Cloud workspace per task
- Strong at:
  - “Here is a Linear issue, go implement it”
  - returning a branch / patch / PR-ready output

This is why Codex feels good when:
- you spec deeply
- hand it off
- come back later

### What Codex does *not* give you
- No multi-pane, side-by-side live agents
- No visual “10 agents on screen” workflow
- No native local worktree awareness
- You generally get **one active Codex task at a time per interface**

So

*(Answer truncated — 5283 chars total)*

## Question

Now, um, Cursor does have a feature, um, so Cursor has the WorkTrees and they have a feature where I can like keep all the changes in that WorkTree and commit them to my local WorkTree. So I could have 10 agents running together and then I can commit them all to a local WorkTree, um, which is pretty cool when I'm just kind of jamming on my own. Um, I'd be curious to see, um, I would be curious to see, um, for Cursor what we're looking at in terms of, um, is the move for me to, to use that, commit them all locally and like have, it also has like an agent review that it can automatically do at the end of its work. Should I use that and have, um, to operate faster or, and also, I guess, leverage local compute power, um, versus CI, I don't know if that makes a difference, um, it doesn't really matter, I guess, um, or do I set up effectively, um, uh, do I set up effectively, um, a, uh, um, do I have them all PR and operate in CI, um, and then ask, um, the branches I'm working on to keep pul

## Answer

Mr. White — you’re thinking about it the right way. Cursor’s Worktrees + “apply/merge changes into your main worktree” can absolutely be a *fast solo jamming mode* — but it’s not the best default if your goal is **high throughput with low cleanup**.

## 1) “Commit Worktree → Main Worktree” vs “PR per Worktree”
### When “merge into main locally” is the right move
Use this when:
- you’re exploring / prototyping / refactoring locally
- you want to integrate multiple agent outputs quickly
- you’re okay with a short “integration pass” at the end

To make this not suck:
- run **Agent Review** before you pull changes over (it’s explicitly designed to scrutinize diffs for bugs/issues). citeturn0search2  
- require each agent to pass your **fast local gate** (format/lint/typecheck/unit) before it reports “done”
- keep changesets small per agent

This is the best way to stay in flow while you’re building something cohesive.

### When “PR per Worktree” is the right move (what I’d default you to)
Use this when:
- the task is “ship-ready”
- you want merge queue + CI to do the coordination for you
- you want to avoid the “1 hour flow + 1.5 hour cleanup” pattern

Because Cursor already maps **1 agent ↔ 1 worktree** in their worktrees setup, it’s basically made for this. citeturn0search1

**My recommendation:**  
- **Default:** PR per worktree for anything production-bound  
- **Exception:** local-merge for exploratory spikes / large multi-part refactors you personally shepherd

A good hybrid rule:
- If it touches **routing/auth/data model/payments/deploy** → PR + CI  
- If it’s **UI polish / internal refactor / “let me see if this idea works”** → local merge is fine

---

## 2) Local compute vs CI: should you “trust local” to go faster?
Local compute doesn’t replace CI; it just prevents wasted cycles.

What works best:
- Agents run **fast local checks** (seconds–minutes)
- CI runs the **full battery** (the source of truth)

This gets you speed *and* safety.

---

## 3) Cursor plan choice: $20 vs $60, and where BYOK fits
Cursor’s public pricing page positions:
- **Pro ($20/mo):** background agents + “Auto” routing + other core features citeturn1view4  
- **Pro+ ($60/mo):** “3× usage on all OpenAI, Claude, Gemini models” citeturn1view4  

Cursor’s June 2025 pricing clarification also says Pro includes **$20/month of frontier model usage at API pricing**, plus the ability to buy more “at cost,” and “unlimited” is specifically when **Auto** is selected. citeturn1view3

### BYOK in Cursor
Cursor supports using your own provider keys so calls go directly to the LLM provider and are billed on your provider account (“send unlimited AI messages at your own cost”). citeturn0search8

### What I’d do in your shoes (10 agents, real throughput, $100–$300/mo budget)
**Start with Pro+ ($60) for 30 days.**  
Reason: you’re explicitly running parallel agents and you care about staying in flow. Pro+ is designed for heavier usage across frontier models. citetur

*(Answer truncated — 4292 chars total)*

## Question

Cursor has a CloudAgent setup that I'm using. CloudAgents autonomously work on your codebase in the cloud. Let's set up the CloudAgents machine so I can get started for more info. Learn CRDocs. And then it goes, create a machine snapshot. And then it says, interactively set up all tools and dependencies needed. As if you were setting up a new machine to deploy. And then it gives me a chat interface. And then it prompts, please install the necessary tools and dependencies necessary to run this project. I click that. And then it says, planning next moves. And then while that's happening, we get an error in the corner. Failed to connect to the remote extension host server. Error, internal pod exists, but exec daemon something something. The error just went away. And it stopped what it was doing. I'll type continue into the chat interface. And now it says, planning next moves. And I'm assuming that, yep, the error pops back up. Pod exists, but exec daemon is unreachable after eight retries

## Answer

Mr. White — that exact error string is showing up in multiple recent Cursor Cloud Agent threads, and Cursor staff are calling it an **infrastructure issue** (pod is created, but the “exec-daemon” inside the container isn’t reachable). So you’re not crazy and it’s **not your machine setup**. citeturn0search0turn0search1turn0search2

### What’s happening (plain English)
- Cursor successfully creates the remote “pod” (the cloud workspace container).
- Then Cursor tries to “exec” into it (open the remote extension host).
- The daemon that allows exec/interactive sessions is unreachable → you get:
  **“Pod exists but exec-daemon is unreachable after 8 retries.”** citeturn0search0turn0search1turn0search2

---

## Do these steps in this order (fastest to prove what it is)

### 1) Quick reality check: it’s likely Cursor-side
- If you can reproduce it across projects and after restarts (you can), that aligns with the infra incident reports. citeturn0search0turn0search1turn0search2

### 2) Try the “lowest effort” mitigations Cursor staff suggest
Cursor staff/community suggestions for this specific error:
- **Wait 10–15 minutes and retry** (often transient) citeturn0search0turn0search1  
- **Disable VPN / proxy completely** citeturn0search0turn0search1  
- Run Cursor **Network Diagnostics** (they explicitly mention this path) citeturn0search0turn0search2  
- Try again at a different time (regional infra hiccups) citeturn0search0  

### 3) Force a clean cloud agent environment attempt
- If you have a `.cursor/environment.json`, try deleting it and re-running setup (some report no difference, but it’s a common elimination step). citeturn0search0turn0search2  
- If Cursor offers an option, try **Dockerfile-based setup instead of “Manual Snapshot”** (Cursor staff suggested Dockerfile works better for some). citeturn0search0  

### 4) Capture logs / request-id and escalate (this gets it fixed faster)
Cursor staff asked people to:
- turn on **debug logs** and retry, then share logs with support citeturn0search1  
If you can find a **Request ID** in the error toast / logs, include it (they asked for that too). citeturn0search1

---

## What to do right now so you can keep working (practical workaround)

Until CloudAgents stabilize, you can still get most of the “swarm” benefits with:
- **Cursor Worktrees locally** (10 worktrees, 10 agents)  
- **PR per worktree** (or “apply changes into main” for spike/prototyping)

This avoids the cloud pod/exec daemon path entirely.

And if you still want “cloud isolation” today:
- Use **GitHub Actions / ephemeral dev environments** for heavy test runs
- Or run one remote box you control (SSH) until Cursor CloudAgents stop flaking

---

## How to tell if it’s truly infra vs your network
It’s *almost certainly* infra given the timing and matching error reports, but one clean test:

- Try setup from **a different network** (phone hotspot) with VPN/proxy off.
  - If it still fails → practi

*(Answer truncated — 3636 chars total)*

## Question

When I do run it, I am seeing that in the left it actually says, Connecting to Cloud Agent, and then at the same time that that pops up it says Disconnected from Cloud Agent. So it seems like it's never connecting to Cursor for whatever reason.

## Answer

Mr. White — that “**Connecting to Cloud Agent → Disconnected from Cloud Agent**” flip-flop is consistent with the same underlying failure mode you saw earlier (“**pod exists but exec-daemon is unreachable**”): Cursor is successfully *starting* the remote workspace, but the interactive channel that Cursor needs to attach (remote extension host / exec) is failing, so it immediately drops. Cursor staff describe this as “pod is created, daemon inside isn’t reachable,” i.e. connectivity to the agent runtime, not your repo tooling. citeturn0search2turn0search1turn0search0

Here’s the most efficient way to diagnose and unblock.

## 1) Confirm whether it’s Cursor infra vs your network in 5 minutes

### A. Run Cursor’s built-in Network Diagnostics
Cursor explicitly recommends this for agent connectivity problems. In Cursor: **Settings → Network → Run Diagnostics**. citeturn0search0  
- If diagnostics fail or show blocked endpoints → it’s your network path (VPN/proxy/corp firewall/ISP).
- If diagnostics pass → it’s very often Cursor-side, especially with the current wave of reports. citeturn0search4turn0search1turn0search2

### B. Try one clean alternate network (phone hotspot)
This is the fastest binary test:
- If hotspot works → your main network is blocking/rewriting something (often VPN/proxy, “security” DNS, or HTTP/2/WS meddling).
- If hotspot also fails → almost certainly Cursor infra/service instability.

(Cursor forum reports show multiple users reproducing across projects and machines, pointing away from local setup.) citeturn0search1turn0search4turn0search2

## 2) Fast local mitigations that sometimes fix “connect then disconnect”

Do these **before** deeper digging:

1) **Disable VPN / proxy entirely** (including “system” proxies, corporate security agents, and browser VPN extensions). Cursor troubleshooting calls this out as a first step for connectivity issues. citeturn0search0  
2) **Start Cursor with extensions disabled** (to eliminate remote/SSH/container extensions collisions). People tried this for the same cloud agent setup failure. citeturn0search4  
3) Retry after a short wait: there have been multiple recent cloud agent environment setup failures that appear transient / infra-related. citeturn0search1turn0search2  

## 3) If it keeps happening: you should treat this as a Cursor Cloud Agent incident and escalate with the right info

Cursor forum staff are actively asking for **Request IDs / logs** to route to engineers for this exact error class. citeturn0search2turn0search1

What to grab:
- Screenshot / copy of the toast (especially anything like a **Request ID**)
- Cursor version
- Whether Network Diagnostics passed
- Whether hotspot reproduces
- Time + timezone

Then open a support/forum report and include all of that; it tends to skip the “have you tried restarting” loop. citeturn0search2turn0search1

## 4) Practical unblock so you can keep moving today
Even if Cloud Agents are flaky, you can st

*(Answer truncated — 3738 chars total)*

## Question

Alright, whatever. We'll figure that out later. For now, I've got multiple agents running in WorkTree locally, which seems fine for now. So tell me what's the best way for me to set this up so that I can stay in a flow state and ensure that what we're doing is solid and we don't have issues. Tell me.

## Answer

Mr. White — here’s the **clean, repeatable setup** that keeps you in flow *and* prevents the cleanup spiral. This is opinionated on purpose.

---

# The Goal
- **You never wait for agents**
- **No giant batched diffs**
- **CI failures happen early, on small branches**
- **You only do human work (product, architecture, judgment)**

---

## 1. The Golden Rule (non-negotiable)
**One agent = one WorkTree = one branch = one unit of responsibility**

No exceptions unless you’re explicitly spiking.

Why this works:
- You can commit/push/abandon independently
- No coordination pauses
- Failures are isolated and cheap

---

## 2. Two Operating Modes (switch deliberately)

### Mode A — **Flow / Jam Mode** (default during deep work)
Use when:
- You’re building a feature end-to-end
- You’re refactoring with intent
- You want speed over ceremony

**How it works**
1. Spin up multiple WorkTrees
2. Each agent works its task
3. Require **local fast checks** before “done”
4. Run **Agent Review**
5. Pull changes into your main WorkTree
6. One clean commit (or a few logical ones)
7. Push once

**Key constraint**
- Only allow this if *you personally integrate*
- If you’re not touching the code → don’t use this mode

This keeps you in flow *without* CI noise.

---

### Mode B — **Production / Factory Mode** (default for shipping)
Use when:
- The task is well-scoped
- You want parallelism
- You don’t want surprises

**How it works**
1. Each agent:
   - works in its WorkTree
   - runs fast local checks
   - runs Agent Review
   - opens a PR
2. CI is the authority
3. Merge queue handles order
4. You only:
   - skim diffs
   - resolve CI failures
   - make product calls

This is how you scale *yourself*.

---

## 3. The Single Most Important Technical Change
### Split CI into **FAST** and **FULL**

Agents must run **FAST locally**.  
CI runs **FULL**.

Example (conceptual):
- **FAST (agent-required)**  
  - formatting  
  - lint  
  - typecheck  
  - unit tests (no env spin-up)

- **FULL (CI-only)**  
  - integration tests  
  - e2e  
  - migrations  
  - build/deploy checks

If agents don’t run FAST, you *will* bleed time.

---

## 4. Agent Contract (paste this into every agent prompt)

> **You are working in an isolated Cursor WorkTree.**
>
> Rules:
> - Make the smallest correct change possible
> - Do not exceed ~300–400 LOC unless explicitly told
> - Run the FAST local checks before reporting done
> - Fix all failures yourself
> - Run Agent Review and address all blocking issues
>
> Definition of done:
> - Code compiles
> - FAST checks pass
> - Diff is PR-ready
> - Clear summary of what changed and risk areas

This single block will cut your cleanup time dramatically.

---

## 5. How Many Agents at Once?
**3–5 active agents max**.

More than that:
- increases merge pressure
- increases conceptual load
- does *not* increase throughput linearly

If you want 10:
- 5 active
- 5 queued / planning / reviewing

---

## 6. How You Personally Stay in Flow
Your loop should look 

*(Answer truncated — 4008 chars total)*

## Question

Give me the exact FAST commands and then look up the latest docs from Cursor and tell me exactly how to force the agent to run those commands at the end of every task. Also explain to me how agent review, the native agent review feature in Cursor works and how to set that up properly to do what I want. I do see an agent review section in the settings. Start agent review on commit. Automatically review changes for issue after each commit. Include submodules in agent review. Include changes from git submodules in review. Include on-tracked files in agent. Include blah blah blah. Default approach. Choose between quick or more thorough higher cost analysis. Also explain to me the queue messages feature. I can send immediately, send after current message, or stop and send right away. If I send right away without the stop feature, does that work like Claude where it then adds it into its memory, continues with the task, but adds it to its to-do list? Or does it stop the current task and inte

## Answer

Mr. White — I’ll give you (1) **exact FAST commands** you can drop in today, (2) the **Cursor-native way to force agents to run them**, (3) how **Agent Review** works + how to configure it safely, and (4) what **Queue messages** actually does (and whether it interrupts).

---

## 1) Exact FAST commands (copy/paste)

### If you’re Node/TypeScript (most common)
Create `scripts/fast.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# pick your package manager
if [ -f pnpm-lock.yaml ]; then PM="pnpm"
elif [ -f yarn.lock ]; then PM="yarn"
else PM="npm"
fi

# install only if needed (safe to no-op if already installed)
if [ "$PM" = "pnpm" ]; then pnpm -s install
elif [ "$PM" = "yarn" ]; then yarn -s install
else npm ci || npm install
fi

# format/lint/typecheck/test (adjust script names to your repo)
$PM -s run format || true   # optional: allow skip if you don't have it
$PM -s run lint
$PM -s run typecheck
$PM -s test
```

Then in `package.json`, standardize scripts (these names matter for agent reliability):

```json
{
  "scripts": {
    "format": "prettier . --write",
    "lint": "eslint .",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  }
}
```

### If you’re Python
Create `scripts/fast.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

python -m pip install -U pip
if [ -f pyproject.toml ]; then
  python -m pip install -e ".[dev]" || python -m pip install -e .
elif [ -f requirements-dev.txt ]; then
  python -m pip install -r requirements-dev.txt
elif [ -f requirements.txt ]; then
  python -m pip install -r requirements.txt
fi

ruff format .
ruff check .
mypy .
pytest -q
```

### If you’re Go
```bash
#!/usr/bin/env bash
set -euo pipefail
go fmt ./...
go vet ./...
go test ./...
```

### If you’re Rust
```bash
#!/usr/bin/env bash
set -euo pipefail
cargo fmt
cargo clippy -- -D warnings
cargo test
```

**Best practice:** make FAST run in **< 2–5 minutes**. Push slow integration/e2e to CI.

---

## 2) How to force Cursor agents to run FAST at the end of every task

Cursor gives you 3 “native” levers you can combine:

### A) Project Rules (most important)
Cursor supports **Rules** stored in `.cursor/rules` and created via **Cursor Settings → Rules** (or “New Cursor Rule”). citeturn3search0

Create a rule called something like: `finish-with-fast-checks.mdc` and include:

- “Before you say you’re done, **you must run `./scripts/fast.sh`** in the terminal.”
- “If it fails, fix and re-run until green.”
- “Do not ask me to run it; run it yourself.”

Rules are the closest thing to “agent memory / constitution” Cursor has.

### B) Custom command `/fast` (so you can trigger it instantly)
Cursor supports **custom commands** (team-enforced if you’re on a team plan / dashboard) so you can standardize workflows. citeturn3search1turn3search6

Make a custom command `/fast` whose instruction is literally:
- “Run `./scripts/fast.sh` and report the output summary + failures.”

Then your rule can say:
- “Run `/fast` before finishing

*(Answer truncated — 7372 chars total)*
