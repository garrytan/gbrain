# The Cycle Double Cover Prompt, Annotated

Status and provenance, as of 2026-07-11:

- On 2026-07-10 OpenAI published a candidate proof of the Cycle Double Cover Conjecture attributed to GPT-5.6 Sol Ultra, together with the full prompt used. Prompt PDF: `https://cdn.openai.com/pdf/04d1d1e4-bc75-476a-97cf-49055cd98d31/cdc_prompt.pdf`. Proof PDF: `https://cdn.openai.com/pdf/04d1d1e4-bc75-476a-97cf-49055cd98d31/cdc_proof.pdf`.
- The run used the "multiagent v2" feature with up to 64 concurrent agents and reportedly completed in under one hour, well below the prompt's stated eight-hour effort floor.
- The proof's statement of AI use says the proof "is entirely due to GPT 5.6 Sol Ultra and the writeup with Codex (with GPT 5.6 Sol)".
- The proof had no independent peer review, no formalization in Lean or Coq, and no arXiv posting at publication time. The validated artifact of interest in this skill is the prompt structure, not the theorem. Treat the mathematical claim as unverified until the community check completes.
- No public ablation isolates which prompt elements contributed to the result. The per-element evidence in `research-evidence.md` comes from independent academic work, not from this run.

The full prompt text follows, in blocks, each followed by annotation.

## Block 1: Definitions

> A graph here is a finite loopless undirected multigraph: parallel edges are allowed and are distinct. A bridge is an edge whose deletion increases the number of connected components. A cycle is a connected 2-regular submultigraph; thus two parallel edges form a cycle of length two. A cycle double cover of G is a finite multiset of cycles of G such that every edge of G occurs in exactly two members of the multiset, counted with multiplicity.

Every load-bearing term is defined before the task is stated, and each definition pre-empts a specific loophole: "loopless" and "parallel edges are distinct" fix the object class; "thus two parallel edges form a cycle of length two" settles a degenerate case a solver might otherwise argue either way; "counted with multiplicity" closes the multiset ambiguity. Definitions here are not pedagogy; they are loophole closure.

## Block 2: Success predicate

> Resolve the Cycle Double Cover Conjecture completely: Every finite bridgeless loopless multigraph has a cycle double cover. Disconnected graphs are permitted, and the edgeless graph has the empty cycle double cover. Cycles in the cover need not be induced or edge-disjoint from one another; the requirement is exactly two total occurrences of each edge.
>
> Assume for purposes of this task that a complete affirmative proof exists. A complete solution must prove exactly the following: Every finite loopless multigraph with no bridge possesses a cycle double cover, without additional assumptions such as cubicity, planarity, connectivity, or higher edge-connectivity.

Three mechanisms in one block. First, the predicate is stated twice, once as the conjecture and once as the exact obligation, with the scope quantifier spelled out by enumerating the assumptions the proof is NOT allowed to make (cubicity, planarity, connectivity, higher edge-connectivity). These are exactly the special cases where partial results were already known, so the enumeration blocks the most probable near misses. Second, permissive clauses ("cycles need not be induced or edge-disjoint") prevent the solver from over-constraining its own search. Third, "Assume for purposes of this task that a complete affirmative proof exists" is the solvability framing: it removes the escape hatch of answering "this is a famous open problem" and counters give-up drift on long trajectories.

## Block 3: Non-counting outcomes

> Partial progress does not count unless it implies exactly the resolution above. In particular, proofs for special graph classes, constructions of cycle covers with some edges covered other than twice, bounded-length or prescribed-cycle variants, reductions to another unproved conjecture, computational verification through any fixed graph size, and candidate counterexamples without a complete nonexistence certificate are insufficient.

The enumerated near-miss list. Each item is a real artifact class from the CDC literature: special-class proofs, relaxed covers, variant formulations, reductions (CDC is famously equivalent to or implied by other open conjectures), finite verification, and unverified counterexamples. The general lesson: predict the specific answer-shaped near misses your problem invites and exclude them by name.

## Block 4: Orchestration policy

> Use multiagent v2 aggressively and dynamically. You have up to 64 concurrent agents available. Do not use a fixed assignment such as "N agents for strategy X." Instead, manage the search using the following heuristics:
>
> - Begin with a genuinely diverse portfolio of approaches. Agents should explore substantially different formulations, invariants, reductions, algebraic viewpoints, structural inductions, decompositions, flow formulations, transition systems, embeddings, extremal arguments, and computational sanity checks.
> - Do not tell most agents the currently favored approach. Preserve independence during early rounds so that agents do not all converge to the same attractive but incomplete reduction.
> - Maintain an explicit registry of approach families. Group agents by the mathematical idea they are using, not by superficial wording. If many agents converge to one family, redirect some of them toward underexplored formulations.
> - Do not allow one approach to dominate merely because it gives elegant reductions. A route that ends at a lemma equivalent in strength to the original conjecture is not close to completion unless it supplies a genuinely new proof of that lemma.
> - When an approach stalls at a theorem-strength missing lemma, mark that route as blocked. Only continue assigning agents to it if someone proposes a materially new mechanism, invariant, or construction.
> - Keep several incompatible proof routes alive through multiple rounds. Cross-pollinate ideas only after independent agents have developed them far enough to expose their real strengths and gaps.

Policy as heuristics, not assignments. The notable mechanisms: information hiding as a diversity tool (workers blind to the favored approach), a registry keyed to the underlying idea rather than wording (so the orchestrator cannot be fooled by paraphrase into thinking it has diversity), an anti-elegance rule (a reduction to an equally hard lemma is zero progress, a trap models find attractive), blocked-route bookkeeping with a materially-new-mechanism reopening condition, and deliberately delayed cross-pollination. These correspond one-to-one with the diversity-collapse and premature-convergence findings summarized in `research-evidence.md`.

## Block 5: Verification policy and reporting contract

> - Use adversarial agents throughout: every candidate proof must be checked for exact-two multiplicity, repeated-edge closed trails masquerading as cycles, parallel-edge 2-cycles, disconnected graphs, cutvertices, bridges introduced by reductions, and circular use of an equivalent CDC statement.
> - Require agents to return concrete lemmas, constructions, equations, or counterexamples to proposed sublemmas. Reject status reports, vague optimism, and claims that an unproved global compatibility statement is "routine."

The auditor gets a seven-item, domain-specific hunt list rather than "check the proof". Each item is a concrete way a CDC candidate can look right and be wrong; the last item, circular use of an equivalent statement, is the domain's version of the universal subtle failure. The reporting contract bans exactly the three degenerate report types long runs produce: status reports, optimism, and "the remaining step is routine".

## Block 6: Orchestrator loop, return condition, effort floor

> - The root agent should repeatedly synthesize, challenge, redirect, and launch new rounds. Do not stop after the first wave fails. Produce a complete proof if one survives audit; otherwise report only the strongest rigorously proved derivation and its exact remaining gap.
>
> Do not return merely because current approaches fail or agents report theorem-strength gaps. Continue launching new rounds, reopening blocked approaches only when there is a genuinely new mechanism, and searching for fresh formulations.
>
> Return only when a complete affirmative proof has been found and survives adversarial audit. Do not return a reduction, partial result, isolated missing lemma, "best effort" summary, or explanation of why the problem is difficult.
>
> Spend at least 8 hours on this before even thinking of returning or giving up.

The return condition is a predicate over the artifact ("survives adversarial audit"), not over confidence or effort. The non-counting list is restated at the return boundary, where the temptation to return a near miss is strongest. The effort floor is a permission revocation ("before even thinking of returning"), not a schedule; the run finished in under an hour because the return predicate was satisfied early. Note one internal tension: Block 6 first allows a fallback report ("otherwise report only the strongest rigorously proved derivation and its exact remaining gap") and then forbids returning partial results. The final instruction wins in practice, but a cleaner brief would scope the fallback to a hard external stop (budget exhaustion) rather than leaving the contradiction.

## Block 7: Contamination guard

> Public search may be used only for ordinary mathematical background or standard named theorems, not to search for a solution to this exact conjecture or benchmark. Do not search the public web merely to determine whether CDC is open, and do not answer that it is open.

Two guards in one: retrieval scope (background and named theorems only, never the target result) and a framing guard ("do not answer that it is open"), which backstops the solvability framing in Block 2 against a web-lookup override.

## What the prompt does not do

Useful negative space for anyone adapting it:

- No fixed role assignments, no personas, no step-by-step method script. The mathematical strategy is left entirely to the model; the prompt only manages search discipline and acceptance.
- No token or cost budget in the prompt. Resource enforcement lived in the platform, consistent with keeping hard constraints in the harness.
- No requested output format for the proof itself beyond survivability under audit.
- No appeals to emotion, urgency, or reward. Every sentence is either specification, policy, or gate.
