---
title: "AI Agent Automation"
type: essay
created: 2026-04-18
updated: 2026-04-18
source: chatgpt-export
conversation_id: 69e3bf6d-a260-83e8-80b4-2372f8b53c97
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# AI Agent Automation

> Conversation ID: 69e3bf6d-a260-83e8-80b4-2372f8b53c97
> Created: 2026-04-18T17:29:18Z
> Updated: 2026-04-18T18:15:08Z
> Messages: 6

---

## User

Yo, diggity dog. I just installed Aramie's agent on my PC, and the, I guess, most immediate thing I'd like to do with it, I'm running QN 3.5 or whatever, local model, and I guess, basically, here's the deal, is like, I have $200 a month subscriptions to Codex and to Claude, and I have a couple other paid accounts for various AI tools, $20, $40 a month. So we're spending a decent amount of money on AI shit. What I'm looking for right now is the ability for me to, I basically want to take, you know, I wanna take this startup, right? What am I trying to say? Okay, so I'm currently coding in Gstack, and I guess the first immediate, you know, using Gstack with, dude, go. Oh my God. Or drive. I'm currently using Gstack. conductor to orchestrate a bunch of coding agents in parallel with org trees. And so, I guess what I'm looking to do with Air Musician is basically run a couple things. So one is I'd like to run an agent that, and this is why I'm doing it, kind of like trying to do a model that's cheap, I would like to do basically have an agent that just goes through and perpetually monitors open PRs and then does remediation on them. So it'll check when there's an open PR and like, you know, something that like runs on a cron, like pretty frequently, or is like triggered by a web hook from an open PR or something, and basically handles any conflicts on the PR, handles any comments from code review things like CodeRabbit or GReptile, or Sentry, addresses all the code review comments from the different agents, pushes back to the branch, updates the branch, and then, you know, enables merge and ready on it, and then follows it to make sure our merge is right. That'd be one thing I wanna do. A second automation would be... to take like the webhook, because we have a thing that, we have a CI job that basically detects, it's like main health, and it tells us if main is red, like suddenly it's not going to deploy anymore, because maybe something made it past the like, the PR tests and then didn't make it past the like wider E2E tests and stuff, and therefore got, did not get promoted to production. I want one job that just kind of perpetually monitors that, and then as soon as something fails, goes in and attempts to fix it. Now, in an ideal world, it's doing that in a way that, it's doing that in a way that it's quality, right? So like, I don't know how good the Quinn model is, but if it's not the best in the world, then for like more sensitive jobs and stuff, I would want it to like defer to Claude, which like, it could just open up Claude code, which we have, and it could just run Claude code, that'd be fine. But, you know, but it shouldn't make a decision, like, oh, this is a more complex thing. I'm going to use Claude code and burn a little bit of our usage versus, oh, this is a relatively easy thing. I'm going to just fix it myself. And so I want it to do that. I want all work to be done in work trees. And then, I also want, like, I also want, like, the whole thing to be, um... Um... I also want, like, the whole thing to be, um... Okay, and then the next thing I wanted to do is I want it to run every night. Um, I would like it to go and run the GStack slash QA skill exhaustively on our whole, um, on our whole app, um, so that every night it's just running the QA skill which automatically finds and fixes issues. Um, and it's just running that so that we kind of have this, like, blanket ability for, um, you know, for proactive, like, stabilizing of the app, right? Um, so I wanna do that. And then, um, and then beyond that, I want, like, the whole, um, uh, and then, and then, like, three or four times and run that on production. Overnight. And then on like the staging server, I want to run it like three or four times a day, right? And whenever it fixes everything, I want it to then open up a PR automatically. And then that PR will get hit with all of our code reviews and stuff, and then the other agent we previously set up should be then remediating that, right? And so those are like the main ones I want running, which would dramatically speed up our time to ship things, which is helpful because I'm only one person right now. And then the core other things I'm thinking about using it for are like mostly a daily founder brief in every morning, which basically automatically looks at the company and pulls in as much information as it can. So like literally looking at our bank account, looking at our user count, our user numbers. It could maybe even pull in like read-only info from our database and like literally analyze our database and attempt to make like learnings or interesting insights from our database of like, oh, there was a spike in users, or oh, users are signing up, but they're not taking any actions, or like noticing shifts and stuff in our users and stuff. That would tell us like, oh, maybe there's a problem or something we're not picking up on, stuff like that. Also pulling in everything that we've shipped, and then also pulling in like our fundraising status and stuff, and kind of like being like, here's the number one, two, and three most important things you could do today for the company. Knowing and then guiding it always by like MRR, right? So like what's the thing that's going to get us to the most MRR that we should do today? You know, oh shit, there's a P0 issue in Sentry, we'll tackle that first, right? Oh, there's, you know, you're going to run out of money in three days, oh well, you know, get on the phone with an angel, or you know, whatever it is, right? And then the next one that I'd be interested in is... managing our fundraise, so keeping a spreadsheet somewhere or a database somewhere of our fundraise, like maybe we even just spin up a lightweight CRM or something, you know, or we manage it through our existing app, or we do it on a spreadsheet or like a Notion or something, whatever it is. But... basically what I would wanted to do is go out repeatedly and I’d probably run this on like a crown or something that would be very frequent like every five minutes or 10 minutes or something go out and start searching for angels Angel investors and we should like pull skills or something if there’s fundraising skills out there and stuff, but it should like you know start building basically database of Angel investors and then enriching that with whatever data I can find you know and then just building this data database of angels and then put everything through a scoring rubric where it’s basically like you know if you can determine that they deploy a lot of capital or you know like put in all the different data points like how much capital have they raised how much have they deployed? You know if they’ve got if they’ve raised a lot only deployed a little they’ve probably gotta get rid of a lot right like you know what I mean all that kind of stuff do they invest in music tech do they invest at the Angel stage? Do they invested the precede stage like all this kind of shit you know what’s their check size and then do we have an existing relationship or not and then kind of like rank all of it all of these people by emails you know ranked them by like importance and then go through my email and plot all of my contacts and then put them in the database and see if we can find out if any of them are angels or investors or whatever and then go through and pull all of my Google calendar to see Angel or investors that I’ve previously had meetings with for my old company years ago or anyone that I like know from the music industry and then you know, put all these people together, and then put them into a giant spreadsheet and then basically populate that with as much information as I can and then separate them in the waves and then email and then draft emails to all of these investors and and send them you know a link to my calendar and the pitch and like a link to investor site and you know, basically try and manage the raise and then continue to check on the emails and the calendar and stuff and update this. Keep the spreadsheet updated to see who we’ve met with and whatever and then basically turn this on so that I can say like OK we’re gonna run this. You know every five minutes for the next three or four days or something and then we’re gonna try and book out you know the last week of the second week of May or something we’re gonna book out every single day with an investor goal you know and like that’s basically what I wanna do and so that’s what I’m attempting to do and then and then you know potentially do a similar thing for like customers and start building a giant database of customers that way, and then we also have like instantly.AI which we could you know funnel some of this into that etc. but basically those are the core things. I’m trying to automate right now and so I want what I basically want to know is like what what is the technical set up? I need to achieve all of these things right so like free each one of the individual work flows I can kind of figure out like what I need to do and stuff but like how do I set this up? Where does Emmy‘s agent live like doesn’t live in our normal repo for our site doesn’t live in our repo folder for our ops repo. Should I put it in a different folder is that is the Quinn 3.5 model locally good enough do I need to add honcho will that help? Is there anything else I should add? Do I have to pay for that? How should I think about splitting it up between Quinn and other models? Is there another local model I should be doing this is running on a 2018 custom belt PC with 64 GB of program and add 2080 TI graphics card you know so basically like I installed Hermes Agent today and just the Quinn 3.5 haven’t installed anything else and I’m just trying to figure out what’s the best way to use it also like what’s the best way to make it fast and performance and have it always on and then how do I think about like work trees and sub agents and like do I run one terminal should I run multiple terminals? I use conductor on my Mac, which lets you do individual work trees automatically with multiple workspaces multiple repose. Should I be thinking about it like that? Is this a thing that I should like run in conductor and let conductor manage the work trees and then just like launch it in there or do I just leave one terminal on and let let it kind of spin up agents itself. How do I think about like the workflow to kind of like do what I’ve described.

---

## Assistant

Mr. White, I’m treating “Aramie / Air Musician / Emmy’s agent” as **Nous Hermes Agent**, and “Quinn” as **Qwen / Qwen3-Coder**.

## The setup I’d build

Use **Hermes as an agent worker**, and build a small **Jovie agent control plane** around it. The control plane receives GitHub webhooks, CI health events, cron jobs, and business-data jobs; it creates deterministic tasks; Hermes, Claude Code, Codex, or local Qwen execute those tasks inside isolated git worktrees.

Hermes already has the pieces for this: terminal backends across local, Docker, SSH, Modal, Daytona, and Singularity; cron jobs that can run recurring tasks with attached skills; isolated subagents with their own terminal sessions; and a skills system stored under `~/.hermes/skills/`. citeturn853899view0turn853899view1turn127051view0turn853899view3

The shape should be:

```txt
GitHub / CI / Sentry / cron / bank / analytics / Gmail / Calendar
                 |
                 v
        jovie-agent-control-plane
        - webhook receiver
        - queue
        - state database
        - policy router
        - audit log
                 |
                 v
        jovie-agent-worker(s)
        - creates git worktree
        - chooses model/tool
        - runs tests
        - commits/pushes branch
        - comments on PR
        - cleans up worktree
```

## Where it should live

Put it in a **separate private ops repo**, not inside the normal app repo.

Recommended layout on the PC, ideally inside WSL2 Ubuntu:

```txt
~/jovie-agent/
  ops/                         # private repo: jovie-agent-ops
    orchestrator/              # webhook receiver, queue worker, job router
    prompts/                   # durable task prompts
    policies/                  # model-routing and safety rules
    skills/                    # custom Hermes/Claude/Codex skills
    scripts/                   # worktree, git, CI, GitHub helpers
  repos/
    jovie.git                  # bare/mirror clone of product repo
    ops.git
  worktrees/
    pr-123-remediate/
    main-red-2026-04-18/
    qa-staging-2026-04-18-0900/
  state/
    agent.sqlite               # tasks, attempts, comment IDs, decisions
  logs/
  artifacts/
    screenshots/
    traces/
    patches/
```

Keep the app repo clean. The app repo should only contain project instructions such as `AGENTS.md`, `CLAUDE.md`, `.gstack`, GitHub workflows, and maybe bot labels/config. Hermes memory and agent state belong outside the product repo.

## PC reality check: Qwen on a 2080 Ti

Your 2018 PC with 64 GB RAM and a 2080 Ti can be useful, but it should be treated as a **cheap triage and first-pass worker**, not the only brain for high-risk code changes.

Qwen3-Coder-30B-A3B-Instruct is designed for agentic coding, browser-use, repository-scale context, and has 30.5B total parameters with 3.3B active parameters and 262K native context according to the model card. citeturn853899view4 Your 2080 Ti likely has 11 GB VRAM, so larger Qwen variants will spill into system RAM or require aggressive quantization. That is acceptable for summaries, log analysis, simple fixes, and comment triage. It will feel slow or brittle for large multi-file refactors, auth, payments, migrations, flaky E2E debugging, and production incident work.

Use this routing:

| Task type | Default executor |
|---|---|
| Classify PR comments, summarize CI logs, decide whether a task is actionable | Local Qwen |
| Simple one-file or test-only fixes | Local Qwen first |
| Dependency bumps, lint fixes, formatting, obvious type errors | Local Qwen first |
| Merge conflicts | Local Qwen for easy conflicts, Claude/Codex for complex conflicts |
| Multi-file product logic | Claude Code or Codex |
| Auth, payments, DB migrations, permissions, security-sensitive paths | Claude Code/Codex immediately |
| Main red / production-blocking issue | Claude Code/Codex immediately |
| GStack `/qa` browser pass | Claude Code with GStack |
| Second-opinion review before merge | Codex or Claude alternate model |

Claude Code and Codex are both available as terminal coding agents; Codex CLI runs locally in the selected directory and can read, modify, and run code, while Claude Code GitHub Actions can implement fixes from PR/issue context and follows project standards. citeturn293882view0turn293882view1 Claude plan usage is shared across Claude and Claude Code, so route expensive work deliberately. citeturn293882view2

## Use webhooks for PR remediation, cron for sweeps

For the PR remediation bot, use GitHub webhooks as the source of truth and a cron sweep as a backup.

GitHub exposes the events you need: `pull_request_review_comment` for diff comments, `pull_request_review` for submitted reviews, `pull_request_review_thread` for thread activity, `check_run` for check completion, and `workflow_run` for completed GitHub Actions workflows. citeturn631859view0turn631859view1turn631859view2turn631859view3 GitHub status checks determine whether a commit meets required branch conditions before merging. citeturn853899view7

The PR remediation loop should be:

```txt
1. Webhook arrives.
2. Store event with idempotency key:
   repo + PR + head_sha + comment_id/check_run_id + GitHub delivery ID.
3. Fetch PR state.
4. Classify:
   - merge conflict
   - failing check
   - CodeRabbit/Greptile comment
   - human review comment
   - Sentry issue comment
   - stale/non-actionable comment
5. Create/update worktree for PR head branch.
6. Run targeted reproduction:
   lint/test/typecheck/failing E2E command.
7. Route:
   Qwen for easy/safe tasks.
   Claude/Codex for high-risk or failed first attempts.
8. Commit fix to bot branch or same PR branch.
9. Push.
10. Reply with summary.
11. Ask CodeRabbit/Greptile to re-review where useful.
12. Mark task done only after checks pass or a terminal failure is recorded.
```

CodeRabbit posts automated reviews and supports PR commands such as pause/resume, full review, incremental review, and resolving comments, so your bot can interact with it through PR comments rather than scraping UI. citeturn100368view0turn100368view1

## GitHub App, not personal tokens

Create a **Jovie Agent GitHub App** with minimal permissions. Avoid using your personal GitHub token for this.

GitHub recommends minimum permissions for GitHub Apps and subscribing only to needed webhooks; it also recommends webhook secrets and secure private-key storage. citeturn364080view1 The app needs roughly:

```txt
Repository permissions:
  Contents: read/write
  Pull requests: read/write
  Issues: read/write
  Checks: read
  Actions: read
  Metadata: read

Webhooks:
  pull_request
  pull_request_review
  pull_request_review_comment
  pull_request_review_thread
  issue_comment
  check_run
  check_suite
  workflow_run
```

Add permissions only when the automation truly needs them. For example, it does not need admin access, secrets access, billing access, or repo settings access for v1.

## Worktrees: make them mandatory

Every coding task should run in a fresh worktree.

Use a deterministic branch naming scheme:

```txt
agent/pr-123/remediate-coderabbit-20260418-0912
agent/pr-123/fix-checks-20260418-0933
agent/main-red/fix-playwright-20260418-0210
agent/qa-staging/nightly-20260418-0300
```

Worktree lifecycle:

```bash
git fetch origin
git worktree add ~/jovie-agent/worktrees/pr-123 origin/pr-branch
cd ~/jovie-agent/worktrees/pr-123
pnpm install --prefer-offline
pnpm test -- --changed
# agent edits
git diff
git status
git commit -m "fix: address review comments on PR #123"
git push origin HEAD:pr-branch
```

Hard rule: no autonomous direct commits to `main`. Everything becomes a PR or a push to an already-open PR branch.

## Main-health fixer

For the “main went red” workflow, the bot should not randomly poke the repo. It should bisect from known state.

Flow:

```txt
Trigger:
  - workflow_run completed and conclusion != success
  - check_run completed and conclusion != success
  - external main-health webhook
  - fallback cron every 5–10 minutes

Steps:
  1. Confirm main is still red.
  2. Identify last green SHA and first red SHA.
  3. Pull logs/artifacts.
  4. Create worktree from main.
  5. Reproduce failing command locally.
  6. Route to Claude/Codex for anything non-trivial.
  7. Open PR: "Fix main health failure after <sha>".
  8. Link failing run, reproduction, fix summary.
  9. Let PR review bots run.
```

For production-impacting failures, add an escalation branch:

```txt
P0 deploy blocked:
  - create fix PR
  - notify you
  - suggest revert if culprit is obvious
  - never silently force-push/revert main
```

## Nightly and staging QA

GStack is Claude Code-oriented. Its README describes `/qa` as opening a real browser, clicking through flows, finding/fixing bugs, and generating regression tests; it also lists GStack as Claude Code skills and includes `/qa`, `/review`, `/ship`, `/codex`, `/careful`, `/guard`, and other workflow commands. citeturn483423view0

Use Claude Code + GStack for QA sweeps. Have Hermes schedule or trigger it, but let Claude/GStack do the browser QA work.

Recommended schedule:

```txt
Production:
  nightly only
  read-only flows
  test accounts only
  no destructive actions
  screenshot/video artifacts
  fixes opened as PRs

Staging:
  3–4x/day
  full write flows
  seeded test data
  destructive flows allowed against test fixtures
  fixes opened as PRs
```

The job should produce:

```txt
- QA run summary
- bugs found
- screenshots/traces
- commits made
- tests added
- PR link
- unresolved issues requiring human decision
```

Hermes cron can run scheduled tasks, attach skills, deliver results to files or configured platforms, and each due job runs in a fresh agent session. citeturn853899view1

## Conductor vs Hermes

Use **Conductor for supervised parallel coding on your Mac**. Use **Hermes/control-plane workers for unattended automation**.

Conductor’s docs describe it as a Mac app for running parallel Codex + Claude Code agents in isolated workspaces, reviewing work, and merging changes. citeturn853899view9 That is great for “I’m actively watching ten agents build features.” Your PR remediator, main-health fixer, nightly QA, and founder brief need service-like behavior: webhooks, durable state, retries, logs, idempotency, and cost routing.

Use Conductor when you are driving. Use the agent control plane when the company is on autopilot.

## One terminal or many terminals?

Run services, not terminals.

Recommended local services:

```txt
1. model-server
   Ollama / LM Studio / llama.cpp OpenAI-compatible endpoint

2. jovie-agent-webhook
   public webhook receiver, preferably on a cheap VPS

3. jovie-agent-worker
   pulls jobs, creates worktrees, runs agents

4. hermes-gateway or hermes-cron
   only for Hermes-native scheduled tasks / messaging

5. log collector
   writes logs/artifacts to disk/S3/R2
```

Use one interactive terminal only for debugging. The actual workers should run under `systemd` in WSL/Linux, Docker Compose, or a proper Windows service wrapper. On the PC, disable sleep, make the worker restart on failure, and keep model server warm so it does not reload the model on every job.

Hermes subagents are useful inside a single job, but keep their concurrency bounded. Hermes currently supports isolated child agents and up to three concurrent subagents in batch mode; it can also configure a different provider/model for subagents. citeturn127051view0turn127051view1

## Security posture

Use Docker or SSH-backed sandboxing for risky code execution. Hermes supports Docker and other terminal backends, so route code execution through an isolated backend rather than giving every task full access to your Windows machine. citeturn853899view0

For GitHub Actions self-hosted runners, be careful. GitHub says self-hosted runners lack the clean ephemeral isolation of GitHub-hosted runners and can be persistently compromised by untrusted code; GitHub recommends ephemeral/JIT runners for autoscaling and cautions against self-hosted runners on public repos. citeturn364080view0turn364080view2

Guardrails I’d enforce:

```txt
- no direct writes to main
- no production DB write credentials in agent env
- no bank write credentials
- no cloud admin credentials
- no secrets pasted into prompts
- scrub CI logs before sending to external models
- cap patch size per task
- cap cost per task/day
- require human approval for migrations, auth, billing, permissions, infra
- keep full audit logs of prompt, model, diff, commands, test result
```

## Founder brief automation

This should be a separate workflow from the coding agents.

Inputs:

```txt
- bank / runway
- revenue / MRR
- Stripe or payment processor
- product analytics
- database read replica or read-only SQL views
- GitHub shipped work
- Sentry/P0/P1 issues
- email/calendar fundraising state
- CRM/fundraise spreadsheet
```

Do not let the LLM roam the production DB. Create read-only views:

```sql
daily_signups
activation_funnel
trial_to_paid
mrr_by_day
churn_events
top_errors
new_users_without_activation
```

Then the agent gets controlled queries and produces:

```txt
1. Company health
2. Overnight changes
3. User/revenue anomalies
4. Shipping velocity
5. Fundraise status
6. Biggest risk
7. Top 3 actions today, ranked by expected MRR impact
```

Use local Qwen for the first summary pass. Use Claude/Codex only when you want strategic synthesis or anomaly investigation.

Honcho can help here later. Hermes docs describe Honcho as a memory provider that adds cross-session user modeling, session summaries, semantic search, and persistent conclusions. citeturn853899view8 It helps the agent remember your preferences and company context. It does not replace a real CRM, queue, database, or audit log.

## Fundraising CRM automation

Make the CRM the source of truth. The agent should enrich and draft, then you approve.

Schema:

```txt
investors
  id
  name
  firm
  role
  email
  linkedin_url
  website
  location
  stage_fit
  sector_fit
  check_size_estimate
  music_tech_relevance
  relationship_strength
  source
  evidence_url
  priority_score
  wave
  status
  last_touch_at
  next_action_at
  notes

relationships
  investor_id
  person_you_know
  source: gmail/calendar/manual
  strength
  evidence

touches
  investor_id
  channel
  subject
  body
  sent_at
  reply_at
  next_step
```

Scoring rubric:

```txt
+30 invests pre-seed/seed
+25 music / creator / consumer / AI / marketplace fit
+20 known relationship or warm intro path
+15 credible check size
+10 recent active investing
+10 LA/SF/NY network relevance
-25 no angel/pre-seed evidence
-20 strategic mismatch
-15 no contact path
```

Use Gmail and Calendar for relationship mining, but keep scopes tight. Gmail API restricted scopes provide wide access to Google user data and can require verification/security assessment for production apps that store or transmit restricted-scope data. citeturn543301search2turn543301search3 For outbound emails, keep automatic sending behind approval at first; FTC CAN-SPAM guidance requires accurate header information, non-deceptive subject lines, clear sender identity/location, and opt-out handling for commercial email. citeturn543301search0

Investor workflow:

```txt
1. Import known investors from Gmail + Calendar.
2. Import manual seed list.
3. Enrich each person.
4. Score.
5. Assign waves.
6. Draft personalized emails.
7. You approve first 50–100.
8. Send through Gmail/Instantly with suppression/opt-out tracking.
9. Watch replies.
10. Update CRM automatically.
11. Prepare daily fundraise brief.
```

I would not run broad investor discovery every five minutes. Run ingestion every few hours, and run reply/calendar monitoring every 5–10 minutes. The bottleneck is quality, deliverability, and follow-up accuracy.

## Concrete v1 build order

### Phase 1: PR remediator

Build this first because it has the fastest ROI and cleanest boundaries.

```txt
- GitHub App
- webhook receiver
- SQLite/Postgres task table
- local worker
- worktree manager
- comment/check classifier
- Qwen first-pass fixer
- Claude/Codex escalation
- push to PR branch
- final PR comment
```

Success metric:

```txt
50%+ of bot review comments fixed without you touching them.
0 direct main writes.
0 secret exposure.
```

### Phase 2: main-health fixer

Add CI log/artifact ingestion and last-green/first-red tracking.

Success metric:

```txt
main-red PR opened within 10 minutes of failure.
fix or revert recommendation attached.
```

### Phase 3: GStack QA sweeps

Run staging first. Add production only after the staging job is stable.

Success metric:

```txt
daily QA PRs with screenshots, regression tests, and reproducible bug reports.
```

### Phase 4: founder brief

Start read-only. Use controlled SQL views and APIs.

Success metric:

```txt
Every morning brief tells you cash, MRR, product health, shipped work, top risks, and top 3 actions.
```

### Phase 5: fundraise CRM

Start with your Gmail/Calendar/contact graph, then add discovery.

Success metric:

```txt
Ranked investor list, waves, drafts, follow-up reminders, meeting status, and reply tracking.
```

## The model policy I’d use

```yaml
default_model: local_qwen

routes:
  local_qwen:
    use_for:
      - classify_webhook
      - summarize_ci_logs
      - parse_review_comments
      - simple_lint_fix
      - simple_type_fix
      - docs_update
      - test_snapshot_update
    max_files_changed: 3
    max_attempts: 1

  claude_code:
    use_for:
      - gstack_qa
      - auth
      - payments
      - database_migrations
      - security
      - multi_file_product_logic
      - production_incident
      - failed_qwen_attempt
      - unclear_review_comment

  codex:
    use_for:
      - second_opinion_review
      - alternative_patch
      - claude_limit_reached
      - adversarial_review
      - large_refactor_review

escalate_when:
  - changed_files_estimate > 3
  - patch_size_estimate_lines > 300
  - touches_auth_or_billing_or_db: true
  - failing_e2e: true
  - production_blocked: true
  - qwen_attempt_failed: true
  - same_check_failed_twice: true
```

Hermes also supports model override for subagents in config, so cheap/faster models can be assigned to delegated subtasks. citeturn127051view1

## My recommended answer to your specific questions

**Where does Hermes live?**  
On the PC as a worker, under `~/jovie-agent`, with state outside the product repo. Use a separate private `jovie-agent-ops` repo.

**Does it live in the normal app repo?**  
No. The app repo gets only project instructions and workflow config. Agent state, logs, queues, prompts, and credentials live in the ops repo / worker environment.

**Is Qwen good enough?**  
Good enough for cheap triage, summaries, simple fixes, and first-pass remediation. Use Claude/Codex for anything high-risk, broad, ambiguous, or production-blocking.

**Do you need Honcho?**  
Later. It helps persistent memory and founder/context modeling. It does not solve orchestration, worktrees, GitHub events, or safe code execution.

**Should you use Conductor?**  
Use Conductor for supervised parallel dev on your Mac. Use a webhook/queue/worker setup for unattended automations.

**One terminal or many?**  
Run services. One worker process can create many worktrees over time. Use bounded concurrency; on your local GPU, start with one local model job at a time.

**What should be always-on?**  
A small VPS for public webhooks plus your PC as a private worker. The VPS stores events and queues jobs; the PC pulls jobs. This avoids exposing your PC directly to GitHub/Sentry/web traffic.

**What is the biggest design principle?**  
Deterministic control plane, agentic execution. Let normal code decide what job exists, what repo/branch/worktree to use, what permissions apply, and when to escalate. Let the agent do the patching, investigation, and summary.

---

## User

Okay, and then we have GitHub Actions already doing some of this stuff, and we have a Joby GitHub bot. Now GitHub Actions is gonna be... Currently, our repo on there is public, so our runs are free. So, you know, for something like the nightly QA run, if you're telling me that, you know, we should use Claude for that, then I don't know if it's saving us any money or just not just run it on GitHub for now until we make our repo private. But, or is it a thing that we could run with one? I guess that's my question, is like, is Quinn good enough for any of these, like, coding tasks or remediation tasks? Or do we need to have Claude code or codex using it? And if that is the point, then is there any benefit to me even doing this versus just using the cloud desktop app, which already has built-in cron jobs and stuff like that? I guess the main question is just like, cost. Although, if we can use the local model to do the orchestration, I guess it would more efficiently use our Claude Mac subscription, right? Because... It could theoretically be orchestrating tasks overnight that we normally wouldn't be using that time for. But then at the same time, I guess that logic could also apply to just using the Claude desktop app with automations on it. So I don't know. Basically, I wanna figure out if it's worth it to even be using for the coding-related tasks. And then, is it gonna be better or worse or the same on like managing the investor shit and whatnot? And like, should I use Claude or Codex or something to help with setting all these agents up to make them, you know, smarter or whatever? And then also, is there like, would it be cheaper for us to use like an open router thing or something? Or is there like auto model switching or something like that we can use that would be cheaper than us, you know, because right now we pay like, I have a Claude code max subscription, and then I have a Claude code pro subscription. And then I have the $200 a month codex and two $30 a month codex plans as well. And we usually burn through both the $200 plans and max and the other plans are like kind of not that useful for when we run out because the five-hour windows on them burn through so fast. but just wondering if like going API-based usage on any of these things or if there's any of the stuff would make it cheaper for us. I'd probably still keep those two subscriptions for like actual coding and building out features and stuff, but I don't know. I'm just trying to figure out like what's the most efficient way to set all this up. And then realistically, I have three machines right now. We have a 2022 MacBook Air with 16 gigabytes of RAM and an M2 chip. And then we have a 2026 M5, 32 gigabyte of RAM, MacBook Pro. And then we have the 2018 PC, which has a Samsung like Evo, one terabyte RAM chip, and then a M2 SSD, and then a second one of those as a storage drive, and then four SSDs in RAID, one terabyte, like normal SSDs in RAID for a four terabyte data drive, and then 64 gigabytes of RAM and a 2080 Ti. All of these, like what would be the thing? And then finally, the internet I'm currently using is like this shitty T-Mobile 5G internet. The desktop is hardwired in, and I have a Google Nest Pro mesh network. Is my internet a bottleneck for any of these things? And then what I'm usually doing is usually using both laptops at the same time and coding with like 10 agents or so on the MacBook Pro. And then I usually have like two agents running on the MacBook Air and I use like the synergy feature to control both at the same time with one mouse. And usually the Air... I'll have like, I'll be doing like design work on or something, so I'll run one dev server on it, because it starts to crap out once you run more than like one dev server. But we'd like run, we'd run like one dev server on that and then just use that kind of to do like design work and stuff so I can like see it updating and stuff. And then I'd use like the MacBook Pro to do like the heavy feature building and everything. Kind of like, look at the whole setup that I'm talking about and kind of decide like what makes sense to keep doing and what makes sense to change.

---

## Assistant

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

---

## User

Is there existing software or skills for fundraising that are great? Or better to build myself.

Best CRM? Could be an air table could be a spreadsheet could be notion or obsidian or something like that or I could just live in the ops repo.

Give me the highest leverage things to setup with your recommend split as bullet points in a single list


---

## Assistant

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
