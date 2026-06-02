---
title: "Promptfoo LLM Evaluation"
type: note
created: 2026-05-14
updated: 2026-05-14
source: chatgpt-export
conversation_id: 6a06169d-3a60-83e8-9d58-ee5d214145c5
message_count: 2
tags: [chatgpt, import, code]
---
# Promptfoo LLM Evaluation

> Conversation ID: 6a06169d-3a60-83e8-9d58-ee5d214145c5
> Created: 2026-05-14T18:38:25Z
> Updated: 2026-05-14T18:38:40Z
> Messages: 2

---

## User

promptfoo

---

## Assistant

urlPromptfooturn0search0 is an open-source LLM evaluation and red-teaming framework used to test AI apps, prompts, agents, RAG systems, and workflows. It is primarily CLI-first and YAML-driven. citeturn0search0turn0search2turn0search7

Core use cases:
- Prompt regression testing
- Model comparison
- Agent evaluation
- RAG quality evaluation
- Security red teaming
- CI/CD eval gates
- LLM-as-a-judge scoring

Basic example:

```yaml
description: Jovie onboarding evals

providers:
  - openai:gpt-5.5
  - anthropic:claude-opus-4-1

prompts:
  - file://prompts/onboarding.txt

tests:
  - vars:
      user_input: "I'm a DJ with 4 unreleased songs"
    assert:
      - type: contains
        value: "release"
      - type: llm-rubric
        value: >
          Response should feel premium,
          concise, emotionally intelligent,
          and move the user toward activation.
```

Then run:

```bash
npx promptfoo@latest eval
```

And open the UI:

```bash
npx promptfoo@latest view
```

What makes it useful for Jovie specifically:

- Run 1000+ onboarding conversations automatically
- Detect regressions in chat UX/tone
- Score for:
  - objection handling
  - conversion likelihood
  - hallucinations
  - formatting consistency
  - tool call correctness
  - UI state breakage
  - latency/cost
- Compare models side-by-side
- Automatically fail PRs when onboarding quality drops
- Red-team artist onboarding flows
- Test deterministic fan-alert workflows

Promptfoo is especially strong when combined with:
- Playwright
- screenshot diffing
- synthetic conversation generation
- LLM judges
- CI pipelines

A strong pattern for your stack:

```txt
Playwright
  ↓
Capture onboarding screenshots + DOM states
  ↓
Promptfoo
  ↓
LLM judges score:
- UX polish
- emotional tone
- conversion likelihood
- clarity
- layout stability
- consistency
  ↓
GitHub PR comment
  ↓
Auto-open Linear issues
```

This is the exact category of tooling modern AI-native products are moving toward:
- eval-driven development
- agent QA
- automated UX auditing
- conversational regression testing

Promptfoo also supports:
- OpenAI
- Anthropic
- Gemini
- Ollama/local models
- custom providers
- API endpoints
- MCP tools
- JS/Python providers
- CI integrations

The GitHub repo is here:

urlpromptfoo GitHub repoturn0search2

Docs:

urlPromptfoo docsturn0search7

Getting started:

urlPromptfoo getting started guideturn0search16

OpenAI announced an acquisition in 2026 while keeping it open source. citeturn0search4
