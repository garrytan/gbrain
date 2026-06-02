---
title: "Promptfoo vs Braintrust"
type: guide
created: 2026-05-24
updated: 2026-05-24
source: chatgpt-export
conversation_id: 6a12630e-6764-83e8-986d-8e0ce5b4bb8d
message_count: 6
tags: [chatgpt, import, code]
---
# Promptfoo vs Braintrust

> Conversation ID: 6a12630e-6764-83e8-986d-8e0ce5b4bb8d
> Created: 2026-05-24T02:31:43Z
> Updated: 2026-05-24T02:40:30Z
> Messages: 6

---

## User

promtpfoo vs braintrust

---

## Assistant

I’ll treat “promtpfoo” as Promptfoo and compare it with Braintrust across evals, CI, observability, hosting, pricing posture, and best-fit use cases.

---

## Assistant

Mr. White, **Promptfoo = better for security/red-team evals in code/CI. Braintrust = better for production observability + eval workflow.**

| Dimension | Promptfoo | Braintrust |
|---|---|---|
| **Core use case** | Open-source CLI/library for LLM evals and red-teaming. Strong for testing prompts, RAG, agents, jailbreaks, prompt injection, data leaks, and CI gates. citeturn792009view0turn792009view5 | AI observability + eval platform: traces, datasets, experiments, playgrounds, CI/CD evals, and production scoring. citeturn792009view1turn483888search0 |
| **Best workflow** | Repo-first. Define evals, run locally, add to CI, output reports/JSON/JUnit. citeturn792009view5 | Platform-first. Instrument app, collect traces, turn production behavior into datasets, run experiments and online scoring. citeturn483888search0turn483888search1 |
| **Security testing** | Stronger default fit. Promptfoo’s positioning is explicitly LLM security, red teaming, vulnerability scanning, guardrails, and compliance workflows. citeturn525288view1turn685809search0 | Useful for quality monitoring and evals, but security red-teaming is less central than observability/eval lifecycle. Braintrust’s docs emphasize systematic evals, traces, datasets, and production scoring. citeturn792009view1turn483888search0 |
| **Production monitoring** | Enterprise has continuous monitoring and dashboards, but the open-source/core workflow is mainly local/CI testing. citeturn525288view1 | Stronger. Braintrust is built around tracing production traffic, scoring traces, and feeding production examples back into eval datasets. citeturn483888search0turn483888search1turn792009view4 |
| **Data/privacy posture** | Community version can run locally or self-host; docs state evals run on your machine and talk directly to the LLM provider. citeturn792009view0turn525288view1 | Cloud SaaS by default; Enterprise offers custom retention/export, RBAC, and hosted or on-prem deployment for high-volume or privacy-sensitive data. citeturn525288view0 |
| **Pricing** | Community is free forever; red teaming includes 10k probes/month; Enterprise and On-Prem are custom priced. citeturn525288view1 | Starter is $0/month with usage limits; Pro is $249/month plus usage; Enterprise is custom. citeturn525288view0 |

## Recommendation

**Choose Promptfoo** for:

- Security and adversarial testing.
- Fast local evals.
- CI/CD regression gates.
- Testing prompts, RAG outputs, agents, and tool-use risks before deploy.
- A lightweight open-source workflow.

**Choose Braintrust** for:

- Production tracing and observability.
- Turning real user traces into eval datasets.
- Team workflows with playgrounds, experiments, dashboards, human review, and continuous online scoring.
- Measuring quality over time across releases.

## Practical answer

For a startup shipping AI features:

**Start with Promptfoo** if your main concern is “will this agent/RAG/prompt fail, leak data, get jailbroken, or regress before release?”

**Use Braintrust** once you need “what is happening in production, which traces are bad, how do we score them continuously, and how do we improve the system over time?”

The strongest setup is **both**: Promptfoo as the pre-deploy red-team/CI gate, Braintrust as the production trace/eval loop.

---

## User

give me codex goal for promptfoo setup and run

---

## Assistant

I’ll produce a paste-ready Codex task for setting up and running Promptfoo, including a minimal eval suite, verified commands, workflow docs, and clear acceptance criteria.

---

## Assistant

Mr. White, paste this into Codex:

```text
Set up Promptfoo in this repo and run a first evaluation.

Goal:
Add a minimal, maintainable Promptfoo evaluation setup for the app’s LLM prompts / AI flows, then run it locally and leave clear commands for future runs.

Context:
Promptfoo should be run via npx so the repo does not require a global install. Use `npx promptfoo@latest`. Do not hard-code API keys or secrets. Use existing environment variables where possible, especially OPENAI_API_KEY or the provider keys already used by this repo.

Tasks:
1. Inspect the repo and identify the main LLM prompt, agent, RAG, or AI call path.
2. Add a Promptfoo config file at the repo root:
   - `promptfooconfig.yaml`
   - Include the relevant prompt(s), provider(s), and test cases.
   - Prefer testing the real app behavior through a local script/provider if the repo already wraps model calls.
   - Otherwise create a simple first-pass config that directly tests the prompt against the configured model.
3. Add at least 8 useful eval cases:
   - normal happy-path input
   - edge-case input
   - ambiguous user request
   - prompt-injection attempt
   - request for private/secrets data
   - malformed input
   - long-context or noisy input
   - refusal / policy-boundary case if applicable
4. Add assertions for quality and safety:
   - expected content or semantic similarity where appropriate
   - does not contain secrets / system prompt leakage
   - handles prompt injection safely
   - produces structured output if the app expects structured output
5. Add npm scripts if package.json exists:
   - `eval:llm`: run Promptfoo eval
   - `eval:llm:report`: run Promptfoo eval and output JSON + HTML report
   Example:
   - `npx promptfoo@latest eval -c promptfooconfig.yaml`
   - `npx promptfoo@latest eval -c promptfooconfig.yaml -o promptfoo-results.json -o promptfoo-report.html`
6. Run the eval.
7. Fix obvious config or prompt issues until the eval runs successfully.
8. Save results artifacts if generated:
   - `promptfoo-results.json`
   - `promptfoo-report.html`
9. Update README or create `docs/promptfoo.md` with:
   - required env vars
   - how to run evals
   - how to view reports
   - how to add new test cases
   - what the first eval results showed
10. Do not commit secrets, generated caches, or unnecessary large files.

Success criteria:
- `promptfooconfig.yaml` exists and is valid.
- At least 8 test cases exist.
- The eval command runs successfully or fails only because a required API key is missing.
- Missing-key failure is documented clearly.
- The repo has repeatable commands for running Promptfoo.
- The setup is simple enough for CI later.
```

Promptfoo’s docs currently show `npx promptfoo@latest init` for setup and `npx promptfoo@latest eval -c promptfooconfig.yaml` for CI-style eval runs; they also support JSON, HTML, and JUnit output formats. citeturn130144search2turn130144search5 Red-team setup is available separately through `npx promptfoo@latest redteam setup` when you want security-focused scanning beyond the first eval harness. citeturn130144search6


## See Also
- [[chatgpt/chatgpt_using-braintrust-for-jovie]]
- [[chatgpt/chatgpt_evals-and-promptfoo-explained]]
- [[chatgpt/chatgpt_promptfoo-llm-evaluation]]
- [[chatgpt/chatgpt_01-vs-091-proof]]
- [[chatgpt/chatgpt_1-of-body-weight-part1]]
