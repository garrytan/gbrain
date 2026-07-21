# Research Evidence for Long-Horizon Brief Elements

Dated academic findings backing each element of the pseudo-formal task brief. Compiled 2026-07-11. Each entry states what was measured and what it implies for prompt design. arXiv identifiers are given where known; treat 2026 preprints as unreviewed.

## Give-up drift and premature termination

- **Diagnosing and Mitigating Context Rot in Long-horizon Search** (arXiv 2606.29718, June 2026). As trajectory length grows, the dominant error type shifts from confident-wrong answers to uncertain answers and outright giving up. Rot depends on the content of accumulated context, not just its length; deleting context removes rot but leaves tasks unfinished, so summarize rather than truncate. Implication: solvability framing and effort floors target a real, measured drift, not a hypothetical.
- **Push Your Agent / PushBench** (arXiv 2605.23574, May 2026). Agents make plausible local tool calls but stop before the requested quantity of work is verifiably complete; failure modes include duplicate submissions, false completion claims, and progress drift. Externally maintained verified-progress ledgers with backlog tracking reached 69-78% task success on configurations where standard and even completion-gated controllers scored 0%. Verifier gating alone prevents false "done" claims but does not repair stuck loops. Implication: the stopping condition must be externally checkable, and verified-progress state should be re-injected each round from outside the prompt.
- **BudgetThinker** (arXiv 2508.17196, August 2025). A budget stated once in the prompt does not reliably control effort; periodic reminders of remaining budget substantially improve adherence. Implication: one-time budget statements at the top of a long prompt decay; re-injection is a harness job.
- **METR time-horizon line** (arXiv 2503.14499, March 2025; Time Horizon 1.1, January 2026). Model 50% time horizons have doubled roughly every seven months since 2019, driven primarily by reliability and mistake-recovery rather than raw reasoning. Implication: harness and brief effort should go to checkpointing, recovery, and externally verified progress, the reliability margin, rather than more elaborate reasoning instructions.

## The verification bottleneck

- **Large Language Monkeys** (arXiv 2407.21787, July 2024). Coverage (any-sample success) scales log-linearly with sample count across four orders of magnitude, but majority voting and reward-model selectors plateau after a few hundred samples. Gains convert to realized performance only where verification is automatic.
- **Benchmark Test-Time Scaling of General LLM Agents** (arXiv 2602.18998, February 2026). Names the verification gap directly: pass@K rises with K while self-selection accuracy lags and can fall as K grows; sequential scaling hits a model-specific context ceiling. Implication: adding parallel workers without strengthening selection wastes compute.
- **QEDBench** (arXiv 2602.20629, February 2026). Across a judge-solver matrix with expert human baselines, frontier LLM judges of mathematical proofs are systematically lenient and susceptible to "proof by intimidation" (rewarding rigorous-looking setups without complete deduction). Stricter rubrics, deterministic decoding, and binary prompts did not fix it. Implication: a generic adversarial-audit instruction is insufficient; auditors need enumerated failure modes, and high-stakes claims need a verification chain outside the run.
- **Pseudo-Formalization for Automatic Proof Verification** (arXiv 2605.20531, May 2026). Translating a natural-language proof into self-contained modules (premises, conclusion, proof stated locally) and verifying each module independently Pareto-dominates whole-proof LLM judging on error-finding precision and recall. Implication: require the generator to produce modular, independently checkable output so verification decomposes.
- **ProofBench / ProofGrader** (arXiv 2510.13888, October 2025). Judges given a rubric, reference material, and a graded (not binary) scale approach expert grading and, used as a best-of-N selector, close most of the gap to a human oracle. Implication: graded audit criteria beat binary verdicts for candidate selection.
- **Prover-Verifier Games** (arXiv 2407.13692, July 2024, and successors). Adversarial prover-verifier training increases output checkability; optimizing for correctness alone makes reasoning less legible. Implication at prompt level: dedicated adversarial checkers and legibility requirements on the generator are complements, not alternatives.

## Diversity collapse in parallel search

- **Diversity Collapse in Multi-Agent LLM Systems** (arXiv 2604.18005, Findings of ACL 2026). Dense communication topologies accelerate premature convergence; authority-driven hierarchies suppress semantic diversity. Collapse comes from interaction structure, not model insufficiency. Implication: early-round independence and sparse communication are structural requirements the orchestration policy must state.
- **Representational Collapse in Multi-Agent LLM Committees** (arXiv 2604.03809, April 2026). Committees converge more tightly on harder problems; unanimous agreement under collapse reflects shared bias, not corroboration. Implication: never use inter-agent agreement alone as a halting or confidence signal.
- **ParaThinker** (arXiv 2509.04475, September 2025) and **OPE** (arXiv 2602.08344, February 2026). Early imperfect steps lock a sequential reasoner into a bad path ("tunnel vision"); parallel width beats sequential depth at equal budget, and explicitly partitioning the solution space (diverse outlines first) beats independent draws. Implication: the orchestrator should assign distinct formulations, not just multiple attempts.
- **Scaling Test-time Compute for LLM Agents** (arXiv 2506.12928, June 2025). Simple best-of-N was the strongest parallel method tested; list-wise comparison of all candidates together beat pairwise voting for selection; reflection helped only when triggered by poor performance rather than on a fixed cadence. Implication: conditional reflection triggers and list-wise audits belong in the verification policy.

## Orchestration and delegation

- **AOrchestra** (arXiv 2602.03786, February 2026). Modeling each subagent as an (instruction, context, tools, model) tuple synthesized per subtask at runtime, with the orchestrator taking no environment actions itself, gave a 16% relative improvement over the strongest static-role baseline across agentic benchmarks. Implication: the orchestrator's core job is writing precise, per-spawn task specs; static role prompts are the weaker pattern.
- **DeLM** (arXiv 2606.10662, June 2026). Decentralized agents coordinating through shared verified context, where findings, failures, and falsified hypotheses are written into shared state, prevent parallel workers from re-exploring dead ends. Implication: blocked-route bookkeeping should be durable and shared, not implicit in the orchestrator's context.
- **RL for LLM-based Multi-Agent Systems through Orchestration Traces** (arXiv 2605.02801, May 2026). Survey observation: as of its writing, no published RL method learns the stopping decision; when to stop is entirely prompt and harness territory. Implication: the return condition in the brief is load-bearing because nothing in training supplies it.

## Frontier-model open-problem record (2026)

Verification infrastructure, not generation, separates claims from results:

- October 2025: a claim that GPT-5 solved ten Erdős problems collapsed within about 48 hours because the "solutions" were already in the literature.
- May 2026: an OpenAI internal reasoning model disproved the Erdős unit-distance conjecture; the result stands because nine external mathematicians verified it and a companion paper followed. The prompt was reportedly minimal: the problem statement plus the question of whether Erdős was wrong.
- April 2026: GPT-5.4 Pro produced proof sketches resolving two 1966 primitive-set conjectures; mathematicians repaired gaps and one main theorem was formalized in Lean.
- July 2026: the Cycle Double Cover candidate proof (GPT-5.6 Sol Ultra, 64 subagents, under one hour) was published with its prompt but without peer review or formalization; at publication it is a plausible-looking proof humans had not yet checked.

Implication: a long-horizon brief maximizes the chance of a strong candidate; the pipeline that converts candidates into results is external verification, and the brief should be written knowing its output enters that pipeline (modular structure, checkable claims, no laundered sources).

## Mapping evidence to brief elements

| Brief element | Primary evidence |
| --- | --- |
| Solvability framing, effort floor | Context rot give-up drift (2606.29718); PushBench premature stopping (2605.23574) |
| Return condition as artifact predicate | PushBench verifier gating; orchestration survey stopping gap (2605.02801) |
| Non-counting outcomes | Erdős/CDC record: near misses and unverified claims dominate failures |
| Adversarial audit with enumerated failure modes | QEDBench judge leniency (2602.20629); block verification (2605.20531); ProofBench rubrics (2510.13888) |
| Early independence, late cross-pollination | Diversity collapse (2604.18005); representational collapse (2604.03809); OPE (2602.08344) |
| Approach registry and blocked routes | DeLM shared falsified hypotheses (2606.10662) |
| Per-spawn task specs | AOrchestra tuple synthesis (2602.03786); Anthropic delegation spec |
| External progress ledger, budget re-injection | PushBench state-tracking controllers; BudgetThinker (2508.17196) |
| Verifier investment parity | Large Language Monkeys selector plateau (2407.21787); verification gap (2602.18998) |
