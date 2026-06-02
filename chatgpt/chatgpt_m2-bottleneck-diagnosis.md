---
title: "M2 Bottleneck Diagnosis"
type: essay
created: 2026-01-14
updated: 2026-01-15
source: chatgpt-export
conversation_id: 69681f98-1684-8329-8c8d-10966da8c3aa
message_count: 26
tags: [chatgpt, import, code, long-form]
---
# M2 Bottleneck Diagnosis

> Conversation ID: 69681f98-1684-8329-8c8d-10966da8c3aa
> Created: 2026-01-14T22:58:32Z
> Updated: 2026-01-15T02:54:54Z
> Messages: 26

---

## User

You know, for windsurf and cloud and autocloud, autocloud and cursor, using local work trees and with cursor and running multiple AI agents at a time on code, but using cursor, windsurf, and autocloud, and autocloud runs multiple cloud code instances locally in GitHub work trees. That's my workflow and like a turbo repo with the Next.js app, and it's 100% of what we're using the machine for. I need to get in. We're seeing slow speeds on a 2022 M2 with 16 gigabytes of RAM and a terabyte internal drive, and I'm trying to figure out how to eliminate that bottleneck in the most cost-effective manner.

---

## Assistant

Mr. White — with that workflow (multiple IDEs + multiple local “agent” processes + multiple git worktrees), the usual bottleneck on a 2022 M2 / 16GB is **memory pressure → swap → everything feels slow** (and the second most common is **indexing/file-watching huge trees** like `node_modules`, `.next`, `dist`, etc.).

## Fastest way to find the real bottleneck (5 minutes)
1. **Activity Monitor → Memory**
   - If **Memory Pressure is yellow/red** and **Swap Used** is climbing (even a few GB), you’ve found it: 16GB unified memory is the limiter.
2. **Activity Monitor → CPU**
   - If you see “Indexing”, “Language Server”, “ripgrep”, “tsserver”, Cursor/Windsurf processes pegging cores, it’s likely **indexing/search** thrash.
3. **Activity Monitor → Disk**
   - If disk writes spike while memory pressure is high, that’s swap thrash (still memory-rooted).

## Highest-ROI fixes (usually immediate)
### 1) Stop the IDEs from indexing junk
**Cursor**
- If your repo is large, Cursor users report **Agent becomes extremely slow when Codebase Indexing is on**; disabling it or re-computing index + ignoring big folders helps. citeturn0search0turn0search12  
- Also, there are reports of **Cursor v2.0/v2.1 lag/stutter** where downgrading to v1.7 restored speed. citeturn0search3  
- Add ignore patterns (at minimum):
  - `**/node_modules/**`
  - `**/.next/**`
  - `**/dist/**`
  - `**/build/**`
  - `**/.turbo/**`
  - `**/.git/**`

**Windsurf**
- Windsurf supports a gitignore-style ignore file (`.codeiumignore`) to prevent indexing folders. citeturn0search4  
- Same patterns as above.

**Why this matters:** indexing/searching those folders is a classic “monorepo feels broken” cause in VS Code–style editors too. citeturn0search9turn0search8

### 2) Cap parallel agents + worktrees so you don’t blow RAM
- Each extra agent + editor window often brings another language server, index, watcher set, and Node process.
- Practical rule: **don’t run more concurrent agents than you have “free” RAM headroom**. On 16GB, that’s usually *not many* once you include Chrome + dev servers + Docker.

### 3) Make worktrees cheaper
- Keep worktrees, but **share the same dependency store** (pnpm store already helps) and avoid duplicated heavy build artifacts per worktree (`.next`, `dist`).
- Ensure `.next/` is ignored everywhere so it doesn’t get indexed.

## If you want the most cost-effective *real* fix
If Activity Monitor shows swap/memory pressure during your normal workflow, the cost-effective answer is: **more unified memory**. You can’t upgrade RAM in that Mac, so it means a different machine.

**Target spec for your exact workflow:** A Mac with **32GB+ unified memory** (36GB is even better) and ideally **more performance cores** (Pro/Max class).
- This directly reduces swap thrash and makes multiple agents/worktrees behave normally.

If you tell me what Activity Monitor shows for **Memory Pressure + Swap Used** while you’re running your “typical” number of agents/worktrees, I’ll point to the exact bottleneck and give you a tight recommendation (optimize-only vs upgrade, and which spec is the sweet spot).

---

## User

Okay, so go for a MacBook or a laptop that has 32 gigs more. What's the most effective one? Should I go for 48 RAM? Should I go for 64, 128? Or should we do it on an M4 Pro, or should we get in and use the new M5s, or should we wait two weeks for the M5 Pro?

---

## Assistant

Mr. White — for your “multiple IDEs + multiple agents + multiple worktrees” workflow, **RAM is the purchase driver**. Chip generation matters, but **once you stop swap/memory-pressure thrash, performance jumps the most**.

## What to buy (most cost-effective)
### Best value sweet spot: **48GB unified memory**
- In Apple’s current MacBook Pro lineup, **48GB is a standard/config option on the Pro/Max tiers** and is usually the best $/performance point for heavy multitasking. citeturn1view1turn0search2turn0search0  
- For your use case, **48GB is the first tier where you can run several agents + dev servers + browsers without living in swap**.

### “Never think about it again” headroom: **64GB**
Go 64GB if you routinely do any of these *while* running agents:
- Docker / multiple containers
- multiple Next.js dev servers + builds in parallel
- large monorepo indexing across multiple worktrees
- local LLMs (even modest ones) or lots of background automation

64GB is real headroom, but it’s a meaningful price jump. Apple lists 64GB/128GB as configurable options on higher-end configs. citeturn1view1turn0search5

### Usually overkill for your described workflow: **128GB**
128GB is for people doing things like large on-device models, heavy 3D/video pipelines, huge datasets, or lots of VMs. Apple positions 128GB primarily with the top Max config. citeturn0search0turn0search5

## M4 Pro vs M4 Max (for your workload)
- **M4 Pro + 48GB** = best value for code + agents (CPU/IO/memory capacity is what you feel).
- **M4 Max** is worth it mainly if you also need **big GPU throughput** (ML on-device, heavy graphics/video). For pure Next.js + agents, Max is often “nice, not necessary.”

## M4 Pro now vs waiting for M5 Pro “in ~2 weeks”
What’s known right now:
- Apple already shipped the **base 14" MacBook Pro with M5** in Oct 2025. citeturn2search5turn2news29  
- Multiple sources expect **M5 Pro / M5 Max MacBook Pros in early 2026**, with some signs pointing to a **late-January window** — but it’s still not guaranteed until Apple announces it. citeturn2search3turn2search0turn1view0

**Decision rule:**
- If you can tolerate the pain for ~2 weeks: **wait.** Best case, you buy **M5 Pro with 48–64GB**; worst case, you buy **M4 Pro/Max at a discount** right after any announcement.
- If you need relief this week: buy **M4 Pro 48GB** now. You’ll feel the gain immediately, and the “regret delta” vs M5 Pro is usually smaller than the delta between **16GB and 48GB**.

## My pick for you
- **Most cost-effective:** **MacBook Pro (Pro-tier) with 48GB unified memory** (M4 Pro today; or M5 Pro if it lands late January). citeturn0search2turn2search3  
- **If you want extra insurance:** **64GB** (only if your parallelism is extreme or you run lots of containers/LLMs). citeturn1view1turn0search5  

products{"selections":[["turn3product0","16-inch MacBook Pro (M4 Pro, 48GB-class config)"],["turn3product18","14-inch MacBook Pro (M4 Pro, 48GB, 1TB)"],["turn3product11","16-inch MacBook Pro (M4 Max)"],["turn3product2","14-inch MacBook Pro (M5, 24GB, 1TB)"],["turn3product9","Apple Refurbished 14-inch MacBook Pro (M4)"],["turn3product19","16-inch MacBook Pro (M4 Max) — B&H listing"],["turn3product1","M4 Max 64GB (refurb/used listing)"],["turn3product6","14-inch MacBook Pro (M4 Pro, base config)"]],"tags":["Best value for agents","Portable + big RAM","Max GPU headroom","Not enough RAM for you","Cheaper stopgap","High-end Max option","If you insist on 64GB","Baseline Pro tier"]}

If you tell me **how many agents you typically run simultaneously** (total across Cursor/Windsurf/autocloud) and whether you keep **Docker** running, I’ll tell you whether you’re a **48GB** person or a **64GB** person.

---

## User

Can I buy now and exchange in 2 weeks?

---

## Assistant

Mr. White — **yes, if you buy from the right place.** The key is the return/exchange window.

## Best option if you want a “2-week safety valve”
### Buy from Apple (Apple Store / apple.com)
- Apple lets you **return or exchange within 14 calendar days of the date you receive the product**. citeturn2view1turn2view2  
- **Watch the math:** if you receive it **Jan 14, 2026**, day 14 is **Jan 28, 2026**.

**Important nuance:** Apple notes exchanges have exceptions, including **custom-configured (CTO) Macs**. citeturn2view2  
- So if you want the smoothest “swap it for the new M5 Pro,” **buy a standard in-stock config** (e.g., MBP M4 Pro + 48GB that’s a normal SKU), not a special-order build.

## If you want more than 14 days of flexibility
### Costco
- Costco’s official policy lists **Computers** under electronics that must be returned **within 90 days of receipt**. citeturn2view0  
That’s the most forgiving “I might swap when M5 Pro actually appears” option.

## Practical playbook
1. **Buy from Apple if you only need ~14 days** (and choose an in-stock config if you want an easy exchange). citeturn2view2  
2. **Buy from Costco if you want real runway** (90 days). citeturn2view0  
3. Keep **all packaging/accessories**, and make sure any Apple anti-theft features can be disabled before returning (Apple can refuse returns if they can’t be disabled). citeturn2view1  

If you tell me where you’d buy (Apple vs Costco vs Best Buy) and whether you’d order a **custom** config, I’ll tell you the cleanest way to ensure you can swap to an M5 Pro with minimal hassle.

---

## User

M4 pro with 48gb ram and 1TB hdd today vs m5 pro in a month?

---

## Assistant

Mr. White — if the choice is **M4 Pro / 48GB / 1TB today** vs **M5 Pro “in ~a month”**, the practical answer is:

### If you’re currently bottlenecked (swap / memory pressure): **buy the M4 Pro 48GB now**
- Going from **16GB → 48GB** is the step-change that fixes your workflow (multiple agents, multiple worktrees, multiple IDE processes). The CPU generation matters far less once you stop swapping.
- Apple sells an **M4 Pro MacBook Pro with 48GB unified memory** as a standard configuration. citeturn0search1turn0search5

### What you’re likely “missing” by not waiting
- Apple already shipped the **base M5 MacBook Pro** in Oct 2025, and claims uplifts vs M4 (e.g., multithreaded CPU and AI / GPU metrics), but **M5 Pro / Max timing isn’t official**. citeturn0news39turn0news40  
- Current reporting/rumors point to **late January 2026 (e.g., Jan 28)** as a possible window, but that’s still speculative until Apple announces it. citeturn0search6turn0search0

Net: waiting might get you a nice year-over-year bump, but it’s unlikely to feel as dramatic as “stop swapping by adding RAM.”

---

## The smartest way to do “buy now but keep the option to switch”
**Don’t rely on Apple’s return window if you mean “a month.”**
- Apple’s policy is **14 calendar days from receipt** for returns. citeturn0search2turn0search7  
That usually won’t cover a full month.

So if you want a true month-long safety valve:
- Buy from a retailer with a longer return window (Costco is the classic example, but confirm your exact membership/purchase category policy before buying).

---

## My recommendation (cost-effective, lowest regret)
1) **Buy M4 Pro + 48GB + 1TB now** if the slowdown is costing you real hours each week.  
2) **Only “wait for M5 Pro”** if you can tolerate the current machine *and* you can buy in a way that preserves a long return window.

If you tell me **how many simultaneous agents** you typically run at peak (and whether Docker is on), I’ll tell you whether **48GB is enough** or if you should jump straight to **64GB**.

---

## User

With autoclaude I can real rack up agents like 10+

---

## Assistant

Mr. White — if you’re routinely running **10+ agents**, **48GB is very likely still a bottleneck**. On the *MacBook Pro specifically*, Apple’s own specs show **M4 Pro tops out at 48GB unified memory**; to go higher you have to step up to **M4 Max (64GB or 128GB options)**. citeturn0search1turn0search3turn0search0

## What I’d do for 10+ agents
### Most cost-effective that actually fixes it (laptop)
**MacBook Pro + M4 Max + 64GB + 1TB**
- 64GB is the first tier where “10+ parallel things” usually stops feeling fragile.
- You’re not paying for 128GB unless you truly need “never think about it again” headroom.
- Apple lists 64GB and 128GB as available memory configs on M4 Max. citeturn0search1turn0search3

### When 128GB is justified
Go **128GB** if you do *any* of these alongside the agents:
- Docker-heavy dev (multiple containers), lots of parallel builds, multiple IDEs + browsers always open
- running local models / embeddings / heavy background indexing
Apple supports up to **128GB unified memory** on M4 Max configs. citeturn0search1turn0search3

### Don’t buy M4 Pro 48GB if you truly want 10+ agents *locally*
Because you can’t upgrade later, and the MBP M4 Pro simply doesn’t go beyond 48GB. citeturn0search1turn0search3

## “M4 Max 64GB now” vs “M5 Pro in a month”
- Apple already shipped a **base M5** (14" MBP) update in Oct 2025, but that’s not the Pro/Max tier you’re deciding between. citeturn0news33  
- Even if an **M5 Pro** lands soon, the *felt* win for you comes from **having enough RAM to avoid swap**. The jump from 48→64 is usually more meaningful than one chip generation for this workload.

**So:**
- If you want the machine to *just handle 10+ agents*: **buy M4 Max 64GB now**.
- If you want maximum runway and you’ll actually use it: **M4 Max 128GB**.

## Cheapest alternative (if you want to keep a lighter laptop)
Run the agents on a **separate headless box** (Mac Studio / Mac mini / Linux workstation) and use your laptop as the editor/terminal. That often beats paying the laptop “Max + lots of RAM” premium.

If you tell me whether those 10+ agents are doing **full repo indexing + builds** or mostly **LLM-driven code edits**, I’ll tell you whether **64GB is enough** or you should just go **128GB**.

---

## User

Or will the m4 drop in price in 2 weeks? 

Is Amazon better that Apple for buying?

---

## Assistant

Mr. White —

## Will the M4 drop in price in 2 weeks?
**Maybe at retailers; unlikely at Apple.**

- **Apple usually keeps MSRP** and instead stops selling older configs or shifts them to Apple Refurbished; it *can* change prices, but it’s not the common outcome right after an update. citeturn0search12  
- **Retailers (Amazon/Best Buy/B&H) are the ones who discount** when inventory needs to move—especially if/when an M5 Pro announcement happens. Deal sites note “small price cuts…after new releases,” with bigger discounts around major sales periods. citeturn0search24turn0search17  
- If you buy **from Apple** and **Apple lowers the price within 14 days**, Apple’s policy says you can request a refund/credit of the difference (with exclusions for limited-time promos). citeturn1view1  

**Translation:** a 2-week drop is plausible *at retailers*, but not guaranteed—and it’s usually not massive unless there’s a clear inventory push.

---

## Is Amazon better than Apple for buying?
Depends on what you value:

### Apple is better if you want minimum hassle + certainty
- **14-day returns** from the date you receive it. citeturn1view1  
- **Price protection** if Apple drops price within 14 days (again, exclusions apply). citeturn1view1  
- Guaranteed **new/authorized**, easy AppleCare add-ons, cleaner support path.

### Amazon is better if the price is meaningfully lower (and you buy smart)
- Amazon generally has a **30-day return window** outside holiday exceptions. citeturn0search25  
- But policies vary by item/seller, and holiday rules have had **Apple-product exceptions** (example: holiday period returns for Apple products ending earlier). citeturn0search29turn0search22  

**If you buy on Amazon:** only buy listings that are **Ships from Amazon + Sold by Amazon** (avoid Marketplace sellers), and verify it’s **new** (not “renewed/open box”) unless you explicitly want that.

---

## What I’d do in your situation (10+ agents)
- If you’re trying to catch a potential M5 Pro announcement + price moves: **buy from a retailer with a longer return window than Apple** (Costco is the classic, but you asked Amazon vs Apple—Amazon usually gives you more runway than Apple’s 14 days). citeturn0search25turn1view1  
- If you want the cleanest “no drama” experience: **Apple**, but accept that it won’t cover a full “wait a month” strategy. citeturn1view1  

If you tell me which exact config you’re looking at (14" vs 16", M4 Pro vs Max, and seller/store), I’ll tell you the safest “buy-now” move that preserves your option to switch.

---

## User

Right now im on windsurf with only 2 agents running. Ram is maxed swap file is 16gb

---

## Assistant

Mr. White — that’s definitive: **you’re memory-bound and thrashing swap**. With RAM maxed and **16GB swap**, your machine is spending a lot of time paging memory to disk, which is exactly the “everything feels slow” symptom.

## What to do immediately (today)
1. **Close big memory hogs first**
   - Chrome (especially lots of tabs), Slack/Discord, Docker/Colima, Figma, etc.
2. **Stop IDE indexing on junk folders**
   - In Windsurf, add a `.codeiumignore` to exclude:
     - `**/node_modules/**`
     - `**/.next/**`
     - `**/dist/**`
     - `**/build/**`
     - `**/.turbo/**`
     - `**/.git/**`
   Windsurf supports `.codeiumignore` for skipping folders from indexing. citeturn0search4
3. **Reduce parallelism in dev**
   - Don’t run multiple Next.js dev servers at once across worktrees.
   - Avoid “watch” processes you don’t need.
4. **Hard reset the runaway state**
   - Save work → reboot. It clears the worst memory fragmentation + stuck processes.

These steps can cut swap, but they won’t change the underlying reality: **16GB unified memory is not enough** for your workflow.

## Hardware decision based on your numbers
With only **2 agents** and already at **16GB swap**, you should plan for:
- **Minimum: 64GB unified memory**
- **Better if you want 10+ agents locally: 128GB unified memory**

Why: you’re already exceeding physical RAM by a lot at low load. Scaling to 10+ agents will explode swap again unless you massively increase unified memory.

On MacBook Pro, that means:
- **Skip M4 Pro** (it tops out at 48GB).
- Go **M4 Max with 64GB or 128GB**.

## Buy now vs wait for M5 Pro
Given you’re already swap-thrashing:
- If you need relief now: **buy now** (M4 Max 64GB minimum).
- If you can wait: you *can*, but the key is still **RAM tier**, not the “M5” label.

## One quick diagnostic that will sharpen the recommendation
Open **Activity Monitor → Memory** and tell me:
- the top 3 processes by **Memory** (names + GB)
- whether **“Compressed”** is huge

With that, I can tell you whether **64GB is enough** or you should just go straight to **128GB**.

---

## User

{'asset_pointer': 'sediment://file_00000000960871f5a92663b4b359de55', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 956, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 714550, 'width': 1470}

---

## Assistant

Mr. White — that screenshot is a textbook **swap-thrash** situation.

### What the screenshot says (why it’s slow)
- **Swap Used: ~26.8GB** and **Compressed: ~6.23GB** → macOS is fighting to keep you alive, so everything stalls.
- Top offenders:
  - `node (vitest)` at **~9.62GB**, **~8.04GB**, **~7.84GB** (that’s ~25GB just in vitest)
  - `next-server` at **~4.82GB**
- You’re effectively trying to run a **~30–40GB working set** on a **16GB** machine. That guarantees slowness even with only 2 agents.

## Fix the bottleneck today (immediate)
### 1) Stop the runaway test runners
You have **three** separate vitest node processes eating absurd RAM.
- Kill those `node (vitest)` processes (or stop the test command), then restart your dev session.
- Then re-run vitest with **lower parallelism**:
  - run tests **single-thread / fewer workers**
  - avoid watch mode if it’s holding memory
  - split test runs by package/worktree so you don’t have multiple heavy pools simultaneously

If vitest is supposed to be lightweight for you, this also strongly suggests a **leak or an accidental “spawn multiple vitest instances”** pattern (common with worktrees + watchers).

### 2) Cap Node memory to prevent swap spirals
As a guardrail, set a cap so a single test run can’t eat the machine:
- `NODE_OPTIONS="--max-old-space-size=2048"` (or 3072/4096)
This may cause an OOM (fail fast), but it prevents the whole OS from going unresponsive.

### 3) Don’t run multiple watchers across worktrees
Worktrees + turbo + Next + vitest + multiple IDEs = tons of watchers.
- Ensure only **one** Next dev server per repo at a time (or use one shared dev server).
- Ensure only **one** vitest watcher.

## What to buy (based on *your* numbers)
With **2 agents** and you’re already at **~27GB swap**, **48GB is not the right target** for your “10+ agents + worktrees + dev servers” reality.

### Minimum that will feel “normal”: **64GB unified memory**
This should eliminate swap in the common case and make the machine responsive.

### If you want to comfortably run 10+ agents *and* keep tests/dev servers going: **128GB**
This is the “no babysitting” tier for your workload.

**Practical recommendation:**  
- If you want a laptop: **MacBook Pro with Max-tier chip + 64GB (minimum), 128GB (ideal)**.  
- I would not buy an M4 Pro 48GB for this workload; you’d still be flirting with swap.

## Quick next step (so we don’t guess)
Tell me what those three `node (vitest)` processes correspond to:
- Are they from **multiple worktrees**, or does **one** worktree spawn multiple?
If you answer that, I’ll tell you the exact config change to stop the vitest memory explosion (and you’ll likely get a big speedup even before you upgrade).

---

## User

 next-server (v16.1.1)	5.53 GB	24	107	28080	timwhite	147.3	16:24.53	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 WindowServer	1.10 GB	19	6,059	40818	_windowserver	31.3	50:34:46.44	(null)	Apple	13.8	11:48:24.51	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	Yes	(null)	
 Windsurf Helper (Plugin)	1.05 GB	21	126	82136	timwhite	2.5	3:39.57	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 language_server_macos_arm	1,003.4 MB	20	110	86673	timwhite	3.4	8:02.61	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Avid Link	865.8 MB	72	855	42048	timwhite	5.9	11:24:17.18	(null)	Intel	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas (Renderer)	857.8 MB	19	254	24240	timwhite	0.0	3:58.95	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 https://support.apple.com	815.2 MB	4	72	70085	timwhite	0.2	1:31.25	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Windsurf Helper (Plugin)	813.7 MB	10	68	87055	timwhite	7.1	2:40.28	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Windsurf Helper (Renderer)	685.6 MB	18	560	81788	timwhite	2.1	27:19.02	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Cursor Helper (Renderer)	492.1 MB	20	203	44469	timwhite	1.2	19:46.85	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Claude Helper (Renderer)	486.7 MB	16	204	49680	timwhite	10.8	1:51:41.22	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas	426.1 MB	48	1,025	86780	timwhite	1.0	31:57.99	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Linear Helper (Renderer)	421.8 MB	15	218	38411	timwhite	0.4	10:10.61	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Finder	418.8 MB	9	1,905	40917	timwhite	0.7	51:43.73	(null)	Apple	0.0	0.15	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Cursor Helper (Plugin): extension-host (user) [1-1]	395.7 MB	22	130	45002	timwhite	1.2	9:37.61	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas (Renderer)	305.5 MB	19	314	79548	timwhite	0.4	1:42.05	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas	301.9 MB	11	637	86719	timwhite	0.2	50:20.23	(null)	Apple	0.0	0.09	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT	288.7 MB	13	662	17312	timwhite	6.8	24:10.57	(null)	Apple	0.0	0.66	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Cursor Helper (Plugin): extension-host (retrieval-always-local) [1-2]	284.9 MB	42	172	45003	timwhite	1.8	18:19.57	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Windsurf Helper (Renderer)	282.1 MB	15	193	82146	timwhite	0.2	7:35.05	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas (GPU)	270.5 MB	19	544	86791	timwhite	0.1	38:36.03	(null)	Apple	0.0	4:25.85	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 QtWebEngineProcess	266.4 MB	15	134	46620	timwhite	0.6	15:20.19	(null)	Intel	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Nightly	264.8 MB	87	339	35206	timwhite	47.8	5.23	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Nightly	259.4 MB	85	333	35200	timwhite	36.5	5.60	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 claude	247.5 MB	13	54	84487	timwhite	1.1	25.42	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Spotlight	227.0 MB	7	1,099	40995	timwhite	0.2	9:04.30	(null)	Apple	0.0	0.86	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas (Renderer)	217.5 MB	18	225	90694	timwhite	0.2	1:53.03	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Nightly	213.3 MB	62	301	35115	timwhite	22.7	8.00	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 1Password Web Extension	211.8 MB	2	62	70080	timwhite	0.0	22.31	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas (Renderer)	208.9 MB	20	291	31140	timwhite	0.2	43.99	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Windsurf Helper (GPU)	204.2 MB	16	177	81784	timwhite	0.0	17:33.57	(null)	Apple	0.0	7:45.56	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas (Renderer)	200.1 MB	20	201	74972	timwhite	0.1	1:22.09	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Linear Helper (GPU)	200.0 MB	16	182	38408	timwhite	0.1	4:13.56	(null)	Apple	0.0	51.47	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Windsurf Helper (Plugin)	198.2 MB	14	71	86452	timwhite	0.0	8.43	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 NightlyCP Web Content	190.0 MB	26	109	35217	timwhite	39.4	2.26	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Nightly	183.3 MB	72	315	35219	timwhite	44.7	2.99	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 QtWebEngineProcess	177.2 MB	18	144	17942	timwhite	0.4	17:36.90	(null)	Intel	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Cursor Helper (GPU)	171.4 MB	16	173	44461	timwhite	0.2	6:14.80	(null)	Apple	0.1	3:54.89	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 TGOnDeviceInferenceProviderService	161.8 MB	5	89	51304	_modelmanagerd	0.0	3:20.72	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas (Renderer)	159.4 MB	22	239	34558	timwhite	0.2	3.61	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas (Renderer)	159.2 MB	22	239	34556	timwhite	0.2	3.58	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 kernel_task	153.8 MB	584	0	0	root	161.0	210:08:56.03	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas (Renderer)	153.6 MB	22	245	34557	timwhite	0.2	3.63	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 QtWebEngineProcess	150.3 MB	15	159	46605	timwhite	0.2	10:40.55	(null)	Intel	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Cursor Helper (Plugin): extension-host (agent-exec) [1-3]	139.6 MB	21	126	45005	timwhite	0.9	8:46.90	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Cursor	135.5 MB	38	573	44452	timwhite	0.5	4:21.32	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Claude	132.4 MB	50	743	49650	timwhite	4.5	1:33:44.38	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 bluetoothd	129.3 MB	12	456	62592	root	0.4	42:38.86	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Open and Save Panel Service (Finder)	128.0 MB	5	376	79903	timwhite	0.2	43.13	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Cursor Helper: shared-process	124.3 MB	22	138	44757	timwhite	0.0	31.01	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Safari	119.3 MB	10	910	70028	timwhite	0.2	50.70	(null)	Apple	0.0	0.03	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Claude Helper (GPU)	115.0 MB	16	177	49672	timwhite	0.1	34:21.22	(null)	Apple	0.0	3:21.47	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	114.6 MB	20	51	28273	timwhite	0.0	7.54	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	110.8 MB	15	52	28034	timwhite	0.3	13.06	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas (Service)	110.1 MB	17	204	86792	timwhite	0.6	15:35.19	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas (Renderer)	108.3 MB	19	202	97720	timwhite	0.1	23.74	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Cursor Helper (Plugin)	108.0 MB	14	77	48202	timwhite	0.2	52.71	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Windsurf	106.5 MB	41	562	81769	timwhite	0.4	55.49	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Windsurf Helper (Plugin)	100.6 MB	10	65	87054	timwhite	0.0	2.46	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Linear	99.9 MB	48	547	38405	timwhite	0.5	2:06.89	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 contactsd	96.6 MB	2	570	98757	timwhite	0.0	34.29	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	91.3 MB	15	44	35213	timwhite	1.1	0.98	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	88.8 MB	15	44	35199	timwhite	7.4	1.37	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mds_stores	86.4 MB	8	182	596	_mds_stores	0.8	3:59:21.08	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas (Renderer)	86.0 MB	18	165	20313	timwhite	0.0	10.00	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas (Renderer)	85.5 MB	18	157	20312	timwhite	0.0	7.70	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 TGOnDeviceInferenceProviderService	85.4 MB	4	71	1019	_modelmanagerd	0.0	3:34.70	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas (Renderer)	84.3 MB	18	165	74703	timwhite	0.0	14.95	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Dock	83.5 MB	5	6,657	40910	timwhite	0.1	11:48.21	(null)	Apple	0.0	0.01	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas (Renderer)	82.8 MB	18	157	74702	timwhite	0.0	11.95	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Windsurf Helper	82.5 MB	24	309	82143	timwhite	0.4	14.72	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 1Password (Not Responding)	81.6 MB	69	755	42085	timwhite	0.0	5:08.80	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	81.6 MB	15	44	35111	timwhite	3.7	1.48	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 QtWebEngineProcess	81.4 MB	15	136	46624	timwhite	0.0	3:45.87	(null)	Intel	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 QtWebEngineProcess	80.3 MB	15	137	46623	timwhite	0.0	3:44.04	(null)	Intel	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Activity Monitor	80.2 MB	11	624	19776	timwhite	31.8	5:37.13	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas (Renderer)	79.7 MB	18	157	4127	timwhite	0.0	9.58	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas (Renderer)	78.4 MB	18	157	4128	timwhite	0.0	9.40	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 NightlyCP Web Content	77.6 MB	25	110	35212	timwhite	(null)	0.79	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Windsurf Helper	72.8 MB	22	108	82142	timwhite	0.2	6.27	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Notification Center	72.6 MB	6	739	40976	timwhite	0.5	41:54.24	(null)	Apple	0.2	5:29.71	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Control Center	71.7 MB	8	1,138	40870	timwhite	0.2	14:17.97	(null)	Apple	0.0	3.80	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 AppleSpell	71.0 MB	2	181	68283	timwhite	0.0	33.78	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Open and Save Panel Service (ChatGPT Atlas)	70.2 MB	4	320	94084	timwhite	0.1	8.75	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	68.1 MB	15	44	35197	timwhite	11.7	1.59	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	66.0 MB	15	50	22736	timwhite	0.1	10:18.02	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mds	65.7 MB	10	617	362	root	1.1	4:32:31.17	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPTHelper	63.8 MB	9	547	41013	timwhite	0.1	3:15.09	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 biome	63.0 MB	18	40	42706	timwhite	0.0	26.00	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 syspolicyd	61.8 MB	5	413	478	root	0.3	1:04:52.14	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 loginwindow	61.3 MB	5	799	40811	timwhite	2.1	33:10.51	(null)	Apple	0.0	6.11	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas (Renderer)	60.9 MB	19	177	90710	timwhite	0.0	18.04	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 QtWebEngineProcess	59.3 MB	15	137	46622	timwhite	0.0	39.39	(null)	Intel	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 NightlyCP WebExtensions	53.3 MB	25	108	35214	timwhite	3.7	0.55	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 QtWebEngineProcess	50.9 MB	15	138	46621	timwhite	0.0	36.93	(null)	Intel	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 diskimagesiod	50.8 MB	3	81	94298	_diskimagesiod	0.0	7.98	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Wi-Fi	50.5 MB	5	503	41001	timwhite	0.1	5:50.71	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 diskimagesiod	49.4 MB	3	81	66550	_diskimagesiod	0.0	8.53	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Windsurf Helper	48.9 MB	25	100	82137	timwhite	0.4	34.67	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	48.6 MB	7	19	35221	timwhite	(null)	0.51	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 NightlyCP WebExtensions	48.6 MB	25	107	35208	timwhite	0.3	0.48	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	47.3 MB	13	40	64993	timwhite	0.0	19.15	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	47.0 MB	13	40	1769	timwhite	0.0	21.82	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	47.0 MB	13	40	60729	timwhite	0.0	19.06	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	46.9 MB	13	40	50474	timwhite	0.0	28.25	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	46.0 MB	12	36	22687	timwhite	0.0	0.93	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Cursor Helper: terminal pty-host	45.2 MB	23	127	45007	timwhite	0.4	4:40.86	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	45.1 MB	12	27	28048	timwhite	0.0	0.83	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	44.3 MB	12	27	28014	timwhite	0.0	0.76	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Cursor Helper: fileWatcher [1]	41.2 MB	24	172	44758	timwhite	0.3	52.35	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	40.3 MB	13	49	45890	timwhite	0.0	1:02.78	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	40.0 MB	13	48	32617	timwhite	0.0	38.21	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	39.9 MB	13	48	22908	timwhite	0.0	20.36	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	39.9 MB	13	48	26083	timwhite	0.0	59.46	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	39.9 MB	13	49	28781	timwhite	0.0	57.23	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	39.8 MB	13	48	9040	timwhite	0.0	17.05	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	39.8 MB	13	48	29952	timwhite	0.0	58.98	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	39.8 MB	13	48	21609	timwhite	0.0	22.19	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	39.4 MB	13	49	67687	timwhite	0.0	13.90	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	39.4 MB	13	48	30366	timwhite	0.0	29.11	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	39.4 MB	13	48	64614	timwhite	0.0	20.09	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	39.2 MB	13	48	94885	timwhite	0.0	53.24	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	39.2 MB	13	48	872	timwhite	0.0	30.90	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	39.2 MB	13	48	22651	timwhite	0.0	40.51	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Windsurf Helper (Plugin)	39.2 MB	10	65	87061	timwhite	0.0	0.74	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	39.2 MB	13	48	52458	timwhite	0.0	22.54	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	39.1 MB	13	49	89437	timwhite	0.0	36.89	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	39.1 MB	13	48	9148	timwhite	0.0	12.37	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	39.0 MB	13	48	24441	timwhite	0.1	19.45	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.9 MB	13	48	50264	timwhite	0.0	37.92	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.9 MB	13	48	70131	timwhite	0.0	34.83	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas (Renderer)	38.8 MB	18	158	90701	timwhite	0.0	12.41	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.8 MB	13	48	57483	timwhite	0.0	1:02.91	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.7 MB	13	48	58311	timwhite	0.0	20.58	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.7 MB	13	48	73715	timwhite	0.0	21.95	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.7 MB	13	48	6764	timwhite	0.0	53.71	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.7 MB	13	48	52241	timwhite	0.0	1:00.76	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.6 MB	13	48	19729	timwhite	0.0	14.77	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.6 MB	13	48	15814	timwhite	0.0	13.61	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.6 MB	13	48	59541	timwhite	0.0	20.22	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.6 MB	13	48	40859	timwhite	0.0	38.51	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.5 MB	13	48	96703	timwhite	0.0	53.83	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.5 MB	13	48	4917	timwhite	0.0	31.13	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.5 MB	13	48	43473	timwhite	0.0	13.58	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.5 MB	13	48	24978	timwhite	0.0	14.30	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.5 MB	13	48	8946	timwhite	0.0	22.09	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.5 MB	13	48	74932	timwhite	0.0	21.41	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.5 MB	13	48	84448	timwhite	0.0	1:02.96	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Safari Networking	38.5 MB	3	98	70070	timwhite	0.0	6.62	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.4 MB	13	48	32837	timwhite	0.0	11.60	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.4 MB	13	48	45839	timwhite	0.0	13.63	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.4 MB	13	48	42585	timwhite	0.0	35.93	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.4 MB	13	48	28768	timwhite	0.0	37.64	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.4 MB	13	48	4021	timwhite	0.0	55.18	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.4 MB	13	48	80998	timwhite	0.0	13.11	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.4 MB	13	48	67867	timwhite	0.0	12.85	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.4 MB	13	48	81427	timwhite	0.0	12.69	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.3 MB	13	48	79157	timwhite	0.0	21.60	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.3 MB	13	48	17778	timwhite	0.0	16.22	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.3 MB	13	48	25994	timwhite	0.0	57.73	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.3 MB	13	48	12375	timwhite	0.0	42.69	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.3 MB	13	48	49318	timwhite	0.0	21.57	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.3 MB	13	48	72196	timwhite	0.0	21.34	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.2 MB	13	48	29938	timwhite	0.0	55.02	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.2 MB	13	48	53189	timwhite	0.0	22.30	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.2 MB	13	48	1803	timwhite	0.0	20.87	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.2 MB	13	48	31752	timwhite	0.1	26.83	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.2 MB	13	48	67980	timwhite	0.0	59.59	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.2 MB	13	48	74197	timwhite	0.0	20.88	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.1 MB	13	48	17802	timwhite	0.0	15.81	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.1 MB	13	48	31550	timwhite	0.0	26.15	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas (Renderer)	38.1 MB	18	150	97924	timwhite	0.0	6.22	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.0 MB	13	48	45373	timwhite	0.0	20.39	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.0 MB	13	49	10696	timwhite	0.0	22.77	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.0 MB	13	48	65167	timwhite	0.0	1:06.75	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.0 MB	13	49	10149	timwhite	0.0	20.90	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.0 MB	13	48	78460	timwhite	0.0	21.51	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.0 MB	13	49	7724	timwhite	0.0	20.90	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	38.0 MB	13	48	43301	timwhite	0.0	30.87	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	37.9 MB	13	48	79285	timwhite	0.0	12.89	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	37.9 MB	13	49	76088	timwhite	0.0	21.78	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	37.9 MB	13	48	93280	timwhite	0.0	13.04	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	37.9 MB	13	48	57923	timwhite	0.0	20.07	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	37.8 MB	13	48	80732	timwhite	0.0	1:02.33	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	37.8 MB	13	48	62740	timwhite	0.0	13.18	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	37.8 MB	13	48	76900	timwhite	0.0	49.37	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	37.8 MB	13	49	77659	timwhite	0.0	10.62	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	37.8 MB	13	49	79274	timwhite	0.0	19.72	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	37.8 MB	13	48	12305	timwhite	0.0	11.62	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Ollama	37.7 MB	19	566	42076	timwhite	0.1	2:05.31	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	37.7 MB	13	48	87124	timwhite	0.0	13.25	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	37.7 MB	13	48	58514	timwhite	0.0	1:02.79	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	37.6 MB	13	48	76775	timwhite	0.0	20.14	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	37.6 MB	13	48	53825	timwhite	0.0	20.84	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	37.6 MB	13	48	71850	timwhite	0.0	1:00.33	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	37.5 MB	13	48	69879	timwhite	0.0	1:00.43	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	37.4 MB	13	48	81513	timwhite	0.0	20.94	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	37.4 MB	13	48	82398	timwhite	0.0	20.67	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	37.3 MB	13	48	71215	timwhite	0.0	21.28	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Cursor Helper (Plugin)	36.7 MB	10	66	46085	timwhite	0.0	10.32	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	36.1 MB	12	35	86774	timwhite	0.0	0.58	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 corespotlightd	34.8 MB	3	424	40934	timwhite	0.0	1:26:40.95	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 chronod	34.3 MB	2	206	40918	timwhite	0.0	10:01.02	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Windsurf Helper (Plugin)	33.9 MB	10	65	83778	timwhite	0.1	2.27	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 filecoordinationd	33.0 MB	2	128	652	root	0.0	3:31.84	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 biome	32.5 MB	18	32	86406	timwhite	0.0	1.49	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 npm exec mcp-remote https://api.statsig.com/v1/mcp --header statsig-api-key: console-1qEz7avHZI79RBuJcOn3bw0IETZ5nhyl5eWnRbG2q2X	31.6 MB	12	51	86737	timwhite	0.0	0.72	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 sharingd	31.2 MB	6	424	40955	timwhite	0.3	11:41.38	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	Yes	(null)	
 com.apple.DriverKit-AppleBCMWLAN	31.1 MB	7	1,463	554	_driverkit	1.9	6:13:04.56	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 npm exec @modelcontextprotocol/server-puppeteer	31.1 MB	12	51	86738	timwhite	0.0	0.71	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 FwUpdateManagerd	30.8 MB	4	1,067	42046	timwhite	0.0	37.65	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 coreaudiod	29.5 MB	8	2,645	418	_coreaudiod	0.0	25:36.31	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 iconservicesagent	29.2 MB	9	87	34485	timwhite	3.2	1.76	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 suhelperd	29.1 MB	2	44	558	root	0.0	3.60	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 softwareupdated	28.8 MB	4	650	62678	_softwareupdate	0.0	2:51.05	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Avid Audio Server	27.9 MB	4	488	42043	timwhite	0.1	11.41	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas (Service)	27.8 MB	11	113	86793	timwhite	0.0	35.93	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 WindowManager	27.5 MB	9	374	40873	timwhite	0.4	20:03.30	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Open and Save Panel Service (Safari)	27.3 MB	4	267	70092	timwhite	0.1	3.03	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	27.3 MB	11	23	86797	timwhite	0.0	0.32	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Linear Helper	26.2 MB	10	65	38412	timwhite	0.0	5.54	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Cursor Helper (Plugin)	26.2 MB	10	66	46019	timwhite	0.0	11.35	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Windsurf Helper (Plugin)	26.1 MB	10	65	99434	timwhite	0.1	2.43	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 locationd	26.0 MB	6	306	381	_locationd	0.2	1:07:33.13	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Windsurf Helper (Plugin)	25.9 MB	10	65	84829	timwhite	0.0	2.62	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 LinearMouse	25.7 MB	4	557	42067	timwhite	0.9	15:17.82	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 avconferenced	25.6 MB	6	315	41097	timwhite	0.0	40.06	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Claude Helper (Renderer)	24.8 MB	15	118	49677	timwhite	0.0	2.89	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	24.7 MB	12	27	28073	timwhite	0.0	0.48	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Cursor Helper (Plugin)	24.0 MB	10	66	48144	timwhite	0.1	10.31	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 logd	23.9 MB	4	2,285	333	root	0.8	4:02:46.32	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Claude Helper	23.9 MB	14	98	49674	timwhite	0.3	1:39.54	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas (Plugin)	23.7 MB	14	407	81204	timwhite	0.1	15.95	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 suggestd	23.4 MB	2	342	68184	timwhite	0.0	29.97	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 siriinferenced	23.2 MB	2	134	46460	timwhite	0.0	15.20	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Claude Helper (Renderer)	23.1 MB	15	118	49675	timwhite	0.0	4.87	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Claude Helper (Plugin)	23.1 MB	15	88	7577	timwhite	0.0	5.32	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 launchd	22.7 MB	4	4,206	1	root	1.8	10:57:53.48	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Windsurf Helper (Plugin)	22.7 MB	10	65	87068	timwhite	0.0	2.25	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 WavesLocalServer	22.4 MB	2	25	42049	timwhite	0.1	3:42.20	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 StocksWidget	22.4 MB	9	148	44699	timwhite	0.0	32.99	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Cursor Helper (Plugin)	22.4 MB	14	70	45438	timwhite	0.0	9.27	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 diskimagesiod	22.4 MB	3	80	57755	_diskimagesiod	0.0	0.32	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 diskimagesiod	22.2 MB	3	86	57732	_diskimagesiod	0.0	0.29	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 diskimagesiod	22.2 MB	3	85	57725	_diskimagesiod	0.0	0.32	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 diskimagesiod	22.2 MB	3	86	57744	_diskimagesiod	0.0	0.32	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 diskimagesiod	22.2 MB	3	85	57739	_diskimagesiod	0.0	0.30	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 identityservicesd	21.9 MB	6	1,188	40904	timwhite	0.1	5:22.78	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 homed	21.9 MB	3	257	66337	timwhite	0.0	47.98	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Messages Assistant Extension	21.6 MB	4	268	58844	timwhite	0.0	2.37	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 System Information	21.4 MB	4	239	73930	timwhite	0.1	1.09	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 NewsToday2	21.3 MB	4	129	90170	timwhite	0.0	10:02.88	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Linear Helper	20.6 MB	14	94	38410	timwhite	0.1	37.77	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 stripe	20.4 MB	12	39	57060	timwhite	0.0	2:13.40	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 imagent	20.1 MB	4	297	40985	timwhite	0.3	4:04.60	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	19.7 MB	7	19	35222	timwhite	(null)	0.18	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 stripe	19.6 MB	11	37	87058	timwhite	0.0	1.66	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 stripe	19.5 MB	12	39	17011	timwhite	0.0	1:10.70	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ChatGPT Atlas (Service)	19.4 MB	13	258	81203	timwhite	0.0	12.52	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Accessibility	19.3 MB	4	518	40949	timwhite	0.1	9.68	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 wifianalyticsd	19.3 MB	2	86	745	root	0.0	1:54.28	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 TextInputMenuAgent	19.2 MB	4	497	42062	timwhite	0.1	25.42	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Windsurf Helper	19.1 MB	14	102	81785	timwhite	0.1	12.72	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Safari Graphics and Media	18.8 MB	10	291	70072	timwhite	0.0	13.86	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 WeatherWidget	18.7 MB	5	136	30248	timwhite	0.0	5.29	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 assistantd	18.5 MB	4	527	52539	timwhite	0.0	16.76	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 CursorUIViewService	18.0 MB	4	575	41017	timwhite	0.2	7:27.24	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 routined	18.0 MB	2	246	69891	timwhite	0.0	37.99	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 corespeechd	17.6 MB	6	339	42033	timwhite	0.0	1:03.71	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 airportd	17.5 MB	10	374	473	root	0.3	2:28:16.10	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	17.4 MB	7	19	28680	timwhite	0.0	0.35	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 1Password Helper (GPU)	17.3 MB	16	145	42096	timwhite	0.0	2:04.13	(null)	Apple	0.0	0.01	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ScreenTimeWidgetExtension	17.0 MB	3	124	65248	timwhite	0.0	6.14	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 duetexpertd	17.0 MB	2	299	69878	timwhite	0.0	3:24.76	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 dasd	16.9 MB	3	585	385	root	0.1	16:31:17.76	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 fseventsd	16.7 MB	19	632	337	root	1.5	5:37:35.06	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 AutoFill (ChatGPT Atlas)	16.4 MB	4	335	68102	timwhite	0.1	22.95	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 turbo	16.3 MB	18	49	22631	timwhite	0.0	17.32	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 CoreServicesUIAgent	16.3 MB	4	235	69895	timwhite	0.1	1.24	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 WorldClockWidget	16.2 MB	12	116	44914	timwhite	0.0	11.91	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 usernoted	15.8 MB	2	281	40889	timwhite	0.0	2:16.13	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 node	15.6 MB	7	19	28754	timwhite	0.0	0.20	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Wallpaper	15.6 MB	6	487	40921	timwhite	0.1	34.10	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 spindump	15.2 MB	2	114	28676	root	0.0	3.34	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 NightlyCP Utility Process	15.1 MB	5	53	35138	timwhite	0.0	0.22	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 NightlyCP Utility Process	15.1 MB	8	62	35218	timwhite	0.0	0.17	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 coreservicesd	14.7 MB	4	925	413	root	0.1	4:32.40	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 NightlyCP Socket Process	14.7 MB	9	50	35207	timwhite	0.0	0.25	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 NightlyCP Socket Process	14.6 MB	9	50	35211	timwhite	0.0	0.26	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 NightlyCP Socket Process	14.5 MB	7	44	35124	timwhite	0.0	0.24	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 callservicesd	14.5 MB	7	467	10271	timwhite	0.1	4.41	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 spotlightknowledged	14.5 MB	4	88	40931	timwhite	0.0	1:42.49	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 launchservicesd	14.5 MB	11	1,126	376	root	2.7	41:50.58	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 CloudClientServices	14.4 MB	46	78	42061	timwhite	0.2	23:54.40	(null)	Intel	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 PowerChime	14.3 MB	7	685	91884	timwhite	0.1	15.79	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 PerfPowerServices	14.3 MB	5	594	74155	root	0.1	2:39.60	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 fileproviderd	14.3 MB	4	173	40923	timwhite	0.0	10:50.38	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 NightlyCP RDD Process	14.2 MB	6	74	35215	timwhite	0.0	0.12	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Cursor Helper	14.2 MB	11	96	44463	timwhite	0.0	33.80	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 NightlyCP RDD Process	14.1 MB	6	72	35209	timwhite	0.0	0.11	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 NightlyCP RDD Process	14.1 MB	6	72	35129	timwhite	0.0	0.11	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Cursor Helper	13.9 MB	10	245	45006	timwhite	0.0	11.55	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 WallpaperAerialsExtension	13.6 MB	8	131	40943	timwhite	0.0	1:52.37	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 accountsd	13.3 MB	3	145	84353	timwhite	0.0	1:23.54	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 universalAccessAuthWarn	13.2 MB	4	439	3103	timwhite	0.1	7.05	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 CodeMeterMacX	13.1 MB	11	187	584	root	0.1	1:07:52.15	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 searchpartyuseragent	13.0 MB	4	240	20404	timwhite	0.0	4.48	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 CalendarWidgetExtension	12.8 MB	5	106	44848	timwhite	0.0	24.89	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 opendirectoryd	12.8 MB	9	1,823	373	root	0.4	1:13:41.53	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 fontd	12.5 MB	3	206	40912	timwhite	2.1	3:27.13	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Antares Central Services	12.5 MB	6	473	42369	timwhite	0.1	2:23.04	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 passd	12.4 MB	2	216	14003	timwhite	0.0	1:29:33.73	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 LinkedNotesUIService	12.3 MB	5	453	82141	timwhite	0.1	5.85	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 kernelmanagerd	12.2 MB	2	59	364	root	0.0	2.95	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 siriactionsd	12.2 MB	5	129	31119	timwhite	0.1	13.64	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Dropbox Finder Extension	12.2 MB	4	162	79905	timwhite	0.1	0.48	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 IntelligencePlatformComputeService	12.2 MB	2	57	99001	timwhite	0.0	3.84	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 knowledge-agent	12.1 MB	2	232	92848	timwhite	0.1	12.47	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 cloudd	12.0 MB	4	212	84349	timwhite	0.0	2:13.12	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 runningboardd	12.0 MB	8	837	410	root	0.7	3:03:16.14	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 secd	11.8 MB	3	253	66011	timwhite	0.1	1:00.02	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mobileassetd	11.8 MB	3	110	27586	root	0.0	20.76	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 UIKitSystem	11.7 MB	2	98	72899	timwhite	0.0	12.67	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 FindMyWidgetPeople	11.6 MB	11	186	41436	timwhite	0.0	0.46	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 php-fpm	11.6 MB	2	33	42052	timwhite	0.0	26.23	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 photolibraryd	11.5 MB	2	232	19579	timwhite	0.0	5.26	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 SystemUIServer	11.3 MB	6	491	40915	timwhite	0.1	8.53	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 photoanalysisd	11.3 MB	3	168	26889	timwhite	0.0	3.62	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 dataaccessd	11.3 MB	4	184	29463	timwhite	0.0	3.60	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 networkserviceproxy	11.2 MB	3	124	92195	timwhite	0.0	7.98	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 CmWebAdmin	11.2 MB	9	38	581	root	0.0	2:52.71	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 1Password Browser Helper	10.9 MB	5	509	42038	timwhite	0.1	7.49	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 NewsTodayIntents	10.9 MB	7	114	41758	timwhite	0.0	0.29	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 doppler	10.8 MB	14	42	28044	timwhite	0.0	0.61	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 universalaccessd	10.8 MB	7	620	40872	timwhite	0.1	1:01.83	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 rapportd	10.8 MB	3	491	40887	timwhite	0.1	7:54.60	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 HomeWidget	10.8 MB	3	84	41442	timwhite	0.0	0.43	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 modelmanagerd	10.7 MB	2	91	542	_modelmanagerd	0.0	3:53.31	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 donotdisturbd	10.7 MB	2	207	99000	timwhite	0.0	3.15	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.CoreSimulator.CoreSimulatorService	10.6 MB	3	262	70082	timwhite	0.0	0.49	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ScreenTimeAgent	10.6 MB	2	180	21577	timwhite	0.0	18.15	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 esbuild	10.6 MB	9	19	22762	timwhite	0.1	15:07.21	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 appstoreagent	10.4 MB	3	134	26501	timwhite	0.0	2.06	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.cmio.registerassistantservice	10.3 MB	4	163	403	root	0.1	4:20.43	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ollama	10.3 MB	10	33	42090	timwhite	0.0	43.45	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 licenseDaemon	10.3 MB	29	503	587	root	0.0	4:55.98	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 BatteriesAvocadoWidgetExtension	10.2 MB	4	81	41476	timwhite	0.0	3:53.22	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 searchpartyd	10.2 MB	8	133	574	root	0.2	1:13:13.58	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 HomeEnergyWidgetsExtension	10.1 MB	3	84	43838	timwhite	0.0	0.31	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 remindd	10.1 MB	4	108	33299	timwhite	0.0	1.20	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 peopled	10.1 MB	2	186	46709	timwhite	0.0	1:04.79	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 CommCenter	10.0 MB	8	187	40881	timwhite	0.1	1:32.84	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 PodcastsWidget	10.0 MB	3	77	43866	timwhite	0.0	0.27	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 AirPlay Screen Mirroring	9.7 MB	4	468	42054	timwhite	0.1	6.26	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Universal Control	9.4 MB	2	124	80715	timwhite	0.2	17.55	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 calaccessd	9.4 MB	2	200	29585	timwhite	0.0	1.84	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mediaanalysisd	9.4 MB	2	86	32638	timwhite	0.0	2.96	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 SiriSuggestionsBookkeepingService	9.3 MB	2	104	94323	timwhite	0.0	2.36	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 SafariWidgetExtension	9.2 MB	5	68	44915	timwhite	0.0	0.23	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 diskimagesiod	9.2 MB	3	81	57749	_diskimagesiod	0.0	0.14	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 MobileDeviceUpdater	9.1 MB	6	338	40102	timwhite	0.1	6.64	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 configd	9.0 MB	9	1,057	345	root	0.0	11:18.90	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Adobe Content Synchronizer Finder Extension	9.0 MB	5	476	40939	timwhite	0.1	6.49	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 managedappdistributionagent	8.9 MB	2	212	46794	timwhite	0.0	55.64	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 milod	8.9 MB	4	154	69153	timwhite	0.0	2:21.44	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 StatusKitAgent	8.9 MB	2	112	40977	timwhite	0.0	24.88	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 MTLCompilerService	8.9 MB	2	31	32537	root	0.0	0.36	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 amsengagementd	8.8 MB	2	104	20679	timwhite	0.0	1.61	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 managedappdistributiond	8.8 MB	2	209	5332	root	0.0	4:16.66	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 replicatord	8.8 MB	2	117	98873	timwhite	0.0	3.90	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 trustd	8.8 MB	3	119	66051	_trustd	1.9	1:43:22.33	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 apsd	8.7 MB	2	427	375	root	0.0	10:13.86	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 UserEventAgent	8.6 MB	2	1,374	40864	timwhite	0.0	3:40:42.20	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Dropbox Finder Extension	8.6 MB	4	409	86230	timwhite	0.1	4.02	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.PressAndHold	8.5 MB	4	570	40932	timwhite	0.1	38.54	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 trustd	8.5 MB	2	249	65688	timwhite	0.3	3:19.48	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 symptomsd	8.5 MB	4	171	515	_networkd	0.5	1:13:12.53	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 amsaccountsd	8.5 MB	2	103	98881	timwhite	0.0	1.33	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 biome	8.4 MB	17	31	42705	timwhite	0.0	0.18	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 biome	8.3 MB	18	28	86398	timwhite	0.0	0.16	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 distnoted	8.3 MB	3	987	579	timwhite	0.1	26:26.72	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mDNSResponder	8.3 MB	5	126	496	_mdnsresponder	0.8	45:27.88	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 usernotificationsd	8.2 MB	2	197	40902	timwhite	0.0	22.51	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Dock Extra	8.2 MB	4	187	39270	timwhite	0.1	1.56	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 biome	8.2 MB	18	30	41637	timwhite	0.0	0.02	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 talagentd	8.1 MB	3	148	99466	timwhite	0.1	9.98	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 BiomeAgent	8.1 MB	2	246	9020	timwhite	0.0	2:38.94	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 postersyncd	8.0 MB	2	134	34209	timwhite	0.0	0.51	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 CoreLocationAgent	8.0 MB	5	162	20140	timwhite	0.1	1.99	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 securityd	8.0 MB	5	146	379	root	0.0	11:12.12	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 JournalWidgets	7.9 MB	3	67	41448	timwhite	0.0	0.15	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 findmylocateagent	7.9 MB	2	102	30972	timwhite	0.0	0.50	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 NewsTag	7.8 MB	3	69	44940	timwhite	0.0	0.20	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ShortcutsViewService	7.7 MB	3	157	20037	timwhite	0.0	0.40	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 audioaccessoryd	7.7 MB	8	374	36755	timwhite	0.0	57.54	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 JournalWidgetsSecure	7.6 MB	3	65	43816	timwhite	0.0	0.13	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 CloudTelemetryService	7.6 MB	3	70	84355	timwhite	0.0	9.65	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 replayd	7.5 MB	5	107	27404	timwhite	0.0	2.61	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 GenerativeExperiencesSafetyInferenceProvider	7.5 MB	4	55	995	_modelmanagerd	0.0	44.23	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ViewBridgeAuxiliary	7.5 MB	3	226	40988	timwhite	0.1	1:29.20	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.siri.embeddedspeech	7.4 MB	2	43	34561	timwhite	0.0	3.83	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 bird	7.4 MB	2	97	28891	timwhite	0.0	2.49	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 nsurlsessiond	7.4 MB	6	121	77627	timwhite	0.0	2:56.73	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 TransportClient	7.4 MB	55	80	42041	timwhite	0.1	5:12.60	(null)	Intel	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 nsurlsessiond	7.3 MB	5	96	425	_nsurlsessiond	0.0	7:22.86	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 intelligenceplatformd	7.3 MB	2	62	31045	timwhite	0.0	0.52	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 imklaunchagent	7.3 MB	2	148	40930	timwhite	0.0	2.19	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 managedcorespotlightd	7.1 MB	4	59	19774	timwhite	0.0	0.46	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 NewsScoringService	7.1 MB	2	58	19995	timwhite	0.0	0.58	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 UserEventAgent	7.1 MB	5	1,153	335	root	0.1	7:26.85	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ContextStoreAgent	7.1 MB	3	99	69401	timwhite	0.1	12.21	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 IMDPersistenceAgent	7.1 MB	2	118	34195	timwhite	0.0	0.37	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mdbulkimport	7.1 MB	2	65	921	timwhite	0.0	1:16.15	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ContinuityCaptureAgent	7.0 MB	8	309	40901	timwhite	0.1	5:54.83	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.mail.SpotlightIndexExtension	7.0 MB	3	90	54291	timwhite	0.0	1:30.39	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Adobe Content Synchronizer Finder Extension	7.0 MB	5	171	79906	timwhite	0.1	0.40	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ScreenTimeWidgetIntentsExtension	6.8 MB	3	75	41674	timwhite	0.0	0.14	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 lsd	6.8 MB	4	690	607	timwhite	0.2	16:47.25	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 tccd	6.8 MB	4	67	84382	root	0.4	35.73	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 assetsubscriptiond	6.8 MB	2	72	32667	root	0.0	6:32.21	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 siriknowledged	6.8 MB	2	77	30941	timwhite	0.0	1.22	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 contextstored	6.7 MB	5	162	372	root	0.2	1:05:10.57	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 1Password	6.7 MB	12	192	70091	timwhite	0.0	0.47	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 1Password-BrowserSupport	6.7 MB	11	61	14733	timwhite	0.0	1.17	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.geod	6.7 MB	2	107	98828	timwhite	0.0	1.13	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 1Password-BrowserSupport	6.7 MB	11	61	14719	timwhite	0.0	1.16	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mediaremoted	6.7 MB	4	262	338	root	0.0	3:11.30	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 analyticsd	6.6 MB	2	644	62450	_analyticsd	0.0	39.90	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 1Password Helper	6.5 MB	12	86	42097	timwhite	0.0	1:00.39	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mdbulkimport	6.5 MB	2	59	935	_spotlight	0.0	3.73	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 familycircled	6.5 MB	3	115	40980	timwhite	0.0	25.48	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 UsageTrackingAgent	6.4 MB	2	111	26417	timwhite	0.0	2.59	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 RecordWidgetExtension	6.3 MB	3	67	41458	timwhite	0.0	0.09	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 powerd	6.3 MB	3	164	347	root	0.1	16:34.60	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	Yes	(null)	
 remotepairingd	6.3 MB	4	63	70081	timwhite	0.0	7.59	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 chrome_crashpad_handler	6.3 MB	5	81	52108	timwhite	0.0	15.80	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 CMFSyncAgent	6.3 MB	2	122	40922	timwhite	0.0	21.47	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mapssyncd	6.3 MB	2	79	30450	timwhite	0.0	0.46	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 LicenseService	6.3 MB	7	131	50392	root	0.0	0.80	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 tccd	6.2 MB	2	65	66213	timwhite	0.0	2:23.21	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 SimulatorTrampoline	6.2 MB	3	150	70090	timwhite	0.0	0.15	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Keychain Circle Notification	6.1 MB	4	153	27524	timwhite	0.1	0.67	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 PasswordBreachAgent	6.0 MB	2	76	14717	timwhite	0.0	20.49	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 linkd	6.0 MB	2	224	69415	timwhite	0.0	3.11	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 promotedcontentd	6.0 MB	2	74	26559	timwhite	0.0	0.55	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 simdiskimaged	6.0 MB	2	57	57723	root	0.0	0.33	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 coreduetd	6.0 MB	2	86	28953	root	0.0	1.14	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 webinspectord	5.8 MB	2	56	2784	timwhite	0.0	6.98	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 WeatherIntents	5.8 MB	4	68	41614	timwhite	0.0	0.09	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.geod	5.7 MB	4	70	75058	_locationd	0.0	2.14	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 syncdefaultsd	5.6 MB	2	112	20150	timwhite	0.0	0.72	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 sharedfilelistd	5.6 MB	3	115	40933	timwhite	0.1	8.47	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 BackgroundTaskManagementAgent	5.5 MB	4	158	34499	timwhite	0.1	0.31	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 lsd	5.5 MB	2	143	416	root	0.0	4:21.03	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 nearbyd	5.5 MB	7	97	716	_nearbyd	0.1	10:01.30	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 codex	5.5 MB	11	42	48138	timwhite	0.0	0.03	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 cloudphotod	5.5 MB	2	81	30239	timwhite	0.0	0.35	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 sharedfilelistd	5.5 MB	2	51	50426	root	0.0	1.17	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 IMAutomaticHistoryDeletionAgent	5.5 MB	2	71	18886	timwhite	0.0	2.11	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ShortcutsWidgetExtension	5.4 MB	3	53	44928	timwhite	0.0	0.13	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ecosystemd	5.4 MB	3	52	63396	root	0.6	1:25:26.18	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 SafariBookmarksSyncAgent	5.4 MB	2	80	27560	timwhite	0.0	0.52	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 biomed	5.4 MB	2	80	58855	_biome	0.0	3.25	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 liveactivitiesd	5.3 MB	2	83	20038	timwhite	0.0	0.22	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 pkd	5.3 MB	2	83	98800	timwhite	0.0	0.92	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 diagnostics_agent	5.3 MB	3	100	42060	timwhite	0.1	22.93	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 UVCAssistant	5.3 MB	2	94	591	_cmiodalassistants	0.0	1:20.88	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 intelligentroutingd	5.2 MB	2	75	28950	timwhite	0.0	0.28	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 cfprefsd	5.2 MB	3	550	66349	timwhite	0.6	10:48.96	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.Safari.SearchHelper	5.1 MB	2	61	70075	timwhite	0.0	0.36	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mlhostd	5.1 MB	2	91	28890	timwhite	0.0	0.74	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.Notes.WidgetExtension	5.1 MB	5	57	44920	timwhite	0.0	0.12	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 codex	5.1 MB	11	39	86344	timwhite	0.0	0.02	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 akd	5.1 MB	2	81	98776	timwhite	0.0	0.90	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 spotlightknowledged	5.1 MB	2	45	47176	timwhite	0.0	50.57	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 proactived	5.1 MB	2	85	98999	timwhite	0.0	1.84	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 useractivityd	5.1 MB	5	122	40984	timwhite	0.0	1:00.71	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 audiomxd	5.0 MB	4	275	526	_audiomxd	0.0	34.88	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 coreauthd	5.0 MB	2	116	709	timwhite	0.0	1:10.58	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 coreauthd	5.0 MB	2	80	578	root	0.0	34.22	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 commerce	5.0 MB	2	65	41459	timwhite	0.0	8.28	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.Safari.History	5.0 MB	2	63	70031	timwhite	0.0	0.34	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 PeopleWidget_macOSExtension	4.9 MB	3	60	44893	timwhite	0.0	0.09	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.CloudDocs.iCloudDriveFileProvider	4.9 MB	2	67	46590	timwhite	0.0	6.69	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 wifip2pd	4.9 MB	2	61	156	root	0.0	2.18	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 gamepolicyd	4.9 MB	6	71	65670	root	0.3	1:02.12	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.Safari.SafeBrowsing.Service	4.9 MB	2	59	25868	timwhite	0.0	2.43	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 MobileTimerIntents	4.9 MB	8	62	41484	timwhite	0.0	0.11	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 RemindersWidgetExtension	4.8 MB	3	60	44916	timwhite	0.0	0.09	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 authd	4.8 MB	3	97	493	root	0.0	1:17.59	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ContextService	4.8 MB	2	53	19990	timwhite	0.0	0.18	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 SubmitDiagInfo	4.8 MB	3	73	875	root	0.0	35.29	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 deleted	4.7 MB	2	86	98795	timwhite	0.0	5.69	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 corebrightnessd	4.7 MB	5	155	401	root	0.4	52:38.40	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 eligibilityd	4.6 MB	2	38	432	root	0.0	43.14	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 Squirrel	4.6 MB	7	37	42047	timwhite	0.0	2.90	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 wifivelocityd	4.6 MB	2	76	82188	root	0.0	26.78	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 modelcatalogd	4.6 MB	2	41	28880	root	0.0	0.29	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 triald	4.6 MB	2	75	34686	timwhite	0.0	0.19	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 symptomsd-diag	4.6 MB	2	60	28954	root	0.0	0.19	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 axassetsd	4.5 MB	2	49	32967	timwhite	0.0	0.74	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 dmd	4.5 MB	2	58	34484	timwhite	0.0	0.18	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 secinitd	4.5 MB	2	52	62997	timwhite	0.0	4.65	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 pboard	4.5 MB	3	230	40877	timwhite	0.0	13.37	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 storagekitd	4.5 MB	6	86	20447	root	0.0	1.16	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 XProtectBridgeService	4.4 MB	2	47	20678	root	0.0	0.36	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 cloudd	4.4 MB	2	58	28960	root	0.0	0.29	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 systemstats	4.4 MB	3	102	341	root	0.1	4:09.98	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 cfprefsd	4.4 MB	4	992	408	root	0.3	31:39.89	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 AirPlayXPCHelper	4.4 MB	4	81	402	root	0.0	27.24	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 notifyd	4.4 MB	3	1,133	399	root	0.5	1:22:32.38	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ecosystemanalyticsd	4.4 MB	3	55	31653	root	1.7	13:58.73	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 keyboardservicesd	4.4 MB	2	56	34515	timwhite	0.0	0.11	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 findmybeaconingd	4.3 MB	2	39	20427	root	0.0	0.25	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 cupsd	4.3 MB	3	53	455	root	0.0	32.14	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 revisiond	4.3 MB	3	65	393	root	0.0	10.51	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 zsh	4.3 MB	1	22	82149	timwhite	0.0	0.64	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 zsh	4.3 MB	1	22	82202	timwhite	0.0	0.68	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 WirelessRadioManagerd	4.3 MB	3	84	66352	root	0.0	22.40	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 zsh	4.3 MB	1	22	82147	timwhite	0.0	0.66	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 zsh	4.3 MB	1	22	82151	timwhite	0.0	0.66	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 appleh13camerad	4.2 MB	6	113	567	_cmiodalassistants	0.0	2:41.83	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 chrome_crashpad_handler	4.2 MB	4	45	15624	timwhite	0.0	6.12	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 chrome_crashpad_handler	4.2 MB	3	42	56767	timwhite	0.0	1.63	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 systemsoundserverd	4.2 MB	5	219	32250	root	0.0	0.15	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 corerepaird	4.2 MB	2	36	386	root	0.0	1.01	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ospredictiond	4.2 MB	2	60	27557	root	0.0	0.38	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 usbmuxd	4.2 MB	3	46	378	_usbmuxd	0.0	13:09.96	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ContainerMetadataExtractor	4.2 MB	2	59	29015	timwhite	0.0	0.22	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 chrome_crashpad_handler	4.2 MB	3	41	6325	timwhite	0.0	1.23	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 chrome_crashpad_handler	4.2 MB	3	42	50766	timwhite	0.0	0.62	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 TipsWidgetExtension	4.2 MB	3	53	44926	timwhite	0.0	0.06	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 PhotosReliveWidget	4.2 MB	3	53	44884	timwhite	0.0	0.06	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 chrome_crashpad_handler	4.2 MB	3	42	34417	timwhite	0.0	1.59	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mobiletimerd	4.2 MB	3	56	31137	timwhite	0.0	0.20	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 backgroundtaskmanagementd	4.2 MB	3	69	34502	root	0.0	0.16	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 CloudTelemetryService	4.1 MB	2	35	20677	root	0.0	0.22	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.AmbientDisplayAgent	4.1 MB	3	80	40982	root	0.1	13:51.78	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 chrome_crashpad_handler	4.1 MB	3	42	2653	timwhite	0.0	1.84	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 zsh	4.1 MB	1	22	45115	timwhite	0.0	0.15	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 chrome_crashpad_handler	4.1 MB	3	42	20779	timwhite	0.0	1.65	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 chrome_crashpad_handler	4.1 MB	3	42	35868	timwhite	0.0	0.92	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 sociallayerd	4.0 MB	2	67	27581	timwhite	0.0	0.18	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 PowerUIAgent	4.0 MB	2	65	25861	root	0.0	0.27	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 zsh	4.0 MB	1	22	45112	timwhite	0.0	0.15	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 AppPredictionIntentsHelperService	4.0 MB	2	32	31043	timwhite	0.0	0.21	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 VDCAssistant	4.0 MB	2	71	430	_cmiodalassistants	0.0	2.35	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 browser_crashpad_handler	4.0 MB	4	39	86782	timwhite	0.0	0.45	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 chrome_crashpad_handler	4.0 MB	3	41	1658	timwhite	0.0	1.16	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 chrome_crashpad_handler	4.0 MB	3	42	31338	timwhite	0.0	0.80	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 CloudTelemetryService	4.0 MB	2	34	29016	root	0.0	0.12	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 AMPDeviceDiscoveryAgent	4.0 MB	5	250	40936	timwhite	0.0	2:58.20	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 chrome_crashpad_handler	3.9 MB	3	42	64883	timwhite	0.0	0.50	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 sandboxd	3.9 MB	3	57	70089	root	0.0	0.49	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 triald_system	3.9 MB	2	62	28860	root	0.0	0.29	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 VTDecoderXPCService	3.9 MB	2	66	31153	timwhite	0.0	1.24	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 MessagesBlastDoorService	3.9 MB	2	31	27493	timwhite	0.0	0.40	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 fontworker	3.9 MB	2	46	40929	timwhite	0.0	1.02	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 systemstatusd	3.9 MB	2	66	52307	root	0.0	2.91	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 biometrickitd	3.8 MB	2	74	98770	root	0.0	0.19	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 CategoriesService	3.8 MB	2	51	19989	timwhite	0.0	0.10	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 appleeventsd	3.8 MB	4	368	544	_appleevents	0.0	25.18	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 businessservicesd	3.8 MB	2	63	27492	timwhite	0.0	0.23	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.docker.vmnetd	3.8 MB	6	24	586	root	0.0	7.98	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 extensionkitservice	3.8 MB	2	44	66479	timwhite	0.0	57.77	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 VTDecoderXPCService	3.7 MB	2	68	35210	timwhite	0.0	0.08	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 timed	3.7 MB	2	73	377	_timed	0.0	44.09	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 containermanagerd	3.7 MB	2	48	64997	timwhite	0.0	43.12	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 remoted	3.7 MB	2	106	352	root	0.0	8.43	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 VTDecoderXPCService	3.7 MB	2	67	35132	timwhite	0.0	0.08	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 VTDecoderXPCService	3.7 MB	2	66	35216	timwhite	0.0	0.08	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 swcd	3.7 MB	2	46	34497	timwhite	0.0	0.55	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 aned	3.6 MB	3	90	66094	root	0.0	24.02	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 intelligenceflowd	3.6 MB	2	46	27499	timwhite	0.0	0.56	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mdworker_shared	3.6 MB	6	53	35205	timwhite	(null)	0.07	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 diskarbitrationd	3.6 MB	2	454	365	root	0.1	13:07.12	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 fairplayd	3.5 MB	2	42	991	_fpsd	0.0	45.69	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ScopedBookmarkAgent	3.5 MB	2	48	19581	timwhite	0.0	0.22	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 dprivacyd	3.5 MB	2	52	28957	timwhite	0.0	0.19	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 SidecarRelay	3.5 MB	3	74	25901	timwhite	0.1	17.25	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.iCloudHelper	3.5 MB	2	51	34188	timwhite	0.0	0.21	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mdworker_shared	3.5 MB	4	51	35067	timwhite	0.0	0.08	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 cameracaptured	3.4 MB	2	68	590	_cmiodalassistants	0.0	1.48	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 contentlinkingd	3.4 MB	4	62	99430	timwhite	0.1	0.81	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 rtcreportingd	3.4 MB	3	39	31097	root	0.0	0.11	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 apfsd	3.4 MB	2	80	424	root	0.0	6:25.23	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 AvidAudioServiceHelper	3.4 MB	2	45	583	root	0.0	0.02	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 SetStoreUpdateService	3.4 MB	2	40	34525	timwhite	0.0	0.15	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 neagent	3.4 MB	2	50	98767	timwhite	0.0	0.35	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.audio.Core-Audio-Driver-Service.helper	3.4 MB	4	51	532	_coreaudiod	0.0	1:28.96	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 extensionkitservice	3.4 MB	2	44	28892	timwhite	0.0	0.21	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mdworker_shared	3.4 MB	4	49	34625	timwhite	0.0	0.16	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 audioanalyticsd	3.3 MB	2	48	32252	root	0.0	0.14	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 backupd	3.3 MB	3	43	66045	root	0.0	30.02	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mdwrite	3.3 MB	2	47	60929	timwhite	0.0	1.10	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 systemstats	3.3 MB	4	200	3407	root	0.0	13.93	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 nesessionmanager	3.3 MB	2	60	3782	root	0.0	0.45	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 nfcd	3.3 MB	2	56	27502	_applepay	0.0	0.20	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 icdd	3.3 MB	2	63	42045	timwhite	0.0	0.95	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ctkd	3.3 MB	2	46	28917	timwhite	0.0	0.24	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 lockoutagent	3.3 MB	4	59	40884	timwhite	0.1	1:56.01	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mdworker_shared	3.2 MB	3	47	35007	timwhite	0.0	0.06	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ManagedSettingsAgent	3.2 MB	2	50	98879	timwhite	0.0	0.16	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 inputanalyticsd	3.2 MB	2	45	30944	timwhite	0.0	0.22	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mdworker_shared	3.2 MB	3	47	35006	timwhite	0.0	0.06	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 XprotectService	3.2 MB	2	31	21077	root	0.0	12.78	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ContactsCoreSpotlightExtension	3.2 MB	3	51	54290	timwhite	0.0	0.37	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 devicecheckd	3.2 MB	2	53	32541	timwhite	0.0	0.11	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mdworker_shared	3.2 MB	3	47	34912	timwhite	0.0	0.06	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mdworker_shared	3.2 MB	3	47	34848	timwhite	0.0	0.08	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 parsec-fbf	3.2 MB	2	59	28899	timwhite	0.0	0.16	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 amfid	3.1 MB	2	39	30763	root	0.0	0.07	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mdworker_shared	3.1 MB	3	47	35066	timwhite	0.0	0.07	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 nehelper	3.1 MB	2	70	98765	root	0.0	1.05	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 NFStorageServer	3.1 MB	2	30	27503	_applepay	0.0	0.04	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.avid.bsd.shoetoolv120	3.1 MB	2	26	582	root	0.0	0.11	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mdworker_shared	3.1 MB	3	47	34895	timwhite	0.0	0.07	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 securityd_system	3.1 MB	2	31	28919	root	0.0	0.08	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 BTLEServer	3.0 MB	2	41	44273	root	0.0	17.56	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mDNSResponderHelper	3.0 MB	3	45	551	root	0.0	1:12.72	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 MENotificationAgent	3.0 MB	2	40	34498	timwhite	0.0	0.07	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.audio.Core-Audio-Driver-Service.helper	3.0 MB	5	53	530	_coreaudiod	0.0	0.89	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 osanalyticshelper	3.0 MB	2	59	28874	root	0.0	0.27	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 cdpd	3.0 MB	2	44	27568	timwhite	0.0	0.08	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 audioclocksyncd	2.9 MB	3	51	527	root	0.1	23:03.90	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.audio.Core-Audio-Driver-Service.helper	2.9 MB	4	40	540	_coreaudiod	0.0	21.14	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.audio.SandboxHelper	2.9 MB	2	25	32256	root	0.0	0.05	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 countryd	2.9 MB	2	33	33879	root	0.0	0.09	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 feedbackd	2.8 MB	2	54	27494	timwhite	0.0	0.14	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.audio.Core-Audio-Driver-Service.helper	2.8 MB	4	51	528	_coreaudiod	0.0	0.01	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ctkd	2.8 MB	2	32	708	_ctkd	0.0	5.16	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 chrome_crashpad_handler	2.8 MB	3	31	41042	timwhite	0.0	0.30	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 chrome_crashpad_handler	2.8 MB	3	31	92549	timwhite	0.0	0.54	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 chrome_crashpad_handler	2.8 MB	4	34	49668	timwhite	0.0	0.28	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ShipIt	2.8 MB	2	42	53354	timwhite	0.0	0.05	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 powerexperienced	2.8 MB	2	44	27558	root	0.0	0.07	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 AssetCacheLocatorService	2.8 MB	2	47	98882	timwhite	0.0	0.19	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 chrome_crashpad_handler	2.8 MB	4	34	38407	timwhite	0.0	0.21	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 fairplaydeviceidentityd	2.7 MB	2	32	26565	_fpsd	0.0	3.81	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 logind	2.7 MB	2	105	392	root	0.0	21.98	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 chrome_crashpad_handler	2.7 MB	4	34	44460	timwhite	0.0	0.21	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 thermalmonitord	2.7 MB	2	52	371	root	0.0	5:05.67	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 sysmond	2.7 MB	2	23	99099	root	1.7	1:10.23	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 AudioComponentRegistrar	2.7 MB	2	37	32253	root	0.0	0.07	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.audio.Core-Audio-Driver-Service.helper	2.7 MB	4	42	525	_coreaudiod	0.0	0.01	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 chrome_crashpad_handler	2.7 MB	3	31	81778	timwhite	0.0	0.05	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.hiservices-xpcservice	2.7 MB	2	86	65742	timwhite	0.0	2.38	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.audio.Core-Audio-Driver-Service.helper	2.7 MB	4	48	529	_coreaudiod	0.0	0.30	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 HostInferenceProviderService	2.7 MB	3	29	889	_modelmanagerd	0.0	1.28	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 TrialArchivingService	2.7 MB	2	37	34688	timwhite	0.0	0.08	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 pbs	2.6 MB	2	43	31115	timwhite	0.0	0.06	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 backupd-helper	2.6 MB	2	50	98819	root	0.0	0.29	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ctkahp	2.6 MB	2	49	42065	timwhite	0.0	1.11	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mbuseragent	2.6 MB	2	45	39357	timwhite	0.0	0.15	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 MTLAssetUpgraderD	2.6 MB	2	48	34496	timwhite	0.0	0.09	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 adid	2.6 MB	2	36	98779	_fpsd	0.0	0.42	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ctkahp	2.6 MB	2	39	806	root	0.0	1.99	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 iconservicesd	2.6 MB	3	40	34486	_iconservices	0.1	0.11	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mobileactivationd	2.5 MB	2	40	98769	root	0.0	0.33	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mdsync	2.5 MB	2	39	72216	root	0.0	0.09	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.CodeSigningHelper	2.5 MB	3	24	69466	root	0.2	0.73	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.AppStoreDaemon.StorePrivilegedODRService	2.5 MB	2	28	26538	root	0.0	0.05	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 PerfPowerTelemetryClientRegistrationService	2.5 MB	2	26	27714	root	0.0	0.04	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 aneuserd	2.5 MB	2	42	28996	_neuralengine	0.0	0.07	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 usermanagerd	2.5 MB	2	60	19088	root	0.0	0.77	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 tracd	2.5 MB	2	38	18118	root	0.0	0.08	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 SimLaunchHost.arm64	2.5 MB	2	29	57760	timwhite	0.0	0.06	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 automountd	2.4 MB	4	28	660	root	0.0	2.90	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 netbiosd	2.4 MB	2	25	26893	_netbios	0.0	0.39	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 installcoordinationd	2.4 MB	2	37	26537	_installcoordinationd	0.0	0.07	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 socketfilterfw	2.4 MB	2	43	510	root	0.0	0.24	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 distnoted	2.3 MB	3	192	388	_distnote	0.0	13:02.74	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ReportSystemMemory	2.2 MB	2	29	34201	_reportsystemmemory	0.0	0.04	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 mediaremoteagent	2.2 MB	2	36	41099	timwhite	0.0	1.72	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 cfprefsd	2.2 MB	2	28	28948	_applepay	0.0	0.07	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 online-auth-agent	2.2 MB	2	33	27517	root	0.0	0.04	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 watchdogd	2.2 MB	3	52	358	root	0.0	1:26.19	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 cfprefsd	2.2 MB	2	28	28993	_locationd	0.0	0.07	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 1Password-Crash-Handler	2.2 MB	3	24	42154	timwhite	0.0	2:01.45	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 browser_crashpad_handler	2.1 MB	3	22	41840	timwhite	0.0	0.04	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 cfprefsd	2.1 MB	2	27	28969	_audiomxd	0.0	0.07	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ioupsd	2.1 MB	2	41	74482	root	0.0	0.04	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 cfprefsd	2.1 MB	2	27	28974	_softwareupdate	0.0	0.07	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 cfprefsd	2.1 MB	2	27	28995	_accessoryupdater	0.0	0.07	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 oahd	2.1 MB	3	37	698	_oahd	0.1	17:46.66	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 CVMServer	2.1 MB	2	41	1549	root	0.0	0.60	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 zsh	2.1 MB	1	22	27990	timwhite	0.0	0.03	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 CrashReporterSupportHelper	2.1 MB	2	36	4934	root	0.0	0.36	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 cfprefsd	2.1 MB	2	27	28946	_securityagent	0.0	0.08	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 cfprefsd	2.1 MB	2	27	28963	_rmd	0.0	0.06	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 cfprefsd	2.1 MB	2	25	28964	_cmiodalassistants	0.0	0.07	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 browser_crashpad_handler	2.1 MB	1	17	86784	timwhite	0.0	0.01	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 browser_crashpad_handler	2.1 MB	1	17	41846	timwhite	0.0	0.01	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 corespeechd_system	2.1 MB	1	26	356	_corespeechd	0.0	0.01	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 cfprefsd	2.1 MB	2	23	28968	_appinstalld	0.0	0.07	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 zsh	2.0 MB	1	22	30008	timwhite	0.0	0.03	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 PlugInLibraryService	2.0 MB	2	27	20004	timwhite	0.0	0.07	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 syslogd	2.0 MB	4	71	369	root	0.1	2:13.61	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 cfprefsd	2.0 MB	2	24	28947	_nsurlsessiond	0.0	0.07	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 IOMFB_bics_daemon	2.0 MB	2	158	348	root	0.0	0.11	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 ReportCrash	2.0 MB	3	34	30658	timwhite	0.0	0.06	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 cfprefsd	2.0 MB	2	23	28949	_neuralengine	0.0	0.08	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 cfprefsd	2.0 MB	2	23	28975	_modelmanagerd	0.0	0.07	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 cfprefsd	2.0 MB	2	24	28994	_installcoordinationd	0.0	0.07	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 dhcp6d	2.0 MB	2	29	87548	nobody	0.0	0.87	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 keybagd	1.9 MB	2	43	34187	root	0.0	0.03	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 AppleCredentialManagerDaemon	1.9 MB	2	37	19184	root	0.0	0.05	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 spindump_agent	1.9 MB	2	37	30928	timwhite	0.0	0.05	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 logd_helper	1.9 MB	2	21	3921	root	0.0	0.19	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 taskgated	1.8 MB	2	23	23132	root	0.0	0.02	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 coresymbolicationd	1.8 MB	2	20	29001	root	0.0	0.09	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 deleted_helper	1.8 MB	2	24	30400	root	0.0	0.32	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 PlugInLibraryService	1.8 MB	2	25	29275	timwhite	0.0	0.03	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 distnoted	1.8 MB	3	30	890	_modelmanagerd	0.0	2:12.21	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 distnoted	1.8 MB	3	31	965	_gamecontrollerd	0.0	2:13.82	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 distnoted	1.8 MB	3	30	900	_accessoryupdater	0.0	2:13.84	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 distnoted	1.8 MB	3	30	616	_nsurlsessiond	0.0	2:11.91	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 distnoted	1.8 MB	3	30	571	_audiomxd	0.0	2:13.18	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 distnoted	1.8 MB	3	31	2906	_installcoordinationd	0.0	2:15.62	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 distnoted	1.7 MB	3	32	930	_spotlight	0.0	2:24.12	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 distnoted	1.7 MB	3	30	631	_appleevents	0.0	2:11.59	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 distnoted	1.7 MB	3	31	11189	_neuralengine	0.0	2:17.14	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 distnoted	1.7 MB	3	31	71649	_appinstalld	0.0	1:55.79	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 distnoted	1.7 MB	3	30	494	root	0.0	2:23.23	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 distnoted	1.7 MB	3	30	593	_softwareupdate	0.0	2:11.21	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 distnoted	1.7 MB	3	30	5289	_rmd	0.0	2:13.52	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 distnoted	1.7 MB	3	30	533	_cmiodalassistants	0.0	2:13.97	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 distnoted	1.7 MB	3	30	884	_securityagent	0.0	2:12.61	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 distnoted	1.7 MB	3	30	486	_coreaudiod	0.0	2:15.81	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 distnoted	1.7 MB	3	30	1014	_applepay	0.0	2:13.16	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 distnoted	1.7 MB	3	31	546	_locationd	0.0	2:12.19	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 distnoted	1.7 MB	3	30	439	_windowserver	0.0	2:20.56	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 AvidAppManHelper	1.7 MB	2	12	3448	timwhite	0.0	0.00	(null)	Intel	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 autofsd	1.6 MB	2	24	384	root	0.0	2.53	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 smd	1.6 MB	2	24	27337	root	0.0	0.10	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 KernelEventAgent	1.6 MB	2	23	394	root	0.0	1.66	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	Yes	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 php-fpm	1.3 MB	1	8	43896	timwhite	0.0	0.00	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 php-fpm	1.3 MB	1	8	43883	timwhite	0.0	0.00	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 AvidAppManHelper	1.2 MB	2	12	3447	timwhite	0.0	0.00	(null)	Intel	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	No	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 grep	1.1 MB	1	11	30035	timwhite	0.0	0.01	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.AppleUserHIDDrivers	1.0 MB	2	104	556	_driverkit	0.0	59.92	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 tail	992 KB	1	11	28016	timwhite	0.0	0.12	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 IOUserBluetoothSerialDriver	864 KB	2	77	62705	_driverkit	0.0	0.31	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 tail	800 KB	1	11	30034	timwhite	0.0	0.01	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 head	800 KB	1	11	30036	timwhite	0.0	0.01	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 com.apple.DriverKit-IOUserDockChannelSerial	800 KB	2	66	555	_driverkit	0.0	0.46	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	Yes	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	
 tee	784 KB	1	11	28015	timwhite	0.0	0.13	(null)	Apple	0.0	0.00	0 bytes	0 bytes	0 bytes	No	No	Yes	(null)	No	0 bytes	0	0 bytes	0	0 bytes	0 bytes	-	0 bytes	0 bytes	No	(null)	


---

## Assistant

Mr. White — the big problem in that list is **`next-server (v16.1.1)` at 5.53 GB**. Everything else is comparatively normal “Electron app + lots of tabs/helpers” noise (Windsurf/Cursor/Claude/ChatGPT renderers, WindowServer, etc.).

### Fast triage (2 minutes)
1. **Quit/Restart the Next dev server**
   - If it’s a dev server, it’s the #1 suspect for runaway RAM (watchers, source maps, cache growth, leaking requests).
2. **Close extra Electron renderers**
   - Windsurf/Cursor/Claude/ChatGPT: every tab/window/extension host spawns processes. Close unused windows, disable heavy extensions, restart those apps.

### Fix the Next server ballooning
In your project folder:

```bash
# stop it cleanly
lsof -iTCP -sTCP:LISTEN -n -P | grep -E ':(3000|3001|8080|5173)'

# if you know the PID (your list shows 28080)
kill -TERM 28080
# if it won't die:
kill -9 28080

# nuke Next cache (common cause of weirdness)
rm -rf .next

# reinstall deps if you suspect corruption
rm -rf node_modules
npm ci

# run again
npm run dev
```

If it *only* happens after the server runs for a while:
- **Look for a memory leak** in API routes, websocket handlers, background intervals, logging buffers, or large in-memory caches.
- If you’re using image optimization heavily, large responses, or server actions that retain references, memory can climb.

To confirm whether it’s a Node heap leak vs “native/other” memory:
```bash
# quick heap snapshot style signal (Chrome DevTools attach)
node --inspect node_modules/.bin/next dev
```
Then open `chrome://inspect` → take heap snapshots over time. If retained objects keep growing, it’s a leak.

### Reduce background load from Windsurf/Cursor/Claude
You have lots of “Helper (Renderer/Plugin)” and many ~38–45MB `node` processes—usually extension hosts, file watchers, language servers.
- Close extra workspaces/projects
- Disable extensions you don’t need (especially AI, linting, indexers)
- Restart the app after long uptime

### When to worry
Check **Activity Monitor → Memory tab → Memory Pressure**:
- **Green:** you’re fine; macOS will cache aggressively.
- **Yellow/Red + lots of swap:** you need to kill the hogs (start with `next-server`, then big Electron apps).

If you tell me whether this is **`next dev`** or a **production server**, and what port it’s listening on, I’ll give you the most likely leak culprits and the exact profiling path.

---

## User

Will the m5 pro have ram higher than what \s avalble on m\the m4pro

---

## Assistant

Mr. White — there’s **no official info yet** on an **M5 Pro** chip’s maximum unified memory, so nobody can say for sure.

What we *can* say today:

- **M4 Pro (current)**: MacBook Pro configs go **up to 48GB unified memory**. citeturn10view1  
- **M5 (base chip, not Pro)**: configs go **up to 32GB unified memory**. citeturn10view2  

So: **we don’t know** whether **M5 Pro** will exceed the **48GB max** of **M4 Pro** until Apple announces it.

---

## User

M4max goes to 128 right

---

## Assistant

Mr. White — **yes, M4 Max goes up to 128GB unified memory** (config option on the 16-core CPU M4 Max). citeturn0search2

For your other question: **there’s no official info yet on whether M5 Pro will exceed M4 Pro’s max memory**, so anything would be speculation until Apple publishes specs. **Right now, M4 Pro tops out at 64GB unified memory**. citeturn0search2

---

## User

Any rumors suggesting it would or wouldnt

---

## Assistant

Mr. White — yep: **M4 Max supports up to 128GB of unified memory**. citeturn18view0  
And **M4 Pro supports up to 64GB**. citeturn18view0

On **M5 Pro**: as of the latest credible info, **Apple has announced M5 (base) but not published specs for an “M5 Pro” memory ceiling**, and the rumor coverage I’m seeing focuses on *timing / product refreshes* rather than *memory tiers*. citeturn23view0turn24news18  

So: **no solid rumor yet that M5 Pro will exceed M4 Pro’s 64GB, and no solid rumor that it won’t**—just not specified in reliable leaks/briefings so far. citeturn24news18

---

## User

If they upped ram like say the m5max goes up to 256gb and the min jumps from 16gb to 32gb then wed proabbly get more ram for the same price right? In which case a wait is warranted? And if so how likely is that?

---

## Assistant

Mr. White — yes: **M4 Max tops out at 128GB unified memory**, and **M4 Pro tops out at 64GB**. citeturn6search14

### Are there rumors that M5 Pro/Max will exceed M4 Pro/Max RAM?
Right now, I’m **not seeing credible/leaky reporting** that specifically claims **M5 Pro > 64GB** or **M5 Max > 128GB**.

What we *can* anchor on is Apple’s recent pattern:
- **Max-tier ceiling** went **64 → 96 → 128 → 128** across M1/M2/M3/M4. citeturn10search11turn6search14  
  That makes a jump to **256GB on the very next Max** feel **unlikely without a big packaging/memory change** (and we’d usually see stronger leakage if it were coming).

Also, Apple’s **base M5 14" MacBook Pro** (the one Apple already refreshed) still starts at **16GB** and kept the same starting price—so there’s **no sign of a near-term “base doubles to 32GB” shift** from that refresh. citeturn12news37

### If Apple *did* raise tiers (e.g., 32GB base, 256GB max), would you get more RAM for the same price?
**Usually yes at the same starting price**, but Apple can (and sometimes does) **reprice configs or make higher RAM a pricier upsell**, so it’s not guaranteed.

### Is waiting warranted, and how likely is your “32GB base / 256GB Max” scenario?
- **256GB on “M5 Max” specifically:** I’d rate it **low likelihood** based on the recent ceiling holding at 128GB on M4 Max and no solid leaks saying otherwise. citeturn10search11turn6search14  
- **Base jumping 16 → 32GB soon:** also **low**, because the **M5 base MBP stayed at 16GB**. citeturn12news37

**Practical take:**  
- If you *need* **>64GB** now, waiting for M5 Pro is probably **not** a smart bet.  
- If you *need* **>128GB**, waiting for M5 Max to hit 256GB is an even **worse bet**—that kind of jump is more plausible with a later generation or different tiering.

If you tell me the **RAM you actually need (64/96/128/192+)** and what you’re doing (LLM local, AE, Xcode, etc.), I’ll give you the clean “buy now vs wait” call.
