---
title: "CI at Anthropic"
type: note
created: 2026-02-20
updated: 2026-02-20
source: chatgpt-export
conversation_id: 6998d71c-a3cc-8330-a222-3ea5a2fbbf0a
message_count: 4
tags: [chatgpt, import]
---
# CI at Anthropic

> Conversation ID: 6998d71c-a3cc-8330-a222-3ea5a2fbbf0a
> Created: 2026-02-20T21:50:32Z
> Updated: 2026-02-20T21:50:51Z
> Messages: 4

---

## User

ci at antrhopic

---

## Assistant

At **entity["organization","Anthropic","AI company"]**, **CI** most commonly refers to **Continuous Integration**, which is standard software-engineering practice: automated systems that build and test code whenever developers commit changes, catching errors early and enforcing quality before deployment. Continuous integration helps Anthropic’s engineers ship reliable code across its complex codebase and supports automated testing, reporting, and infrastructure workflows. citeturn0search6turn0search19

In the context of Anthropic engineering teams, the **CI team** is explicitly the group responsible for this infrastructure — building, testing, and automating code validation at scale across many developers and cloud environments. citeturn0search6

If you meant a different *CI* (e.g., in model training or AI safety at Anthropic), clarify and I can define that too.

---

## User

what do they use

---

## Assistant

At **Anthropic**, engineers generally rely on **modern Git-centric CI/CD tooling** rather than proprietary or legacy CI servers. Public traces from their open repos show **GitHub Actions being used to automate builds and tests**, meaning workflows are defined in `.github/workflows` and triggered on pushes and pull requests. citeturn0search3

**What they use (based on public code and typical practice):**  
- **GitHub Actions** — primary continuous integration platform seen in Anthropic repos; used to build, test, lint, and deploy code directly from GitHub. citeturn0search3  
- **AI-assisted hooks/automation** — teams mention automated formatting, type-checks, and validation hooks to reduce manual errors before CI runs. citeturn0search2  
- **AI tools like Claude Code** are used internally for coding, testing assistance, and generating workflows (not strictly a CI engine, but part of development automation). citeturn0search4

There’s no public evidence Anthropic uses older standalone CI servers like Jenkins, TeamCity, or similar; GitHub Actions is the de-facto CI provider for their open repos, with likely internal extensions or integrations tailored to their infrastructure. citeturn0search3


## See Also
- [[chatgpt/chatgpt_anthropic-api-overview]]
- [[chatgpt/chatgpt_anthropic-cli-overview]]
- [[chatgpt/chatgpt_anthropic-meaning-and-context]]
- [[chatgpt/chatgpt_claw-plan-vs-anthropic-api]]
- [[chatgpt/chatgpt_fact-check-anthropic-deal]]
