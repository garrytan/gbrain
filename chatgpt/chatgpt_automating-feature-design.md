---
conversation_id: 6a00c907-fce4-83e8-8bd0-5a2e926cd771
created: 2026-05-10
links:
- '[[chatgpt-clusters/design_ux]]'
message_count: 3
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Automating Feature Design
type: guide
updated: 2026-05-10
---

# Automating Feature Design

**Related:** [[design_ux]]

> Conversation ID: 6a00c907-fce4-83e8-8bd0-5a2e926cd771
> Created: 2026-05-10T18:06:00Z
> Updated: 2026-05-10T18:11:39Z
> Messages: 3

---

## User

One thing I keep doing is, for example, I asked Jeremy's agent to build me a what's new component, and now I'm thinking about it. I'm like, okay, well, it should probably be a pop-up in the bottom corner, like in the linear or something on the sidebar, that shows us, "Oh hey, this new feature." This also needs to tie into the change log, I guess, and we probably want automatic screenshots and probably gif animations. We want this to be extensible so that in the future it can also be tied into emails that go out, and it should probably be in a notification system. You know what I mean?

As I'm thinking about it, I'm just like, well, I could ask for this feature, but I don't know that Jeremy's agent is going to figure out how to build it the way I want it. What I would probably do is I'd probably go to you in ChatGPT and I'd probably put on ChatGPT either deep research or ChatGPT 5.5 Pro with extended thinking and ask for it to design the feature. Then I'd copy and paste that plan into Claude Code and build it. That's very involved in 9.0. How do we automate that? It doesn't seem clear that you can get 5.5 Pro, the model, without the web interface. Am I right or wrong on that? Can we use the subscription port? If we can or can't, is there a way we can automate it in the browser to automatically pick up issues in Linear and write plans to it, or how should we do this, or are we just shit out of luck if we want 5.5 Pro and we gotta do it? We've got to make the plans with a different model, just radio 5.5 or something like that. How should I think about this? 

---

## Assistant

Mr. White, I’ll separate three questions: model/API availability, browser automation viability, and the best architecture for turning Linear issues into high-quality implementation plans.

---

## Assistant

Mr. White — you’re **not shit out of luck**. You should think about this as a **planning pipeline**, not as “how do I get ChatGPT web to do this in the browser.”

### The model-access answer

You are **wrong** if you think GPT-5.5 Pro is only available through the ChatGPT web interface. OpenAI’s API docs list `gpt-5.5-pro` as an API model available through the Responses API, with text/image input, text output, structured outputs, function calling, web search, file search, code interpreter, hosted shell, and MCP support. It is expensive and slow: OpenAI lists it at **$30 / 1M input tokens** and **$180 / 1M output tokens**, and says some requests can take several minutes, so background mode is recommended. citeturn285278view2

You are **right** that your **ChatGPT Pro subscription is separate from API usage**. OpenAI explicitly says ChatGPT and the API platform have separate billing systems, and that API usage is billed separately/pay-as-you-go. citeturn849910view2turn849910view3

So the answer to “can we use the subscription port?” is: **for a real automation pipeline, use the API, not the ChatGPT subscription.** Codex has an advanced ChatGPT-managed auth path for CI/CD, but OpenAI’s Codex docs still say API keys are the default for automation because they are easier to provision and rotate. citeturn315177view3

### Do not build this by automating the ChatGPT web UI

I would avoid headless/browser automation that logs into ChatGPT and scrapes/plumbs output from the web app. OpenAI’s current Terms say users may not “automatically or programmatically extract data or Output” from the Services, and a browser automation pipeline would also be brittle against UI changes, rate limits, auth issues, and session state. citeturn670384search0

Use browser/ChatGPT manually for one-off thinking. Use the API for production-ish automation.

### The architecture I’d use

Build a **Linear planning bot** that runs before code agents.

Flow:

```text
Linear issue created or labeled "needs-plan"
  ↓
Planner service fetches issue, comments, linked docs, screenshots, repo context
  ↓
GPT-5.5 or GPT-5.5 Pro writes a structured product/engineering plan
  ↓
Plan is written back to Linear as a comment or document
  ↓
Human approves / edits
  ↓
Issue moves to "Ready for Build"
  ↓
Claude Code, Codex, or Jeremy’s agent implements from the plan
```

For the planner model, I’d use:

| Use case | Model choice |
|---|---|
| Normal feature plans | `gpt-5.5` with medium/high reasoning |
| Ambiguous, high-leverage architecture decisions | `gpt-5.5-pro` |
| Competitive research / docs-heavy research / market scans | Deep Research API |
| Implementation | Claude Code, Codex, or your existing agent |

OpenAI’s reasoning docs specifically recommend `gpt-5.5` for most reasoning workloads and `gpt-5.5-pro` for the hardest problems that can tolerate higher latency. They also describe reasoning effort levels such as low, medium, high, and xhigh. citeturn543125view1

Deep Research is API-accessible too, but it is a different tool. OpenAI lists `o3-deep-research` and `o4-mini-deep-research` for complex research reports; the API version expects a fully formed prompt and does **not** automatically do the ChatGPT UI’s clarification/prompt-rewrite step, so you’d need to implement that step yourself. citeturn216734view1turn216734view0

### How this handles your “What’s New” example

The issue title might be:

> Build a What’s New component

The planner should expand it into something closer to:

```text
Feature: Release communication system

Surfaces:
- Bottom-right popup/toast for new features
- Optional sidebar feed
- Full changelog page
- Future email digest support

Data model:
- ChangelogEntry
- ReleaseAsset
- NotificationDelivery
- UserSeenState
- AudienceSegment

Admin flow:
- Create entry
- Attach screenshot/gif
- Assign audience
- Publish now / schedule
- Track seen/dismissed/opened

User flow:
- Show new entries after release
- Allow dismiss
- Preserve seen state per user/workspace
- Link to full changelog

Future extensibility:
- Email digest
- In-app notification center
- Workspace-specific release notes
- AI-generated screenshots/gifs from preview deploys

Build phases:
1. Data model + changelog page
2. Popup renderer + seen state
3. Admin authoring flow
4. Asset generation
5. Email integration
6. Analytics and targeting
```

That is the value you are trying to extract from GPT-5.5 Pro: converting a vague implementation request into a **product system design** before a code agent starts writing files.

### Where Claude Code fits

Claude Code can be automated, but I’d feed it the finished plan rather than asking it to infer the plan. Anthropic’s docs say Claude Code GitHub Actions can respond to `@claude` in issues/PRs, create PRs, implement features, and supports custom workflows via the Claude Code SDK. citeturn671979search0

So you can do:

```text
Linear issue → GPT-5.5 planner → Linear plan → GitHub issue/branch → Claude Code implementation
```

or:

```text
Linear issue → GPT-5.5 planner → Codex in Linear
```

OpenAI’s Codex Linear integration already supports assigning issues to Codex or mentioning `@Codex`; Codex creates a cloud task and posts progress/results back to Linear. It also supports Linear triage rules that automatically delegate issues to Codex. citeturn315177view0

### The practical recommendation

I would build this in three layers:

**Layer 1 — Planning bot**

Triggered by a Linear label like `needs-plan`.

It produces a markdown plan with fixed sections:

```text
Summary
User problem
Product requirements
UX behavior
System design
Data model
Dependencies
Implementation phases
Acceptance criteria
Risks / open questions
Recommended agent prompt
```

Use `gpt-5.5` for most issues. Escalate to `gpt-5.5-pro` when the issue is vague, architectural, cross-system, or likely to cause rework.

**Layer 2 — Human approval**

The bot writes: “Draft plan — needs approval.”

You or Jeremy skim it. If good, label `approved-for-build`.

**Layer 3 — Build agent**

Claude Code/Codex/Jeremy’s agent receives the finalized plan, not the vague issue.

This prevents the code agent from prematurely choosing the wrong abstraction.

### The key mental model

Use the expensive model for **taste, architecture, product expansion, and risk discovery**.

Use the coding agent for **implementation**.

Do not rely on an implementation agent to infer all the hidden product architecture from a short Linear issue. That is exactly how you get a “What’s New component” instead of a release communication system.

My recommendation: **build a GPT-5.5/GPT-5.5 Pro Linear planner as a small internal service.** Don’t automate the ChatGPT browser. Don’t make every issue use Pro. Run normal planning on `gpt-5.5`, escalate high-ambiguity specs to `gpt-5.5-pro`, then hand the resulting plan to Claude Code or Codex.


**Topic:** [[chatgpt-clusters/design_ux]]
