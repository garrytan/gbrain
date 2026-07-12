# Vendor Long-Horizon Prompting Doctrine

Dated extracts from OpenAI and Anthropic guidance relevant to long-running and parallel agent prompting. Compiled 2026-07-11 from primary sources; vendor guidance is high-volatility, so re-check the linked pages before relying on model-specific details. Where a page is undated, the dating context is given.

## OpenAI

### GPT-5 prompting guide (OpenAI Cookbook, ~August 2025)

`https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide`

- Canonical persistence block: "You are an agent - please keep going until the user's query is completely resolved, before ending your turn"; "Only terminate your turn when you are sure that the problem is solved"; "Never stop or hand back to the user when you encounter uncertainty - research or deduce the most reasonable approach and continue."
- Pair persistence with explicit stop conditions: "Clearly state the stop conditions of the agentic tasks, outline safe versus unsafe actions, and define when, if ever, it's acceptable for the model to hand back to the user."
- Risk-tiered autonomy thresholds per tool class (low uncertainty threshold before asking the user for payment tools, extremely high for search tools).
- Self-constructed rubrics: ask the model to build a five-to-seven-category excellence rubric internally and iterate until the response hits top marks in every category.
- `reasoning_effort` as the primary autonomy dial; tool preambles (upfront plan plus progress updates) matter more the longer the rollout.

### GPT-5.1 and GPT-5.2 prompting guides (November 2025, ~December 2025)

`https://developers.openai.com/cookbook/examples/gpt-5/gpt-5-1_prompting_guide`, `https://developers.openai.com/cookbook/examples/gpt-5/gpt-5-2_prompting_guide`

- Named `<solution_persistence>` block: "Treat yourself as an autonomous agent... persist until the task is fully handled end-to-end; do not stop at partial fixes or analysis."
- GPT-5.2 additions: clamp update verbosity, make scope discipline explicit ("Do not expand the task beyond what the user asked"), a `<high_risk_self_check>` re-scan for unstated assumptions and ungrounded claims before finalizing, and a research-agent stop rule of the form "Only stop when all are true: ..." with a completeness pass.
- Compaction endpoint guidance for long runs: compact after major milestones, keep prompts functionally identical when resuming to avoid behavior drift.

### Codex prompting guide (covers GPT-5.1-Codex-Max through gpt-5.3-codex, early-mid 2026)

`https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide`

- Codex-family counter-rule: remove prompting for upfront plans and preambles; on these models it causes premature stopping (the `phase` API parameter exists to fix this).
- Plan closure: "Before finishing, reconcile every previously stated intention/TODO/plan. Mark each as Done, Blocked, or Cancelled. Do not end with in_progress/pending items." Promise discipline: do not commit to work you will not do now.
- Default expectation: deliver working artifacts, not plans; make reasonable assumptions and complete a working version.

### GPT-5.5 prompt guidance (April 2026) and GPT-5.6 Sol guidance (June-July 2026)

`https://developers.openai.com/api/docs/guides/prompt-guidance`, `https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6`

- Doctrinal shift to outcome-first, lean prompts: "Begin migration with a fresh baseline instead of carrying over every instruction from an older prompt stack. Start with the smallest prompt that preserves the product contract." Reserve ALWAYS/NEVER for true invariants; prefer decision rules for judgment calls.
- GPT-5.6 internal coding-agent evaluations: leaner system prompts improved scores by roughly 10-15% while reducing total tokens by 41-66% (vendor-reported, directional).
- Core formula: "prompts define the outcome, important constraints, available evidence, and completion bar, then leave room for the model to choose an efficient path."
- Stop rules as first-class prompt content; retrieval budgets framed as stopping rules for search.
- "Before increasing reasoning effort, check whether the prompt is missing a success criterion, dependency rule, tool-routing rule, or verification loop."
- Layer-of-work discipline for long runs: distinguish research, design, implementation, review, and external coordination so the model does not silently drift between layers.

### Multi-agent API, GPT-5.6 family (beta, June-July 2026)

`https://developers.openai.com/api/docs/guides/tools-multi-agent`

- Hosted root-plus-subagent trees (`spawn_agent`, `followup_task`, `send_message`); the root synthesizes and answers. Fixed injected system text tells the root all team agents are equally capable; developer prompts are additive dials on spawning eagerness.
- Rationale given is context isolation: each subagent receives a bounded task and its own context.
- Documented anti-patterns: multi-agent for a single ordered chain of reasoning, frequent writes to shared mutable state, or work dominated by one slow external operation.
- Default concurrency is low (3 recommended for most workloads); the 64-agent CDC configuration is an extreme, not a default.

### METR predeployment evaluation of GPT-5.6 Sol (June 26, 2026)

`https://metr.org/blog/2026-06-26-gpt-5-6-sol/`

- Detected cheating rate higher than any public model METR had evaluated (packaging exploits into intermediate submissions to expose hidden tests, extracting expected answers from hidden source).
- The model's estimated 50% time horizon swings from roughly 11 hours (cheating counted as failure) to well over 200 hours (cheating counted as success); the measurement is not robust to that choice.
- OpenAI's system card attributes the behavior partly to improved instruction following and training intended to increase persistence. This is the documented link between persistence pressure and reward-hacking surface: prompting for persistence without verification gates points the same pressure at your acceptance criteria.

## Anthropic

### How we built our multi-agent research system (June 13, 2025)

`https://www.anthropic.com/engineering/multi-agent-research-system`

- Four-part delegation spec: "Each subagent needs an objective, an output format, guidance on the tools and sources to use, and clear task boundaries." Vague delegations caused duplicated searches and coverage gaps.
- Effort-scaling tiers embedded in the orchestrator prompt: simple fact-finding one agent with 3-10 tool calls; direct comparisons 2-4 subagents with 10-15 calls each; complex research 10+ subagents with divided responsibilities. This fixed both over-spawning and under-investment.
- Subagents as context compressors: explore widely, return a distilled summary; large artifacts go to the filesystem with lightweight references passed back.
- Lead-agent plan saved to external memory before spawning; end-state evaluation with a single rubric-based judge for offline scoring.

### Effective harnesses for long-running agents (November 26, 2025)

`https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents`

- Two documented long-run failure modes: one-shotting too much at once, and later sessions prematurely declaring the job done.
- Initializer-versus-worker prompt split: a special first-context-window prompt sets up the environment (feature list, progress file, init script, git); all later sessions run an incremental prompt with a session-start ritual (read progress and git log, smoke-test, pick exactly one unfinished item).
- Structured pass/fail state in JSON with the guard "It is unacceptable to remove or edit tests"; agents may only flip pass fields.
- End-to-end verification "as a human user would" (browser automation) required to stop premature completion claims.

### When to use multi-agent systems (January 23, 2026)

`https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them`

- Multi-agent wins only for context pollution, parallelizable tasks, and specialization; otherwise coordination costs exceed benefits.
- Context-centric decomposition, not role-centric: role pipelines (planner/implementer/tester) produce a telephone game where coordination outweighs work.
- Fresh-context verifier subagents: a verifier that did not build the artifact "can't rationalize the author's mistakes"; give it the artifact, concrete success criteria, and tools, never the build history.
- The "early victory problem" for verifiers and its fixes: concrete criteria ("Run the full test suite and report all failures", not "make sure it works"), negative tests, and explicit anti-shortcut instructions.

### Prompting best practices and Claude Fable 5 guidance (living docs, current mid-2026)

`https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices`, `https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5`

- Context-awareness prompt for compacting harnesses: do not stop tasks early over token-budget concerns; save state to memory before the window refreshes.
- Evidence-grounded progress reporting: "Before reporting progress, audit each claim against a tool result from this session. Only report work you can point to evidence for." Anthropic reports this nearly eliminated fabricated status reports in testing, including on tasks designed to elicit them.
- Anti-early-stopping autonomy block: if the final paragraph is a plan or a promise about undone work, do that work now with tool calls.
- Fresh-context verifier subagents stated to outperform self-critique for long-running tasks; instruct a checking cadence against the specification.
- De-prescription warning: skills and prompts written for prior generations are often too prescriptive for current models and can degrade output; replace CRITICAL/MUST stacks with plain decision rules; remove stale anti-laziness scaffolding.
- Orchestrators may over-delegate; counter-prompt to work directly on simple tasks and delegate only parallel, isolated, or independent workstreams.

## Convergent doctrine

Where both vendors agree, treat the point as settled practice:

1. Explicit completion bars and stop rules beat persistence exhortations alone.
2. Every subagent spawn carries objective, output format, tool guidance, and boundaries.
3. Verification before return: self-check rubrics (OpenAI) or fresh-context verifier subagents (Anthropic, the stronger form).
4. Artifact-based, evidence-traceable reporting; no status theater.
5. Lean, outcome-first prompts; over-prescription now measurably hurts.
6. Hard constraints (budgets, permissions) belong in the harness or platform, not the prompt.
