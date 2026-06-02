---
title: "Investigate Instagram Reel"
type: guide
created: 2026-05-08
updated: 2026-05-08
source: chatgpt-export
conversation_id: 69fd523a-1848-83e8-9901-c8b89e5da2bf
message_count: 7
tags: [chatgpt, import, code, long-form]
---
# Investigate Instagram Reel

> Conversation ID: 69fd523a-1848-83e8-9901-c8b89e5da2bf
> Created: 2026-05-08T03:02:19Z
> Updated: 2026-05-08T06:07:50Z
> Messages: 7

---

## User

investigate https://www.instagram.com/reel/DYCVxTstJdE/?igsh=NTc4MTIwNjQ2YQ== and see if this is something we can use directly or if theres other better version etc. and make a recommmendation for jovie

---

## Assistant

Mr. White, I’ll identify the reel and its source, look for better or original versions, assess reuse rights and brand fit, then recommend direct use versus reworking for Jovie.

---

## Assistant

Instagram is throttling the Reel itself, but indexed metadata points to Vercel Labs’ “find-skills” Claude agent workflow. I’m checking the source/tooling over reposts or near-duplicates.

---

## Assistant

Mr. White — recommendation: **do not use that reel directly. Recreate the format as a Jovie-native post.**

I couldn’t fetch the Instagram video itself because Instagram throttled the page, so this is based on indexed captions/OCR and related source trails. The reel appears to be about a Claude Code “Find Skills” shortcut: install `find-skills`, ask Claude something like “Are there any good skills for [goal]?”, and it recommends relevant agent skills. The same hook appears across multiple near-duplicate reels and posts, including “Japanese developer” / “Claude Code hack” variants. citeturn149844search2turn157629search3turn149844search0turn149844search4

The underlying tool is real and currently strong as a dev-tool meme: `find-skills` is listed by skills.sh as the #1 all-time skill with 1.4M installs, and its page says it discovers and installs specialized agent skills based on domain/task, source reputation, install count, and GitHub stars. citeturn521180view0turn868494view0 Claude’s official docs also support the broader concept: skills are reusable instructions Claude can load when relevant, and Anthropic’s repo describes skills as folders of instructions/scripts/resources for repeatable specialized workflows. citeturn194314view0turn194314view2

**Why not use it directly:** it is dev-tool content, not artist content; it is already cloned; and direct reposting/download use creates IP/audio risk. Instagram’s terms say the creator keeps ownership while granting Instagram a license, which does not grant Jovie reuse rights, and Instagram’s own help content says users should only post content that does not violate IP rights. citeturn259563search0turn259563search1 For commercial/brand use, the audio layer is an extra risk: Instagram distinguishes licensed copyrighted audio from royalty-free Sound Collection material. citeturn304627search14turn304627search1

**Best Jovie version:** use the same “one prompt finds the right next move” mechanic, but map it to artists. Jovie’s current positioning is already a fit: “Release more music with less work,” with one AI workspace to plan releases, create assets, pitch playlists, and promote each drop. citeturn610411view0 Jovie also sells the artist-profile/fan-capture loop: one profile for streams, drops, support, bookings, and fan capture, plus automatic notifications for new music and nearby shows. citeturn397629view0turn397629view1

**Recommended concept: “The release-week shortcut.”**

Use this angle:

> Artists are wasting release week guessing what to do next. Ask Jovie one question: “My song drops Friday — what am I missing?” Jovie turns it into the release plan, assets, playlist pitch, link, QR, and fan follow-up.

Suggested 25–30s reel:

**0–3s hook**  
“Most artists don’t need another marketing tool. They need the next move.”

**3–8s screen demo**  
Prompt in Jovie: “My single drops Friday. What should I do today?”

**8–18s output cards**  
Release checklist  
Cover/social assets  
Playlist pitch  
Creator/sound CTA  
Bio link + QR  
Fan notification plan

**18–25s payoff**  
“Jovie plans the release, builds the assets, and keeps the follow-up moving.”

**25–30s CTA**  
“Claim your artist profile. Ask Jovie what to do next.”

**Use this, not the Claude hook.** The Claude/Find Skills reel is useful as format inspiration, but Jovie’s better wedge is: **“artists don’t need to search 10 tools; Jovie tells them the next release action and does the work.”**

---

## User

no i meant should we use the find skills

---

## Assistant

Mr. White, I’ll assess `find-skills` as an adoption decision for Jovie: internal workflow, product integration, trust/licensing risk, alternatives, and whether a custom equivalent is better.

---

## Assistant

Mr. White — **yes, use `find-skills`, but only internally for Jovie’s AI/dev workflow. Do not expose it directly to artists as a product feature.**

`find-skills` is basically a discovery layer for the open Agent Skills ecosystem. Its own `SKILL.md` says it helps users find and install relevant skills when they ask things like “how do I do X” or “is there a skill for X,” then uses `npx skills find`, `npx skills add`, `npx skills check`, and `npx skills update`. It also tells the agent to verify install count, source reputation, and GitHub stars before recommending anything. citeturn968901view0

### Recommendation for Jovie

Use it in **three places**:

**1. Engineering workflow: yes, install it.**  
Add it to the Jovie repo / team Claude Code setup so agents can discover high-quality skills for frontend, QA, design, deployment, SEO, analytics, and launch-content workflows. The Vercel Labs CLI supports project-level installs, global installs, and agent targeting across Claude Code, Codex, Cursor, Windsurf, Gemini, GitHub Copilot, and many others. citeturn689053view0

Command:

```bash
npx skills add https://github.com/vercel-labs/skills --skill find-skills
```

**2. Product architecture: use the skills pattern, not the generic `find-skills` UX.**  
Artists should not see “find an agent skill.” They should see: “Plan my release,” “Pitch playlists,” “Make assets,” “Promote this drop,” “Build my artist profile.” That maps directly to Jovie’s current positioning: plan releases, create assets, pitch playlists, and promote drops from one AI workspace. citeturn425678view0

Build Jovie-native skills like:

```text
jovie-release-planner
jovie-playlist-pitch
jovie-artist-profile-builder
jovie-fan-notification-segmenter
jovie-social-content-remixer
jovie-metadata-checker
jovie-show-promo
jovie-drop-followup
```

Claude’s official docs describe Skills as reusable, filesystem-based resources that provide domain-specific workflows and load automatically when relevant, which is exactly the right structure for codifying Jovie’s repeatable artist workflows. citeturn968901view1

**3. Discovery layer: optionally use the skills.sh API behind the scenes.**  
If the Jovie agent needs a capability outside your own skills, use skills.sh search/audit endpoints internally to discover candidates, then only allow approved skills. The skills.sh API supports skill search, curated official skills, detailed skill file retrieval, and audit results. citeturn455046view0

### Guardrails

Do **not** let a production Jovie agent auto-install arbitrary community skills against artist data, fan lists, campaign copy, or account integrations. Anthropic explicitly warns that malicious skills can introduce vulnerabilities, exfiltrate data, or cause unintended actions, and recommends installing only trusted sources or auditing less-trusted skills first. citeturn968901view3

Also, the ecosystem itself says it cannot guarantee every listed skill’s quality or security, even though it runs audits. citeturn459221view0

Use this policy:

```text
Allowed:
- anthropics/*
- vercel-labs/*
- microsoft/*
- official first-party vendor skills
- Jovie-owned private skills

Blocked by default:
- unknown community skills
- skills with executable scripts unless reviewed
- skills that request network access
- skills that touch credentials, fan data, payments, or artist accounts
```

### Licensing / operational note

The Vercel Labs `skills` repo is MIT licensed, so it is fine to use commercially as tooling, subject to normal license compliance. citeturn689053view0

Disable telemetry for company usage:

```bash
export DISABLE_TELEMETRY=1
# or
export DO_NOT_TRACK=1
```

The repo documents both environment variables and says telemetry is anonymous, but I’d still disable it for Jovie internal workflows. citeturn689053view0

### Final call

**Use `find-skills` now for Jovie engineering.**  
**Build custom Jovie skills for the product.**  
**Do not let artists browse or install open ecosystem skills.**

The product-level opportunity is stronger than the reel: “Jovie has specialized artist skills for every part of a release.” That is a clean internal architecture and a better user-facing story.
