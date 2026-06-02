---
title: "Versioning in Next.js"
type: guide
created: 2026-01-31
updated: 2026-01-31
source: chatgpt-export
topic: coding-devops
message_count: 8
tags: [chatgpt, knowledge, coding-devops]
---
# Versioning in Next.js

> **Source:** ChatGPT conversation
> **Date:** 2026-01-31T20:42:57Z
> **Messages:** 8
> **Topic:** coding-devops

## Question

Talk to me about versions. 

Next.js app in turbo repo with GitHub ci.

Web app only right now. How should we number our app builds. How can we automate. How do we handle with vercel and statsig.

## Answer

Mr. White — for a Next.js web app in a Turborepo, you want **two identifiers**:

1) **A human-facing “release version”** (SemVer)  
2) **A machine-unique “build ID”** (every deploy, every preview)

That combo keeps product/ops sane and makes Vercel + Statsig analytics line up cleanly.

---

## 1) What to number

### Release version (SemVer)
Use `MAJOR.MINOR.PATCH` for **production releases**:
- **PATCH**: fixes, no product changes
- **MINOR**: backward-compatible features
- **MAJOR**: breaking changes / big rewrites

Example: `1.8.3`

### Build ID (every deployment)
Make it **globally unique** and easy to trace to code:
- **Commit SHA** (+ optionally Vercel deployment ID)

Example:
- `1.8.3+sha.fa1eade`  
- `1.8.3+sha.fa1eade.dpl_7Gw5Z...`

Vercel provides `VERCEL_GIT_COMMIT_SHA` and `VERCEL_DEPLOYMENT_ID` when system env vars are exposed. citeturn1view0

---

## 2) How to automate it (practical path)

### Option A (best default): semantic-release on `main`
- Enforce **Conventional Commits**
- On merge to `main`, semantic-release:
  - computes next SemVer
  - creates a Git tag + GitHub Release notes

You can implement similar “auto bump from commit messages” behavior using an action like `PaulHatch/semantic-version` as a lightweight approach. citeturn0search1

**Why this is great:** no manual version bumps; version reflects change type.

### Option B (simplest): “release version = last tag”, “build ID = SHA”
If you don’t want automated SemVer yet:
- Keep `0.x` versions manually (or bump weekly)
- Always stamp builds with `sha`

This is still perfectly traceable and works immediately.

---

## 3) How this fits with Vercel

### Recommended workflow with entity["company","GitHub","code hosting company"] CI + entity["company","Vercel","cloud deployment platform"]
- **GitHub Actions**: run lint/test/typecheck, required status checks
- **Vercel Git integration**: builds/deploys on push/merge

This avoids double-building the same commit (once in Actions, once in Vercel).

### Getting version/build info into the app
Vercel has system env vars like:
- `VERCEL_ENV`, `VERCEL_GIT_COMMIT_SHA`, `VERCEL_DEPLOYMENT_ID`, etc. citeturn1view0

For **client-side** visibility in Next.js, you must expose them as `NEXT_PUBLIC_*` (Vercel community guidance commonly uses this pattern). citeturn0search8

In Vercel Project → Env Vars, add:
- `NEXT_PUBLIC_GIT_SHA = $VERCEL_GIT_COMMIT_SHA`
- `NEXT_PUBLIC_DEPLOYMENT_ID = $VERCEL_DEPLOYMENT_ID`
- `NEXT_PUBLIC_VERCEL_ENV = $VERCEL_ENV`

Then your app can render a footer like: `v1.8.3 (fa1eade)`.

> Note: Vercel also has a setting to “Automatically expose System Environment Variables.” If disabled, those IDs won’t be available to frameworks like Next.js. citeturn1view0

---

## 4) How to handle Statsig cleanly

Two things matter for entity["company","Statsig","feature management company"]:

### A) Environment mapping
Statsig lets you set an **environment tier** at SDK init (and warns: if unset, it default

*(Answer truncated — 4620 chars total)*

## Question

Okay, a couple things. We want to go ahead and implement this, so we're looking for the best way to do this. So I wanna like hash it out with you and lock in the best system for Jovie, J-O-V-I-E, our app. So we wanna decide on how to handle this for Jovie. And so a couple of, and I basically wanna lay out the whole plan, hash it out with you, and then once we've locked it in, we'll turn that into a prompt that we can give to an AI coding agent and have it implement it. But basically the way it's gonna work is, the questions that we have to figure out before we can make the plan is, one, I've seen a lot of companies, including I think Adobe started doing this, actually NVIDIA might even instead of started doing this too, a lot of companies that have started doing this versioning where it's like partially calendar-based, so they'll do like 2015, or I guess, well, why would I give you a 10-year date? They'll do like, so for today, it'll be like, you know, 2026.whatever, whatever, dot what

## Answer

Mr. White — let’s lock in a system that (a) fits 2–3 prod deploys/day, (b) survives rollbacks cleanly, and (c) gives you excellent traceability in entity["company","Vercel","hosting platform"] + entity["company","Statsig","feature management"].

Below I’ll (1) answer your “CalVer / 4-digit segment / sequential?” questions, (2) cover rollback behavior, and then (3) propose **one best system for Jovie** that you can hand to a coding agent.

---

## 1) Calendar-based versions: what companies are doing

**CalVer (Calendar Versioning)** means some chunk of the version encodes the release date (usually year + month, sometimes day), and the remaining chunk is an increment. citeturn2view1turn0search4

Common patterns you’ll see:

- **`YYYY.MM`** (monthly releases)  
- **`YY.M`** (short monthly)  
- **`YYYY.MM.DD`** (daily releases)
- **Add a trailing increment** when you ship multiple times in the same period, e.g. `YYYY.MM.DD.<patch>` or `YYYY.MM.<patch>`. citeturn0search4turn0search8

That “four digits after the last dot” you noticed is usually just a **build/release sequence counter** (often CI run number, or “nth release this year/month/day”). It’s *typically* monotonically increasing; whether it resets depends on the scheme.

Example of a real-world CalVer-ish explanation: entity["company","Adobe","software company"] Workfront explicitly describes a scheme where “first number is year, second is month” (e.g. `24.4` for April 2024). citeturn0search13turn0search5

---

## 2) Rollbacks: will the version “roll back” too?

If you stamp the version **at build/deploy time** (not computed from “current time” at runtime), then rollback works exactly how you expect.

With **Vercel Instant Rollback**, Vercel treats it as a restored previous deployment and notes that env/config can revert to the state of the rolled-back deployment; in particular, env vars revert to that prior build’s state. citeturn2view0turn0search23

So yes: **your UI version string and Statsig metadata will match the rolled-back deploy** as long as they were part of that deployment’s build output / env.

---

## 3) The modern way to think about it (and how it maps to your cadence)

You’re shipping to production multiple times per day. That’s *perfect* for:

- **A “Deploy Version”**: changes every successful prod deploy (high-frequency, engineering-facing, support/debugging gold)
- **An optional “Marketing/Release Version”**: changes when you *choose* to announce something (lower-frequency, human-facing)

You *can* do SemVer on every deploy, but it tends to become noise (“0.0.487”) unless you’re publishing a library with compatibility promises.

For a single web app (no external SDK consumers), CalVer is usually a better “human-ish” identifier.

---

# ✅ Recommendation: lock this in for Jovie

### A) Jovie Versioning Spec

**1) Deploy Version (PRIMARY) = CalVer + CI sequence**
- Format: `YYYY.MM.DD.<N>`
- Example: `2026.01.31.1074`
- `<N>` = GitHub Actions run number (

*(Answer truncated — 9872 chars total)*

## Question

We're deploying via GitHub Actions, and then we have, I don't think we're using the Vercel, we might be, but we, we don't have a done and build steps, so I think we're building and using TurboCache, and only after it passes all the checks in GitHub CI does it go to the deploy step, and then once it hits the deploy step, that's where it invokes the Vercel command, but we still have deploys on every PR to Vercel, so I guess it maybe that's the GitHub integration, not sure.

## Answer

Mr. White — based on what you described, you almost certainly have **both**:

- **entity["company","Vercel","cloud platform"] Git integration** creating Preview Deployments on PRs (and often posting a “Vercel” check/comment). Vercel’s Git integration *does* auto-deploy every branch push and merges onto the project’s production branch. citeturn1search0turn1search6  
- A **entity["company","GitHub","code hosting platform"] Actions workflow** that runs tests/builds and then calls the Vercel CLI for deploys (custom workflow). citeturn0search0turn2search12

That’s common early on — but it’s worth “locking” who is responsible for **preview** and who is responsible for **production**, otherwise you get duplicate deploys and confusing version attribution.

## The cleanest setup for Jovie (matches your current intent)

### 1) Keep Vercel Git integration for PR previews
Let Vercel keep doing what it’s best at: automatic Preview Deployments per PR. citeturn1search0turn1search6

### 2) Make production deploys *only* come from GitHub Actions
To prevent Vercel Git integration from also deploying `main` automatically, disable Git-triggered deployments **for `main` only** via `vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "git": {
    "deploymentEnabled": {
      "main": false
    }
  }
}
```

Vercel explicitly supports `git.deploymentEnabled` as an object so you can disable deployments per-branch. citeturn1search13

Alternative (less clean): use **Ignored Build Step** to skip builds on `main`, but I’d rather use `git.deploymentEnabled` because it avoids the build entirely. citeturn0search2

### 3) Deploy production from Actions with the Vercel CLI
Your deploy job should run:

- `vercel deploy --prod` (or `vercel --prod`) to update the production domain citeturn2search1  
- pass `NEXT_PUBLIC_JOVIE_VERSION` / `NEXT_PUBLIC_JOVIE_SHA` via `--build-env` citeturn2search1  
- optionally attach metadata via `--meta` so you can filter deployments by version/sha in Vercel citeturn2search1

This aligns with Vercel’s “custom workflows” guidance for GitHub Actions + CLI. citeturn0search0turn2search12

---

## Where your “TurboCache build first” fits

You have two viable modes; pick one and commit:

### Mode A (recommended): Actions tests/builds for confidence, Vercel builds for deploy
- Keep your fast Turbo-backed checks in Actions.
- In the deploy step, run `vercel deploy --prod` and let Vercel do its build.

Pros: simplest, you keep **system env vars** and the “normal” Vercel runtime behavior. Vercel system env vars are a first-class thing in Vercel builds/deployments. citeturn0search3  
Cons: you’re building twice (once in CI, once on Vercel).

### Mode B (advanced): build in Actions, deploy artifacts with `--prebuilt`
- Use `vercel build` (produces `.vercel/output`) then `vercel deploy --prebuilt` citeturn2search2turn2search0

Pros: deploy *exactly* what you built in CI; avoids Vercel rebuild

*(Answer truncated — 5131 chars total)*

## Question

What is DX in terms of development?

## Answer

Mr. White — **DX** means **Developer Experience**.

It’s the “how it feels to build” side of engineering: how fast and pleasant it is for developers to develop, test, ship, debug, and maintain software.

### What DX usually includes
- **Setup time**: how quickly a new dev can clone and run the repo
- **Tooling ergonomics**: linting, formatting, type-checking, IDE support, codegen
- **Feedback speed**: test runtime, hot reload, CI duration, caching (e.g., Turborepo)
- **Deploy experience**: preview environments, clear logs, reproducible builds
- **Debuggability/observability**: good errors, source maps, tracing, breadcrumbs, easy rollback
- **Consistency**: standard scripts, conventions, templates, predictable workflows
- **Docs**: minimal but accurate “how to” docs for common tasks

### How people measure DX (informally)
- Time from “idea → running locally”
- Time from “PR opened → merged”
- Time from “bug report → root cause”
- CI flake rate / how often builds fail for non-code reasons

If you want: for Jovie, you can treat DX as a first-class metric by tracking “PR cycle time” and “CI duration” and optimizing around those.
