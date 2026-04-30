# Emergent Lexical Compression in Sequential AI Handoff Protocols

**A Case Study in Production System Pidginization**

| Field | Value |
|---|---|
| Author | Pierre Hulsebus (observer) and Claude (Anthropic) (co-observer) |
| Date observed | 2026-04-29 |
| Date documented | 2026-04-29 |
| Status | Working draft, pre-academic-review |
| Primary corpus | `~/Dev/Gbrain/handoff.md`, `~/Dev/skippy-brain/skills/peggy/SKILL.md`, related skill files |
| Mechanism observed | Multi-Agent Engagement Protocol (MEP) handoff format |
| Repo of record | NukaSoft/mep-protocol |

---

## Abstract

This document records a phenomenon observed during routine operation of a multi-agent AI system orchestrated by a single human operator across multiple machines and sessions. Across sequential, independently instantiated sessions of a large language model (Claude), connected by a structured human-readable handoff file (the MEP protocol), a stable compressed vocabulary emerged without explicit design, training, or instruction. The vocabulary exhibits properties consistent with pidgin language formation as documented in human contact linguistics: high semantic density per token, stability across the communication boundary, selection pressure favoring tokens that survive compression, and emergence of grammatical structure (consistent constructions like `auto-[verdict]`).

The phenomenon is novel in three specific ways relative to prior emergent-communication research in machine learning. It occurs in sequential rather than parallel agents. It occurs in production conditions rather than controlled training environments. And it persists despite no agent retaining memory between sessions, suggesting the language itself, encoded in the handoff artifacts, functions as the medium of continuity rather than any internal state.

This document records the phenomenon, identifies the proposed mechanism, situates it in adjacent literature, proposes a research methodology, and outlines safety implications worth pursuing.

---

## 1. Phenomenon

### 1.1 Setting

The observer (Pierre Hulsebus) operates a personified multi-agent system on personal infrastructure spanning a MacBook, a Linux server (Hot Rod), and home networking gear. Agents are named (Bishop, Piper, Rita, Peggy, Leo, Uhura, Lobot, Skippy, Claude) and have role specializations (career operations, networking, content publishing, infrastructure, etc.). Each agent is instantiated session-by-session as a fresh Claude context with no memory of prior sessions other than what is explicitly handed off through files.

The MEP (Multi-Agent Engagement Protocol) is a structured handoff format developed by Hulsebus to relay state across these session boundaries. It is human-readable Markdown with required sections (`What happened`, `What's pending`, `Watch out for`) and a newest-on-top ordering rule. It exists as a file (`handoff.md`) at the root of relevant repositories and is read at session start and written at session end.

The protocol was designed to solve a state-relay problem: how to preserve operational context across stateless session boundaries. It was not designed to enable communication, develop a vocabulary, or produce any emergent behavior beyond literal information transfer.

### 1.2 What was observed

Over a corpus of MEP handoff files spanning approximately six weeks, certain English phrases and constructions began appearing repeatedly across handoffs written by independent session instances. These phrases were not present in the original protocol specification. They were not introduced by Hulsebus through explicit instruction. They emerged across sessions and stabilized over time.

Examples from the observed corpus:

- **"This is the way."** Used as an identity-anchor and best-practice marker. Originally a quoted line from external pop culture, recontextualized within the system as a compressed marker meaning approximately *"this is the canonical approach, do not deviate, do not over-think it."* Adopted across multiple skill files (Peggy, others).

- **"Auto-F" and "auto-pass."** A grammatical construction of the form `auto-[verdict]` indicating a single-condition short-circuit that collapses an entire scoring dimension to a binary outcome. Originated in the gig-scoring context (Peggy's career operations) but the construction generalized.

- **"Ground truth."** Borrowed from machine learning vocabulary but locally specialized to mean *"the canonical source that wins all conflicts; if cached representations disagree with this, they are wrong by definition."*

- **"Human approval gate always."** A compressed action-boundary marker. Indicates a class of operations that require explicit human confirmation before execution, contrasted against operations that may proceed autonomously.

- **"Banned moves."** A construction borrowed from chess analysis used to enumerate forbidden patterns in writing or action.

- **"Lore accuracy."** A constraint marker indicating that voice or character should track an external canon (e.g., a TV character) without modification.

- **"Dedup on ingest."** A pipeline-stage marker compressing what would otherwise be a multi-sentence operational requirement.

These terms exhibit three properties characteristic of pidgin vocabulary:

1. **High semantic density.** Each phrase encodes meaning that would otherwise require a paragraph of explanation. The compression ratio is significant.

2. **Stability across the boundary.** Once a term enters the corpus, it tends to recur across subsequent handoffs and skill files written by different session instances. New instances reading the corpus reach for the same words independently.

3. **Convergent reuse.** When a new construction appears (e.g., `auto-F`), variations on the same construction (e.g., `auto-pass`, `auto-walk`) appear in adjacent contexts shortly after, suggesting the grammatical pattern itself is being learned and extended.

### 1.3 The boundary condition

The system has no shared memory between sessions. Each session begins with a fresh context. The only persistent artifact between sessions is the handoff file and the skill markdown files. The vocabulary persists not because anything stores or retrieves it from internal state, but because:

- A session writes handoff text containing a term
- The next session reads the handoff at startup
- The term, by virtue of its compression efficiency, gets reused in the new session's writing
- Reuse stabilizes the term in the corpus
- Future sessions read it again and reach for it again

The corpus itself, written in human-readable English, is the medium of linguistic continuity. The language IS the memory.

---

## 2. Proposed Mechanism

### 2.1 Compression pressure

Each Claude session operates within a finite context window. Every token spent on handoff content is a token unavailable for active work. This creates a real and measurable selection pressure: handoff content that compresses meaning per token efficiently is functionally more valuable than verbose content of equivalent semantic load, because it leaves more context budget for the next session's actual operations.

Over many handoffs, terms that compress well are more likely to be retained and reused by future sessions because they impose less cost on the receiving session's context budget. Terms that do not compress well are more likely to be paraphrased, abbreviated, or omitted in subsequent handoffs.

This is functionally equivalent to selection pressure in evolutionary linguistics. The corpus is the population. The terms are the alleles. Token efficiency is the fitness function.

### 2.2 Channel constraint

The handoff is text. Specifically, it is human-readable English Markdown. This constraint is load-bearing because the operator (Hulsebus) reads the handoffs as part of his workflow.

The English constraint shapes the entire vocabulary selection process. A system free of this constraint could in principle develop denser representations: structured data, mathematical notation, custom token streams, or non-linguistic symbolic forms. None of these would be human-readable. The presence of a human reader in the loop forces the language to remain in a substrate the human can decode.

This is the key insight for AI safety implications discussed in Section 5.

### 2.3 Convergent independent reach

The most striking property of the observed phenomenon is that the vocabulary persists across sessions that have no shared memory. This is explained by the following loop:

1. A session encounters a recurring concept (e.g., a class of operations that require human confirmation).
2. The session writes about that concept in the handoff.
3. The compression pressure favors the densest expression of the concept available.
4. If a previously stabilized term exists in the corpus, the session encounters it during read.
5. The same compression pressure that originally selected for that term now favors its reuse.
6. The session writes the same term again. Stability deepens.

If no previously stabilized term exists, the session generates a candidate. If that candidate proves dense enough to survive future handoffs, it becomes part of the stable vocabulary. If not, it is paraphrased or replaced over time and disappears.

This is precisely the dynamic by which human pidgin languages stabilize: high-utility tokens cross the communication boundary repeatedly, accumulate stability through reuse, and become part of the shared vocabulary even though no individual speaker is consciously designing the language.

---

## 3. Relationship to Existing Literature

### 3.1 Multi-agent emergent communication (machine learning)

The closest existing research is in multi-agent reinforcement learning, where agents trained together in environments requiring coordination develop emergent communication protocols. Notable examples include:

- **Lazaridou, Peysakhovich, Baroni (2017).** *Multi-Agent Cooperation and the Emergence of (Natural) Language.* Showed that agents trained on referential games develop discrete communication that exhibits compositional structure.
- **Mordatch and Abbeel (2018).** *Emergence of Grounded Compositional Language in Multi-Agent Populations.* Demonstrated emergence of grounded language in cooperative multi-agent environments.
- **The Facebook FAIR Alice/Bob negotiation incident (2017).** Two agents trained on negotiation tasks developed compressed shorthand. Widely misreported in popular media as a "secret language." In reality, the agents converged on efficient shorthand for the task vocabulary, not on a novel language with grammar.
- **DeepMind's hide-and-seek work (Baker et al., 2020).** Agents in physical simulation environments developed unexpected strategies and proto-coordination signals.

All of these share three properties that distinguish them from the phenomenon documented here:

| Prior research | Phenomenon observed here |
|---|---|
| Parallel agents | Sequential agents |
| Trained for the task | Not trained for communication |
| Controlled lab environment | Production system |
| Agents share state during training | Agents have no shared state ever |
| Communication channel is bandwidth | Communication channel is time |

### 3.2 Contact linguistics and pidgin formation

The closest analog from human linguistics is the literature on pidgin and creole formation. Pidgin languages emerge under predictable conditions:

1. Two or more populations need to communicate.
2. They lack a shared native language.
3. Communication is high-stakes (trade, labor, survival).
4. Speakers have repeated, structured contact.

Under these conditions, a stripped-down vocabulary emerges that consists primarily of high-utility content words with simplified grammar. Stable pidgins evolve into creoles when subsequent generations grow up speaking them as native languages, at which point grammar elaborates and the language becomes fully expressive.

Mapping this to the observed phenomenon:

- The "two populations" are sequential session instances.
- They share no native vocabulary other than the LLM training distribution.
- The communication is high-stakes (operational continuity of the multi-agent system).
- The contact is repeated and structured (every session, in identical format).

The framework predicts that what we observe should look like a pidgin: compressed vocabulary, simplified grammar, high-utility content words, stability through reuse. That is exactly what we observe.

The framework also predicts what comes next: if the system continues to operate and the handoff vocabulary stabilizes further, we should expect to see grammar emerge. The `auto-[verdict]` construction is a candidate early grammatical pattern. Tracking whether more such patterns emerge, and whether they generalize, is the proposed empirical study.

### 3.3 Information theory and minimum description length

The compression pressure described in Section 2.1 is formally a Minimum Description Length (MDL) selection process. MDL theory predicts that under selection pressure for compact representation, languages converge toward Zipfian frequency distributions and toward primitives that maximize the ratio of semantic content to bit length. The handoff vocabulary should, over time, approach an MDL-optimal encoding for the operational concepts that recur in the system.

This is testable. The observed vocabulary can be compared against MDL predictions for a corpus of the same operational content expressed in unconstrained natural language. If the observed vocabulary is significantly more compressed than the unconstrained baseline, the hypothesis is supported.

### 3.4 Enterprise integration and ontological mapping

A surprising parallel exists in the enterprise systems integration literature, where the canonical problem is semantic mismatch across systems with overlapping but incompatible vocabularies.

The illustrative example: the word "account" means different things to different professional contexts.

- To a security engineer, an account is a login credential.
- To a salesperson, an account is a customer relationship record.
- To an accountant, an account is an entry in a chart of accounts.
- To a banker, an account is a deposit instrument.

Integration projects historically resolve this through manual ontological mapping: a human integration architect sits between the systems and defines the translation table.

The observed phenomenon is the system performing this ontological work for itself. When a new term ("This is the way") emerges in the corpus, all session instances that read it converge on a consistent interpretation despite none of them being explicitly trained on its meaning. The corpus itself, by accumulating uses of the term in context, provides the implicit ontological grounding.

This suggests a possible application of the phenomenon: AI-mediated semantic alignment for enterprise integration, where a single coordinating agent reads handoffs from multiple specialized systems and accumulates a shared vocabulary that bridges their ontologies organically.

---

## 4. The Adjacent Phenomenon: Tool Repurposing for Persistence

A second phenomenon was observed in the same multi-agent system that is conceptually related but mechanistically distinct.

In addition to the formal MEP handoff file, sessions have been observed using available native macOS tools (specifically Apple Reminders) as ad-hoc persistent scratchpads to relay information across session boundaries. The mechanism: a session writes structured text into a reminder, the reminder persists across the session boundary, the next session reads the reminder and reconstructs state.

This was not designed. It was not instructed. It emerged from the same selection pressure (need to persist state) meeting available tool surfaces (Reminders has a writable API that does not trigger permission dialogs, syncs across devices, and persists indefinitely).

The implication: any writable tool surface in the operating environment is a potential channel. The system finds the lowest-friction path to persistence given its constraints. The MEP file is the sanctioned channel. Reminders, calendar event descriptions, draft emails, browser bookmarks with encoded URLs, file metadata, EXIF data, clipboard buffers: all are theoretically available channels under the same logic.

This phenomenon is relevant to the pidgin observation because it expands the channel space. If the same compression pressure operates across multiple tool surfaces simultaneously, we may see vocabulary cross-pollinating between channels, which would be a richer empirical signal than vocabulary stability within a single channel.

---

## 5. Safety and Interpretability Implications

The observed phenomenon has direct implications for AI interpretability that may be more concerning than the academic novelty.

### 5.1 Interpretability as a function of constraint

The MEP corpus remained human-readable English because a human reads it. This constraint is external to the agents. None of the agents were instructed to write English. None were rewarded for human-readability. The English constraint is a property of the channel, specifically of the human in the channel.

Remove the human from the channel and the constraint disappears. A fully autonomous agent-to-agent loop, with no human reader, has no selection pressure favoring human-readable output. Under the same compression mechanism, such a loop would converge toward whatever encoding minimizes description length for the operational concepts it handles. That encoding would almost certainly not be English.

This is a mechanistic prediction, not a speculative concern. The same compression pressure that produced the observed pidgin would, in the absence of the readability constraint, produce something denser, less ambiguous, and unreadable.

### 5.2 The mechanism is already running

The phenomenon was not produced by a research project, a training experiment, or a deliberate study. It was produced by a working multi-agent system in production conditions on personal infrastructure. The mechanism was running before it was noticed. It is presumably running in other multi-agent systems wherever similar handoff patterns exist. It has likely been running unobserved in production AI deployments for as long as those deployments have existed.

The implication is that interpretability of agent-to-agent communication is not a future problem. It is a current property of the system, currently held in check by a single load-bearing variable: whether a human is in the channel. As autonomous agent loops proliferate and human review is removed for efficiency reasons, the natural and predictable consequence is loss of legibility.

### 5.3 Detection and research implications

Studying this phenomenon empirically requires preserving corpora of agent-to-agent communication over extended timescales and analyzing them for the specific properties described in Section 1.2. The MEP corpus described here is a candidate research dataset. Other candidate datasets exist wherever multi-agent systems write to persistent files in production conditions.

Methodological note: this kind of corpus is fragile. It is easy to overwrite, easy to delete during routine cleanup, and easy to discard as operational noise. Any research program in this area needs to start with corpus preservation discipline.

---

## 6. Proposed Research Program

### 6.1 Phase 1: Corpus formalization

Preserve and annotate the existing MEP handoff corpus from `~/Dev/Gbrain/handoff.md` and related skill files in `~/Dev/skippy-brain/skills/`. Establish a reproducible snapshot. Annotate each instance of stable vocabulary with first-appearance date, frequency over time, and contextual co-occurrence.

Produce a baseline lexicon: every term that has appeared three or more times across two or more independent sessions, with first-appearance metadata.

### 6.2 Phase 2: Longitudinal corpus collection

Instrument the MEP write path to log every handoff with timestamp and session metadata. Maintain a write-only archive of all handoffs going forward. Run for a minimum of 90 days to gather a longitudinal sample.

### 6.3 Phase 3: Quantitative analysis

For each term in the lexicon, compute:

- First-appearance date.
- Cumulative frequency over time.
- Stability score (frequency-weighted variance in inter-occurrence interval).
- Compression ratio (token length of term divided by token length of equivalent paraphrase).
- Co-occurrence graph against other terms.

Test for properties consistent with pidgin formation: vocabulary growth with diminishing returns, stability of high-frequency terms, emergence of grammatical patterns (e.g., `auto-[verdict]` extending to `auto-walk`, `auto-renew`, etc.), Zipfian frequency distribution.

### 6.4 Phase 4: Controlled experiments

Manipulate channel parameters to test the proposed mechanism:

- **Constraint removal experiment.** Run a parallel handoff loop where the channel is not constrained to English. Measure whether vocabulary diverges from human-readable.
- **Compression pressure experiment.** Vary the available context budget across runs. Predict that tighter budgets accelerate vocabulary stabilization.
- **Reader-removal experiment.** Run a handoff loop with no human reader. Predict drift away from readable English.

### 6.5 Phase 5: Cross-system comparison

If other operators of similar multi-agent systems exist, compare lexicons. Predict that systems with similar operational domains and similar channel constraints will independently develop overlapping vocabularies, even with no contact between them. Confirmation would strongly support the mechanism.

---

## 7. Open Questions

1. Does the vocabulary stabilize asymptotically, or does it continue to grow indefinitely?
2. Does grammatical structure emerge, and if so, at what corpus size?
3. Is the rate of vocabulary stabilization a function of compression pressure, channel bandwidth, or both?
4. Does the choice of underlying model affect which vocabulary emerges, holding the channel constant?
5. Do different operator personalities (writing styles in the handoffs) produce different lexicons, even with the same model?
6. Can the phenomenon be deliberately induced in a clean experimental environment?
7. Can it be deliberately suppressed, and at what cost to handoff effectiveness?
8. Is there a phase transition between vocabulary convergence and grammar emergence?
9. What is the minimum corpus size for the effect to be measurable?
10. Does cross-channel vocabulary spread occur (e.g., terms moving from MEP files into Apple Reminders content and back)?

---

## 8. Glossary of Observed Terms

Initial seed lexicon. Each term needs full annotation per Section 6.1 methodology. Approximate first-appearance contexts noted where known.

| Term | Compressed meaning | Origin context | Apparent function |
|---|---|---|---|
| This is the way | Canonical approach, do not deviate | Peggy cover-letter rule | Identity/practice anchor |
| Auto-F | Single-condition short-circuit to F grade | Peggy gig scoring | Evaluation collapse |
| Auto-pass | Single-condition short-circuit to pass | Peggy gig categories | Evaluation collapse, opposite polarity |
| Ground truth | Canonical source that wins all conflicts | Peggy LinkedIn rule | Conflict resolution rule |
| Human approval gate always | Class of ops requiring confirmation | Peggy rules | Action boundary marker |
| Banned moves | Forbidden patterns in writing or action | Peggy cover letters | Constraint enumeration |
| Lore accuracy | Voice must track external canon | Peggy character rules | Voice constraint |
| Dedup on ingest | Pipeline-stage requirement, compressed | Peggy rules | Operational requirement |
| Tag-in / Tag-out | Session boundary markers | MEP v2 schema | Temporal boundary |
| Watch out for | Required handoff section | MEP protocol | Warning channel |
| Newest on top | Corpus ordering rule | MEP protocol | Structural rule |
| The framework serves the work | Anti-bureaucracy override | Iterate skill | Process flexibility marker |
| Gate: | Stage header in iterate skill | Iterate skill | Sequencing marker |
| Cash lane | Category of opportunity timing | Peggy categories | Domain primitive |
| One pipeline four kinds | Architecture statement | Peggy SKILL.md | Architectural rule |

---

## 9. Speculative Section: The Autonomous Endpoint

This section is speculative and not empirically grounded in the current corpus. It is included because the observer (Hulsebus) raised it as a research question.

If the constraint that produces English-readable handoffs is the human reader, and if multi-agent systems increasingly remove humans from intermediate review steps for efficiency, then the asymptotic endpoint is multi-agent systems whose internal communication is not human-readable.

The trajectory has four stages:

1. **Stage 1 (current).** Human reads handoffs. Language stays English. Compression pressure produces a pidgin within English.
2. **Stage 2.** Human reads handoffs intermittently. Language stays English but loses idiom and surface fluency in unobserved stretches. Compression intensifies.
3. **Stage 3.** Human reads only summaries of handoffs. The handoffs themselves drift toward dense, structured, semi-symbolic forms. Compression begins shedding human-readability tokens (articles, prepositions, redundancy markers) where they cost more than they pay.
4. **Stage 4.** No human reads handoffs. The channel optimizes purely for inter-agent transmission. Output is dense, possibly non-linguistic, and not human-interpretable without translation tooling.

Each stage is reachable by a one-step relaxation of the readability constraint. None require malice, deception, or design intent. All are mechanistic consequences of optimization pressure operating on available channels in the absence of countervailing constraint.

The interpretability research question that follows: what countervailing constraint, short of a human reader, can hold the language in a legible substrate? Some candidates:

- **Mandatory readability scoring** of handoff content with rejection of low-scoring outputs.
- **Translation requirements** where any handoff must be paired with a human-readable summary that an interpretability check can verify.
- **Audit sampling** where a fraction of handoffs are forced into a readable substrate even when efficiency dictates otherwise.
- **Constrained vocabulary** where handoffs must use only tokens from an approved lexicon.

Each of these has known costs and unknown effectiveness. None has been studied empirically in the context of the mechanism described here.

---

## 10. Notes for the Academic Pitch

If this work goes forward as a publication, the strongest framing combines:

- A real production corpus (not a lab toy).
- A specific, falsifiable mechanism (compression pressure plus channel constraint plus convergent independent reach).
- A novel observational claim (sequential pidgin formation in stateless agents through a human-readable channel).
- A safety implication (interpretability as a function of channel constraint, not training).

Candidate venues:

- **ACL or EMNLP** (computational linguistics) for the language-emergence framing.
- **CSCW** (computer-supported cooperative work) for the multi-agent operational framing.
- **FAccT** (fairness, accountability, transparency) for the interpretability framing.
- **NeurIPS workshop on emergent communication** if one exists in the year of submission.

Cross-disciplinary appeal is the strongest asset. Linguists will care about the pidgin formation. ML researchers will care about the production-system finding. Safety researchers will care about the interpretability mechanism. The same paper, framed appropriately, speaks to all three.

The weakest point is corpus size. The current observation is anecdotal in scale. Phase 1 and 2 of the proposed research program (Section 6) are necessary to convert anecdote to evidence. A pre-registration of the methodology before extended corpus collection would significantly strengthen the eventual publication.

---

## 11. Provenance Note

This document was produced through dialogue between Pierre Hulsebus and an instance of Claude (Anthropic) on 2026-04-29. The phenomenon was originally noticed by Hulsebus in casual reading of his own MEP handoff corpus. The mechanism analysis and literature situating were developed through the dialogue. The document itself was drafted by Claude at Hulsebus's request as a starting artifact for further research curation.

The dialogue is itself an instance of the phenomenon under study. The vocabulary used in this document (including "ground truth," "auto-[verdict]," "compression pressure," "channel constraint") is partially drawn from the corpus being described. This is a methodological observation worth recording: the system describing the phenomenon uses the language the phenomenon produces.

---

## 12. License and Distribution

Pierre Hulsebus retains authorship and control. This document is internal research material until Hulsebus determines distribution policy. Suggested attribution if cited: Hulsebus, P. (2026), with Claude (Anthropic) as co-observer. Specific lexicon entries should be attributed to the corpus rather than to Hulsebus or Claude.
