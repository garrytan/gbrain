---
conversation_id: 69e3bf6d-a260-83e8-80b4-2372f8b53c97
created: 2026-04-18
links:
- '[[chatgpt-clusters/coding_ai_ml]]'
message_count: 6
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: AI Agent Automation
type: essay
updated: 2026-04-18
---

# AI Agent Automation

**Related:** [[coding_ai]]

> Conversation ID: 69e3bf6d-a260-83e8-80b4-2372f8b53c97
> Created: 2026-04-18T17:29:18Z
> Updated: 2026-04-18T18:15:08Z
> Messages: 6


Yo, diggity dog. I just installed Aramie's agent on my PC, and the, I guess, most immediate thing I'd like to do with it, I'm running QN 3.5 or whatever, local model, and I guess, basically, here's the deal, is like, I have $200 a month subscriptions to Codex and to Claude, and I have a couple other paid accounts for various AI tools, $20, $40 a month. So we're spending a decent amount of money on AI shit. What I'm looking for right now is the ability for me to, I basically want to take, you know, I wanna take this startup, right? What am I trying to say? Okay, so I'm currently coding in Gstack, and I guess the first immediate, you know, using Gstack with, dude, go. Oh my God. Or drive. I'm currently using Gstack. conductor to orchestrate a bunch of coding agents in parallel with org trees. And so, I guess what I'm looking to do with Air Musician is basically run a couple things. So one is I'd like to run an agent that, and this is why I'm doing it, kind of like trying to do a model that's cheap, I would like to do basically have an agent that just goes through and perpetually monitors open PRs and then does remediation on them. So it'll check when there's an open PR and like, you know, something that like runs on a cron, like pretty frequently, or is like triggered by a web hook from an open PR or something, and basically handles any conflicts on the PR, handles any comments from code review things like CodeRabbit or GReptile, or Sentry, addresses all the code review comments from the different agents, pushes back to the branch, updates the branch, and then, you know, enables merge and ready on it, and then follows it to make sure our merge is right. That'd be one thing I wanna do. A second automation would be... to take like the webhook, because we have a thing that, we have a CI job that basically detects, it's like main health, and it tells us if main is red, like suddenly it's not going to deploy anymore, because maybe something made it past the like, the PR tests and then didn't make it past the like wider E2E tests and stuff, and therefore got, did not get promoted to production. I want one job that just kind of perpetually monitors that, and then as soon as something fails, goes in and attempts to fix it. Now, in an ideal world, it's doing that in a way that, it's doing that in a way that it's quality, right? So like, I don't know how good the Quinn model is, but if it's not the best in the world, then for like more sensitive jobs and stuff, I would want it to like defer to Claude, which like, it could just open up Claude code, which we have, and it could just run Claude code, that'd be fine. But, you know, but it shouldn't make a decision, like, oh, this is a more complex thing. I'm going to use Claude code and burn a little bit of our usage versus, oh, this is a relatively easy thing. I'm going to just fix it myself. And so I want it to do that. I want all work to be done in work trees. And then, I also want, like, I also want, like, the whole thing to be, um... Um... I also want, like, the whole thing to be, um... Okay, and then the next thing I wanted to do is I want it to run every night. Um, I would like it to go and run the GStack slash QA skill exhaustively on our whole, um, on our whole app, um, so that every night it's just running the QA skill which automatically finds and fixes issues. Um, and it's just running that so that we kind of have this, like, blanket ability for, um, you know, for proactive, like, stabilizing of the app, right? Um, so I wanna do that. And then, um, and then beyond that, I want, like, the whole, um, uh, and then, and then, like, three or four times and run that on production. Overnight. And then on like the staging server, I want to run it like three or four times a day, right? And whenever it fixes everything, I want it to then open up a PR automatically. And then that PR will get hit with all of our code reviews and stuff, and then the other agent we previously set up should be then remediating that, right? And so those are like the main ones I want running, which would dramatically speed up our time to ship things, which is helpful because I'm only one person right now. And then the core other things I'm thinking about using it for are like mostly a daily founder brief in every morning, which basically automatically looks at the company and pulls in as much information as it can. So like literally looking at our bank account, looking at our user count, our user numbers. It could maybe even pull in like read-only info from our database and like literally analyze our database and attempt to make like learnings or interesting insights from our database of like, oh, there was a spike in users, or oh, users are signing up, but they're not taking any actions, or like noticing shifts and stuff in our users and stuff. That would tell us like, oh, maybe there's a problem or something we're not picking up on, stuff like that. Also pulling in everything that we've shipped, and then also pulling in like our fundraising status and stuff, and kind of like being like, here's the number one, two, and three most important things you could do today for the company. Knowing and then guiding it always by like MRR, right? So like what's the thing that's going to get us to the most MRR that we should do today? You know, oh shit, there's a P0 issue in Sentry, we'll tackle that first, right? Oh, there's, you know, you're going to run out of money in three days, oh well, you know, get on the phone with an angel, or you know, whatever it is, right? And then the next one that I'd be interested in is... managing our fundraise, so keeping a spreadsheet somewhere or a database somewhere of our fundraise, like maybe we even just spin up a lightweight CRM or something, you know, or we manage it through our existing app, or we do it on a spreadsheet or like a Notion or something, whatever it is. But... basically what I would wanted to do is go out repeatedly and I’d probably run this on like a crown or something that would be very frequent like every five minutes or 10 minutes or something go out and start searching for angels Angel investors and we should like pull skills or something if there’s fundraising skills out there and stuff, but it should like you know start building basically database of Angel investors and then enriching that with whatever data I can find you know and then just building this data database of angels and then put everything through a scoring rubric where it’s basically like you know if you can determine that they deploy a lot of capital or you know like put in all the different data points like how much capital have they raised how much have they deployed? You know if they’ve got if they’ve raised a lot only deployed a little they’ve probably gotta get rid of a lot right like you know what I mean all that kind of stuff do they invest in music tech do they invest at the Angel stage? Do they invested the precede stage like all this kind of shit you know what’s their check size and then do we have an existing relationship or not and then kind of like rank all of it all of these people by emails you know ranked them by like importance and then go through my email and plot all of my contacts and then put them in the database and see if we can find out if any of them are angels or investors or whatever and then go through and pull all of my Google calendar to see Angel or investors that I’ve previously had meetings with for my old company years ago or anyone that I like know from the music industry and then you know, put all these people together, and then put them into a giant spreadsheet and then basically populate that with as much information as I can and then separate them in the waves and then email and then draft emails to all of these investors and and send them you know a link to my calendar and the pitch and like a link to investor site and you know, basically try and manage the raise and then continue to check on the emails and the calendar and stuff and update this. Keep the spreadsheet updated to see who we’ve met with and whatever and then basically turn this on so that I can say like OK we’re gonna run this. You know every five minutes for the next three or four days or something and then we’re gonna try and book out you know the last week of the second week of May or something we’re gonna book out every single day with an investor goal you know and like that’s basically what I wanna do and so that’s what I’m attempting to do and then and then you know potentially do a similar thing for like customers and start building a giant database of customers that way, and then we also have like instantly.AI which we could you know funnel some of this into that etc. but basically those are the core things. I’m trying to automate right now and so I want what I basically want to know is like what what is the technical set up? I need to achieve all of these things right so like free each one of the individual work flows I can kind of figure out like what I need to do and stuff but like how do I set this up? Where does Emmy‘s agent live like doesn’t live in our normal repo for our site doesn’t live in our repo folder for our ops repo. Should I put it in a different folder is that is the Quinn 3.5 model locally good enough do I need to add honcho will that help? Is there anything else I should add? Do I have to pay for that? How should I think about splitting it up between Quinn and other models? Is there another local model I should be doing this is running on a 2018 custom belt PC with 64 GB of program and add 2080 TI graphics card you know so basically like I installed Hermes Agent today and just the Quinn 3.5 haven’t installed anything else and I’m just trying to figure out what’s the best way to use it also like what’s the best way to make it fast and performance and have it always on and then how do I think about like work trees and sub agents and like do I run one terminal should I run multiple terminals? I use conductor on my Mac, which lets you do individual work trees automatically with multiple workspaces multiple repose. Should I be thinking about it like that? Is this a thing that I should like run in conductor and let conductor manage the work trees and then just like launch it in there or do I just leave one terminal on and let let it kind of spin up agents itself. How do I think about like the workflow to kind of like do what I’ve described.


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


Okay, and then we have GitHub Actions already doing some of this stuff, and we have a Joby GitHub bot. Now GitHub Actions is gonna be... Currently, our repo on there is public, so our runs are free. So, you know, for something like the nightly QA run, if you're telling me that, you know, we should use Claude for that, then I don't know if it's saving us any money or just not just run it on GitHub for now until we make our repo private. But, or is it a thing that we could run with one? I guess that's my question, is like, is Quinn good enough for any of these, like, coding tasks or remediation tasks? Or do we need to have Claude code or codex using it? And if that is the point, then is there any benefit to me even doing this versus just using the cloud desktop app, which already has built-in cron jobs and stuff like that? I guess the main question is just like, cost. Although, if we can use the local model to do the orchestration, I guess it would more efficiently use our Claude Mac subscription, right? Because... It could theoretically be orchestrating tasks overnight that we normally wouldn't be using that time for. But then at the same time, I guess that logic could also apply to just using the Claude desktop app with automations on it. So I don't know. Basically, I wanna figure out if it's worth it to even be using for the coding-related tasks. And then, is it gonna be better or worse or the same on like managing the investor shit and whatnot? And like, should I use Claude or Codex or something to help with setting all these agents up to make them, you know, smarter or whatever? And then also, is there like, would it be cheaper for us to use like an open router thing or something? Or is there like auto model switching or something like that we can use that would be cheaper than us, you know, because right now we pay like, I have a Claude code max subscription, and then I have a Claude code pro subscription. And then I have the $200 a month codex and two $30 a month codex plans as well. And we usually burn through both the $200 plans and max and the other plans are like kind of not that useful for when we run out because the five-hour windows on them burn through so fast. but just wondering if like going API-based usage on any of these things or if there's any of the stuff would make it cheaper for us. I'd probably still keep those two subscriptions for like actual coding and building out features and stuff, but I don't know. I'm just trying to figure out like what's the most efficient way to set all this up. And then realistically, I have three machines right now. We have a 2022 MacBook Air with 16 gigabytes of RAM and an M2 chip. And then we have a 2026 M5, 32 gigabyte of RAM, MacBook Pro. And then we have the 2018 PC, which has a Samsung like Evo, one terabyte RAM chip, and then a M2 SSD, and then a second one of those as a storage drive, and then four SSDs in RAID, one terabyte, like normal SSDs in RAID for a four terabyte data drive, and then 64 gigabytes of RAM and a 2080 Ti. All of these, like what would be the thing? And then finally, the internet I'm currently using is like this shitty T-Mobile 5G internet. The desktop is hardwired in, and I have a Google Nest Pro mesh network. Is my internet a bottleneck for any of these things? And then what I'm usually doing is usually using both laptops at the same time and coding with like 10 agents or so on the MacBook Pro. And then I usually have like two agents running on the MacBook Air and I use like the synergy feature to control both at the same time with one mouse. And usually the Air... I'll have like, I'll be doing like design work on or something, so I'll run one dev server on it, because it starts to crap out once you run more than like one dev server. But we'd like run, we'd run like one dev server on that and then just use that kind of to do like design work and stuff so I can like see it updating and stuff. And then I'd use like the MacBook Pro to do like the heavy feature building and everything. Kind of like, look at the whole setup that I'm talking about and kind of decide like what makes sense to keep doing and what makes sense to change.


**Topic:** [[chatgpt-clusters/coding_ai]]


## See Also
- [[chatgpt/chatgpt_ai-agent-automation-part2]]
- [[chatgpt/chatgpt_ai-engineering-agent-prompt-part1]]
- [[chatgpt/chatgpt_aramis-agent-profile-management-part1]]
- [[chatgpt/chatgpt_hermes-agent-performance-comparison-part1]]
- [[chatgpt/chatgpt_1-of-body-weight-part1]]
