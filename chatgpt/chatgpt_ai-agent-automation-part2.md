
Mr. White, the practical answer is:

**Use GitHub Actions + Claude/Codex for serious coding automation. Use Qwen/local models for routing, triage, summaries, cheap first-pass fixes, and business ops. Do not bet the core coding loop on local Qwen yet.**

Your local setup is still useful, but mostly as a **cost-control and orchestration layer**, not as a replacement for Claude/Codex.

## 1. Public GitHub repo changes the cost math

Since your repo is public, GitHub-hosted Actions minutes are already free for standard GitHub-hosted runners. GitHub’s docs say Actions usage is free for public repositories and self-hosted runners; private repos get free quotas and then paid overage. citeturn511137view4

So for things like:

```txt
- nightly test matrix
- Playwright / E2E
- lint/typecheck
- build validation
- main-health check
- scheduled QA scaffolding
```

there is little reason to move the runner workload onto your PC right now. You save almost no runner money, and you add reliability/security complexity.

The main cost lever is **model usage**, not compute.

## 2. Is Qwen good enough for coding remediation?

**Yes, for narrow tasks. No, for the important autonomous coding tasks you described.**

Qwen3-Coder-30B-A3B is a real coding model: the model card says it has 30.5B total parameters, 3.3B activated parameters, native 262K context, and is built for agentic coding/browser-use/repository understanding. citeturn945937view0 The larger Qwen3-Coder-480B model claims performance comparable to Claude Sonnet among open models, but that is not what you are running locally on a 2080 Ti. citeturn945937view2

Your PC can run useful local Qwen, but your 2080 Ti is the limiter. With 11 GB-ish VRAM, local Qwen will usually be quantized, context-limited, and slower than hosted frontier coding agents. It is good for:

```txt
Good Qwen tasks:
- classify PR comments
- summarize failed CI logs
- decide whether a review comment is actionable
- detect duplicate CodeRabbit/Greptile comments
- propose simple lint/type/typecheck fixes
- update snapshots
- fix obvious import/path errors
- write PR summaries
- generate branch names / issue labels
- score investors
- dedupe CRM rows
- summarize Gmail/calendar context
```

It is weak/risky for:

```txt
Do not rely on local Qwen alone:
- auth changes
- payments/billing
- DB migrations
- security/permissions
- multi-file app logic
- complex merge conflicts
- production main-red fixes
- flaky E2E debugging
- GStack /qa browser repair loops
- anything where a wrong patch wastes an hour of your time
```

The correct use is **Qwen as the cheap bouncer at the door**, then Claude/Codex for the real surgery.

## 3. Is there any benefit versus Claude Desktop / Claude Code scheduled tasks?

Yes, but only if you need **workflow-level orchestration**.

Claude Code already has scheduled tasks. Its docs say scheduled tasks can poll deployments, babysit PRs, check long-running builds, and run on intervals; desktop tasks run on your machine, cloud tasks run on Anthropic infrastructure, and `/loop` is for quick polling during a session. Desktop/local tasks can run as frequently as every minute; cloud tasks have a one-hour minimum interval. citeturn511137view0 citeturn511137view1

Codex also now has built-in automations, worktrees, cloud environments, and background work for issue triage, CI/CD, alert monitoring, and routine coding tasks. citeturn930325view2

So the distinction is:

| Need | Use |
|---|---|
| “Run this recurring Claude task” | Claude Code Desktop scheduled task |
| “Run background Codex coding jobs” | Codex app / Codex cloud |
| “Respond to `@claude` on PRs/issues” | Claude Code GitHub Action |
| “Respond to `@codex` / run Codex cloud tasks” | Codex GitHub/cloud |
| “Route between Qwen, Claude, Codex, OpenRouter, GitHub, Sentry, CRM, Gmail, Calendar” | Your own lightweight orchestrator / Hermes |
| “Persistent founder/business assistant with memory and recurring briefs” | Hermes or a custom ops agent |

For pure coding, I would **not** build a giant Hermes-based system first. I would use Claude/Codex built-ins, then add Hermes or a small control plane where the built-ins are too dumb or too expensive.

## 4. What I would keep in GitHub Actions

Keep these in GitHub Actions:

```txt
- main health
- PR checks
- nightly E2E
- staging QA test commands
- build/lint/typecheck/test
- artifact capture
- PR comment triggers
- GitHub bot entrypoint
```

For Claude Code in GitHub Actions, Anthropic’s docs support GitHub Actions with repository write permissions for Contents, Issues, and Pull Requests. Direct Claude API usage requires `ANTHROPIC_API_KEY`; the Claude Code Action also documents `CLAUDE_CODE_OAUTH_TOKEN` for Pro/Max users generated with `claude setup-token`. citeturn657004view0 citeturn657004view1

Important: if Claude Code sees `ANTHROPIC_API_KEY` locally, it uses API billing rather than your Pro/Max subscription. Anthropic explicitly warns about that. citeturn511137view5

For your public repo, **do not attach your PC as a self-hosted runner** unless you fully isolate it. GitHub recommends using self-hosted runners only with private repos because forks of public repos can run dangerous code on the runner via PR workflows. citeturn251534search2

## 5. Should nightly QA use Qwen, Claude, Codex, or GitHub?

Use this split:

```txt
GitHub Actions:
  run the actual deterministic QA/test jobs

Claude/Codex:
  investigate failures and produce patches

Qwen:
  summarize failures, classify severity, decide whether to escalate

Hermes/orchestrator:
  schedule, route, log, and notify
```

For your GStack `/qa` thing specifically: **use Claude Code**, because GStack is designed around Claude Code-style skills and browser/code repair loops. Qwen can triage the output afterward, but I would not trust Qwen to drive a full browser QA/fix cycle on production or staging.

Since GitHub Actions is free for your public repo, the cheapest good v1 is:

```txt
1. GitHub Actions runs nightly QA.
2. If green: Qwen summarizes.
3. If red/simple: Qwen attempts a patch in a branch.
4. If Qwen fails once, or touches sensitive areas: Claude/Codex takes over.
5. Bot opens PR.
6. Existing review bots review.
7. PR remediation bot handles review comments.
```

## 6. API usage versus subscriptions

Your current subscriptions are probably still the best value for heavy interactive coding.

Claude Max is $100/month for 5x Pro or $200/month for 20x Pro, and Claude Code is included with the same subscription across Claude web/desktop/mobile and terminal. citeturn511137view6 citeturn511137view5

API usage gives you more automation flexibility, but it can get expensive fast. Anthropic’s current API pricing lists Claude Sonnet 4.6 at `$3 / MTok` input and `$15 / MTok` output, Haiku 4.5 at `$1 / MTok` input and `$5 / MTok` output, and Opus 4.7 at `$5 / MTok` input and `$25 / MTok` output. Batch processing is half price. citeturn712822view0

OpenAI API pricing currently lists GPT-5.4 at `$2.50 / 1M` input and `$15 / 1M` output, GPT-5.4 mini at `$0.75 / 1M` input and `$4.50 / 1M` output, and GPT-5.4 nano at `$0.20 / 1M` input and `$1.25 / 1M` output. Batch API saves 50%. citeturn441243view1

Codex subscription usage is now tied to token-based credit rates for Plus/Pro/Business/Enterprise, and OpenAI says Codex averages around `$100–$200/developer/month` with large variance depending on models, number of instances, automations, and fast mode. citeturn930325view4 Codex can also authenticate either through ChatGPT subscription access or an API key; API-key usage bills through the OpenAI Platform account. citeturn930325view0

My recommendation:

```txt
Keep:
- Claude Max $200
- main Codex / ChatGPT Pro $200

Question:
- extra low-tier Codex seats

Add:
- OpenRouter or direct API account with hard monthly cap, maybe $50–$150

Avoid:
- letting every automation hit Claude Sonnet/Opus or GPT-5.4 by default
```

## 7. Is OpenRouter cheaper?

For cheap routing and non-critical agents, yes.

OpenRouter says it has pay-as-you-go with no minimum spend, budget/spend controls, fallback routing, provider selection, and no billing for failed fallback attempts. citeturn945937view4 It also supports sorting/fallbacks by price, throughput, or latency. citeturn945937view5

The interesting model for you is **Qwen3-Coder-Next** hosted through OpenRouter. OpenRouter lists it at `$0.15 / 1M` input tokens and `$0.80 / 1M` output tokens, with 262K context, and describes it as optimized for coding agents/local dev workflows. citeturn945937view3

That is dramatically cheaper than Claude Sonnet/GPT-5.4 for triage-like workloads.

But OpenRouter’s routing is mostly provider/model routing. It does not inherently know that “this patch touches auth, escalate to Claude.” You need your own **policy router**:

```txt
if task is classification/summarization:
  local_qwen or openrouter_qwen

if task is simple lint/type/test:
  local_qwen first, one attempt

if task touches auth/payments/db/security:
  claude_code or codex immediately

if task blocks main/prod:
  claude_code or codex immediately

if same failure repeats twice:
  escalate

if diff > 300 lines or > 3 files:
  escalate
```

## 8. Investor/founder ops: local/open models are more useful here

For the investor/fundraise/customer stuff, Qwen and cheaper models are much more valuable than for coding.

Use cheap/local models for:

```txt
- extracting names/emails/firms from Gmail/calendar
- deduping contacts
- scoring investors against your rubric
- classifying replies
- updating CRM rows
- summarizing meetings
- drafting first-pass emails
- generating daily founder brief sections
- anomaly detection on metrics
```

Use Claude/GPT/Codex-class models for:

```txt
- final investor email polish
- top 20 investor personalization
- fundraising strategy
- interpreting messy company metrics
- deciding top 3 actions for the day
- customer segmentation insights
```

This is where Hermes/Honcho can be useful. Hermes has persistent memory, skills, cron-style scheduled tasks, and multiple execution backends. Honcho adds deeper cross-session memory/user modeling. citeturn416272search0 citeturn416272search1

I would use Hermes for the **founder brief and fundraise CRM** before using it for serious coding.

## 9. What to do with each machine

### M5 MacBook Pro, 32 GB RAM

This is your main production machine.

Use it for:

```txt
- Conductor
- Claude Code
- Codex
- main feature work
- heavy frontend work
- local dev servers
- supervised parallel coding
```

I would reduce the 10-agent habit slightly. Ten agents sounds productive, but it increases merge/review/coordination overhead. Better default:

```txt
4–6 serious agents
1 design/dev server lane
1 review/debug lane
```

Use 10 only for highly separable tasks like:

```txt
- copy changes
- test additions
- isolated UI variants
- issue triage
- docs
- small bug swarm
```

### M2 MacBook Air, 16 GB RAM

Keep doing what you are doing.

Use it for:

```txt
- design review
- one dev server
- browser testing
- Figma/design/content work
- light Claude/Codex tasks
- monitoring dashboards
```

Do not make it a serious agent worker. It will thrash under multiple dev servers, browsers, and coding agents.

### 2018 PC, 64 GB RAM, 2080 Ti

Use it as the always-on ops box.

Best role:

```txt
- WSL2 Ubuntu
- local Qwen/Ollama/LM Studio server
- Hermes
- queue worker
- GitHub webhook poller/worker
- SQLite/Postgres state DB
- repo mirror/cache
- artifact/log storage
- investor/founder brief jobs
```

Avoid:

```txt
- self-hosted GitHub runner for public PR code
- production secrets on the box
- exposing inbound webhooks directly to the internet
- running many parallel local LLM jobs
```

Start with **one local model job at a time**. The GPU is the bottleneck.

## 10. Is your internet a bottleneck?

For cloud agents and GitHub Actions: **mostly no**.

For your local PC acting as an always-on worker: **somewhat yes**, mostly reliability/latency rather than raw bandwidth.

Your T-Mobile 5G setup is fine for:

```txt
- polling GitHub/Sentry
- pushing branches
- reading APIs
- calling OpenRouter/OpenAI/Anthropic
- running local Qwen
- daily briefs
- investor CRM enrichment
```

It may be annoying for:

```txt
- large dependency installs
- large artifact upload/download
- Playwright traces/videos
- Docker image pulls
- flaky long-running remote sessions
- hosting inbound webhooks
```

Do this:

```txt
- Put webhook receiver on a cheap VPS or Cloudflare Worker.
- Have your PC poll a queue outbound.
- Cache pnpm/npm/playwright/docker aggressively.
- Keep repo mirrors local.
- Do not depend on inbound access to the home network.
```

Local model inference is GPU/CPU bound, so internet does not matter there.

## 11. Best near-term architecture

Do **not** rebuild everything around Hermes immediately.

Build this:

```txt
GitHub Actions:
  deterministic CI/QA/test execution

Existing Jovie GitHub bot:
  PR comments, labels, task triggers

Claude/Codex:
  high-quality code patches

Qwen local/OpenRouter:
  triage, classify, summarize, simple first-pass patches

Hermes:
  founder brief, fundraise CRM, scheduled ops, memory
```

The coding path should be:

```txt
GitHub event or scheduled run
        |
        v
Jovie bot / lightweight router
        |
        v
Qwen classifies:
  easy / hard / risky / ignore
        |
        +--> easy: Qwen attempts one patch in branch
        |
        +--> hard/risky: Claude Code or Codex
        |
        v
GitHub PR / push to branch
        |
        v
CodeRabbit / Greptile / CI
        |
        v
router decides whether to loop, escalate, or stop
```

## 12. What I would change from your current workflow

Keep:

```txt
- MacBook Pro as main Conductor machine
- MacBook Air as design/preview machine
- GitHub Actions for CI/QA
- Claude Max + main Codex plan
- existing Jovie GitHub bot
```

Change:

```txt
- Stop thinking of the PC as a replacement coder.
- Make the PC the always-on orchestrator/triage/founder-ops box.
- Use Qwen only where failure is cheap.
- Use Claude/Codex where bad patches are expensive.
- Add OpenRouter with hard budget caps for cheap hosted Qwen/mini-model work.
- Use Claude/Codex built-in scheduled tasks before writing custom coding automation.
```

Question or potentially drop:

```txt
- extra low-tier Codex plans, unless they are attached to separate people/workspaces that actually use them
- local autonomous coding beyond simple fixes
- self-hosted runner on public repo
```

## 13. Best first experiment

Run a benchmark on your own repo before committing.

Take:

```txt
- 20 recent CodeRabbit/Greptile comments
- 10 recent CI failures
- 10 simple bugs you already fixed
- 5 merge conflicts
```

Have three agents attempt them in isolated worktrees:

```txt
A. local Qwen
B. OpenRouter Qwen3-Coder-Next
C. Claude Code or Codex
```

Score:

```txt
- solved correctly
- time to solve
- files touched
- tests passed
- human cleanup needed
- model cost
```

Expected result:

```txt
Qwen local:
  cheapest, slowest, okay for simple mechanical fixes

OpenRouter Qwen:
  cheap, faster, good triage and some simple fixes

Claude/Codex:
  best for real coding, most worth using when task complexity is nontrivial
```

## Bottom line

For coding automation, **yes, it is worth using local/Hermes/Qwen, but only as the dispatcher and cheap first-pass layer**. Your real productivity still comes from Claude/Codex plus GitHub Actions.

For investor ops, founder briefs, CRM, Gmail/calendar mining, and daily company intelligence, **Hermes/local/open models are much more obviously worth it**. That work is repetitive, text-heavy, cheap to verify, and less dependent on perfect code reasoning.

Your optimal setup is:

```txt
MacBook Pro:
  human-supervised high-value coding

MacBook Air:
  design/preview/secondary work

PC:
  always-on local model + Hermes + Jovie ops worker

GitHub Actions:
  free public-repo CI/QA compute

Claude/Codex:
  high-skill coding agents

OpenRouter:
  cheap hosted Qwen/mini-model overflow with strict budget caps
```


Is there existing software or skills for fundraising that are great? Or better to build myself.

Best CRM? Could be an air table could be a spreadsheet could be notion or obsidian or something like that or I could just live in the ops repo.

Give me the highest leverage things to setup with your recommend split as bullet points in a single list



Mr. White, use **existing tools for CRM/outbound/enrichment**, and build the **agent workflow glue yourself**.

My recommendation: **Airtable as the fundraising CRM source of truth**, **ops repo for automation code/prompts/skills**, **Clay for enrichment later**, **Instantly/Gmail for outbound**, and **Claude/Qwen/OpenRouter for agent work**. Airtable is the best balance of speed, API access, human-editable views, relational data, and low ceremony; Airtable even has a free fundraising CRM template, and its newer AI app builder can generate app structure from natural language. citeturn434671search12turn434671search0

- **Set up Airtable as the investor CRM, not Notion/Obsidian/spreadsheet.** Use tables for `Investors`, `Firms`, `Relationships`, `Touches`, `Meetings`, `Intros`, `Updates`, and `Tasks`. Airtable gives you the human UI, filters, Kanban stages, forms, and API; your ops repo gives you versioned automation code. Spreadsheet is too brittle, Notion is fine for docs but weaker as an automation-heavy CRM, Obsidian is for personal notes, and living only in the ops repo gives you bad visibility.

- **Use the ops repo as the fundraise automation brain.** Store schemas, prompts, scoring rubrics, scripts, skills, Airtable sync code, Gmail/Calendar importers, investor enrichment jobs, and daily report generation there. Do not make the ops repo the primary CRM UI.

- **Add Foundersuite only if you want a purpose-built fundraising product immediately.** Foundersuite is built specifically around investor CRM, investor database, pipeline management, outreach, updates, and investor relations. It is the most “just use a fundraising tool” option. citeturn211722search1turn211722search20 My read: useful if you want less DIY; less ideal if you want agents/custom workflows tightly integrated with your codebase, Gmail, Calendar, metrics, and Jovie ops.

- **Use Visible if investor updates/data room become the center of gravity.** Visible is strong for investor updates, pitch deck/data room sharing, and monitoring a fundraise process. citeturn211722search2turn211722search10 I would use it for polished investor updates, not as the main automation CRM unless you like its workflow better than Airtable.

- **Use Attio if you want one modern CRM for fundraising + customers + partnerships.** Attio is a flexible CRM with custom objects, workflows, deals, reports, and email/calendar sync; its help docs say email/calendar sync imports past and future emails/events and keeps new ones synced. citeturn434671search1turn434671search5 Attio is probably the best “real CRM” choice if you expect this to become a sales/customer CRM too. Airtable is faster and more hackable for v1.

- **Do not use Affinity unless relationship intelligence is worth enterprise-style complexity/cost.** Affinity is excellent for relationship intelligence, intro paths, automated activity capture, and private-capital workflows. citeturn211722search3turn211722search7 It is aimed more at VC/private capital teams than a solo founder running a scrappy raise.

- **Use Clay as the enrichment/research layer, not the CRM.** Clay is strong for enrichment, waterfalling providers, AI web research, and building prospect lists; its current pricing page lists a free tier with actions/data credits and Claygent research. citeturn434671search2 Add it after your CRM schema is stable, otherwise you’ll generate lots of semi-useful investor rows with nowhere clean to put them.

- **Use Instantly/Gmail as outbound pipes, not the source of truth.** CRM owns status, score, wave, notes, and next action. Gmail/Instantly send and receive. Airtable stores the canonical investor state.

- **Install existing fundraising skills, but treat them as prompt libraries, not trusted software.** Good candidates include `startup-founder-skills`, `open-ceo`, investor outreach skills, and VC fundraising Claude skills. They cover things like investor targeting, outreach, pitch decks, term sheets, and fundraising pipeline management. citeturn896159search0turn896159search1turn896159search3turn896159search7 Use them to bootstrap instructions, email templates, scoring, and analysis. Build your own actual workflow because your CRM schema, Jovie positioning, investor waves, Gmail history, and fundraising process are company-specific.

- **Create a hard investor scoring rubric in Airtable.** Fields: `stage_fit`, `sector_fit`, `music_fit`, `AI_fit`, `consumer_fit`, `check_size_estimate`, `recent_activity`, `warm_intro_strength`, `relationship_strength`, `geo_relevance`, `portfolio_conflict`, `evidence_url`, `confidence`, `priority_score`. The agent should never add a high score without evidence.

- **Create fundraising pipeline stages now.** Use: `Backlog`, `Researching`, `Need intro`, `Ready to contact`, `Contacted`, `Replied`, `Meeting scheduled`, `Met`, `Follow-up sent`, `Diligence`, `Soft commit`, `Committed`, `Passed`, `Bad fit`, `Do not contact`.

- **Make every investor row evidence-based.** Add `source`, `source_url`, `evidence_text`, `last_verified_at`, and `verified_by`. This prevents the agent from hallucinating investors, fake check sizes, or fake sector fit.

- **Start with your warm network before web-scale scraping.** Highest leverage import order: Gmail contacts, Calendar history, LinkedIn/manual export if available, previous investor meetings, founder friends, music industry contacts, angels from prior company, then external investor lists. Warm-path discovery beats cold angel scraping.

- **Build a Gmail/Calendar relationship miner.** Local/OpenRouter Qwen can classify people as `investor`, `founder`, `operator`, `music industry`, `potential intro`, `customer`, or `ignore`; Claude can handle ambiguous high-value contacts. Attio does this natively better than Airtable, but your own importer gives more control.

- **Build an Airtable sync worker.** Jobs: dedupe investors, normalize names/firms/emails, update statuses from Gmail replies, attach meeting notes from Calendar, create follow-up tasks, and flag stale opportunities.

- **Use Qwen/OpenRouter for cheap CRM maintenance.** Investor dedupe, enrichment summaries, reply classification, score calculation, email-thread summarization, and CRM hygiene are exactly where cheap models make sense. Use Claude for top-tier personalization, strategy, and final outbound copy.

- **Set up one “daily fundraise brief.”** Every morning: new investors found, top 10 to contact, meetings today/tomorrow, stale follow-ups, replies needing response, warm intro opportunities, commitments, passes, and the highest-leverage action for the raise.

- **Set up one “fundraise command center” Airtable interface.** Views: `Today`, `Hot`, `Needs follow-up`, `Warm intro needed`, `Meeting scheduled`, `Committed`, `Passed`, `All angels`, `All funds`, `Music/creator/AI fit`.

- **Create three outreach waves.** `Wave 1`: warm/high-fit angels. `Wave 2`: warm-ish funds/operators/strategics. `Wave 3`: colder but high-fit investors. Do not let the agent blast everyone at once; preserve sequencing and signal.

- **Draft emails automatically, approve manually at first.** Use agent-drafted Gmail drafts with fields merged from Airtable: name, firm, why them, Jovie one-liner, traction, ask, calendar link. After 50–100 manually reviewed sends, you can loosen approval for low-risk follow-ups.

- **Use Claude for the master fundraising narrative.** Have Claude create the canonical positioning memo: one-liner, why now, market, traction, wedge, moat, fundraising ask, investor FAQ, objections, music-tech/AI framing. Save it in the ops repo and feed it into all outreach skills.

- **Use Airtable attachments or Visible for investor materials.** Store canonical links to deck, memo, demo, metrics snapshot, data room, calendar, and investor update. Visible is better if you care about polished investor updates and engagement tracking; Airtable is better for agent workflow control. citeturn211722search2turn211722search10

- **Do not overbuild the autonomous investor researcher first.** The highest ROI v1 is warm-network extraction + scoring + follow-up discipline. Web-scale angel discovery is v2 after the CRM and workflow are clean.

- **Build one custom fundraising skill for Jovie.** Include: company facts, forbidden claims, fundraising stage, target investor types, scoring rubric, outreach style, follow-up cadence, CRM schema, and escalation rules. Existing skills give generic fundraising workflows; your custom skill makes the agent accurate.

- **Keep Notion/Obsidian optional for narrative docs only.** Use them for pitch notes, investor FAQ, strategic thinking, and meeting prep if you like them. Keep structured pipeline data in Airtable/Attio.

- **Best default stack:** `Airtable CRM + ops repo automations + Gmail/Calendar import + Qwen/OpenRouter for classification + Claude for strategy/copy + Clay later for enrichment + Instantly only when outbound volume justifies it`.

- **Best “I want less DIY” stack:** `Foundersuite + Gmail + Claude + light ops repo scripts`. Foundersuite is purpose-built for fundraising CRM and investor relations, so it can replace much of the Airtable schema work. citeturn211722search1turn211722search20

- **Best “this becomes sales CRM too” stack:** `Attio + Gmail/Calendar sync + Claude + Clay + ops repo`. Attio is the better long-term CRM if investor, customer, partnership, and recruiting pipelines should all live in one relationship database. citeturn434671search1turn434671search5

- **My final recommendation:** start with **Airtable**, because it is fast, visible, automatable, cheap enough, and easy for agents to update. Build the agent glue yourself. Re-evaluate Attio once the fundraise/customer pipeline gets bigger, and use Foundersuite only if you want a purpose-built fundraising app more than a custom agentic operating system.


**Topic:** [[chatgpt-clusters/coding_ai]]


## See Also
- [[chatgpt/chatgpt_ai-agent-automation-part1]]
- [[chatgpt/chatgpt_ai-engineering-agent-prompt-part2]]
- [[chatgpt/chatgpt_aramis-agent-profile-management-part2]]
- [[chatgpt/chatgpt_hermes-agent-performance-comparison-part2]]
- [[chatgpt/chatgpt_1-of-body-weight-part2]]
