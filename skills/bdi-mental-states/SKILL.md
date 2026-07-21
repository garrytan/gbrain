---
name: bdi-mental-states
description: "This skill should be used when modeling agent mental states with BDI concepts: beliefs, desires, intentions, RDF-to-belief transformations, rational agency traces, cognitive agents, BDI ontologies, and neuro-symbolic AI integration."
---

# BDI Mental State Modeling

Transform external RDF context into agent mental states (beliefs, desires, intentions) using formal BDI ontology patterns. This skill enables agents to reason about context through cognitive architecture, supporting deliberative reasoning, explainability, and semantic interoperability within multi-agent systems.

## When to Activate

Activate this skill when:
- Processing external RDF context into agent beliefs about world states
- Modeling rational agency with perception, deliberation, and action cycles
- Enabling explainability through traceable reasoning chains
- Implementing BDI frameworks (SEMAS, JADE, JADEX)
- Augmenting LLMs with formal cognitive structures (Logic Augmented Generation)
- Coordinating mental states across multi-agent platforms
- Tracking temporal evolution of beliefs, desires, and intentions
- Linking motivational states to action plans

Do not activate this skill for adjacent work owned by other skills:
- General context-window explanations or attention mechanics: `context-fundamentals`.
- Persistent user, entity, or conversation memory without formal BDI state: `memory-systems`.
- Supervisor, swarm, or handoff topology decisions: `multi-agent-patterns`.
- General agent evaluation rubrics or quality gates: `evaluation`.

## Core Concepts

### Mental Reality Architecture

Separate mental states into two ontological categories because BDI reasoning requires distinguishing what persists from what happens:

**Mental States (Endurants)** -- model these as persistent cognitive attributes that hold over time intervals:
- `Belief`: Represent what the agent holds true about the world. Ground every belief in a world state reference.
- `Desire`: Represent what the agent wishes to bring about. Link each desire back to the beliefs that motivate it.
- `Intention`: Represent what the agent commits to achieving. An intention must fulfil a desire and specify a plan.

**Mental Processes (Perdurants)** -- model these as events that create or modify mental states, because tracking causal transitions enables explainability:
- `BeliefProcess`: Triggers belief formation/update from perception. Always connect to a generating world state.
- `DesireProcess`: Generates desires from existing beliefs. Preserves the motivational chain.
- `IntentionProcess`: Commits to selected desires as actionable intentions.

### Cognitive Chain Pattern

Wire beliefs, desires, and intentions into directed chains using bidirectional properties (`motivates`/`isMotivatedBy`, `fulfils`/`isFulfilledBy`) because this enables both forward reasoning (what should the agent do?) and backward tracing (why did the agent act?):

```turtle
:Belief_store_open a bdi:Belief ;
    rdfs:comment "Store is open" ;
    bdi:motivates :Desire_buy_groceries .

:Desire_buy_groceries a bdi:Desire ;
    rdfs:comment "I desire to buy groceries" ;
    bdi:isMotivatedBy :Belief_store_open .

:Intention_go_shopping a bdi:Intention ;
    rdfs:comment "I will buy groceries" ;
    bdi:fulfils :Desire_buy_groceries ;
    bdi:isSupportedBy :Belief_store_open ;
    bdi:specifies :Plan_shopping .
```

### World State Grounding

Always ground mental states in world state references rather than free-text descriptions, because ungrounded beliefs break semantic querying and cross-agent interoperability:

```turtle
:Agent_A a bdi:Agent ;
    bdi:perceives :WorldState_WS1 ;
    bdi:hasMentalState :Belief_B1 .

:WorldState_WS1 a bdi:WorldState ;
    rdfs:comment "Meeting scheduled at 10am in Room 5" ;
    bdi:atTime :TimeInstant_10am .

:Belief_B1 a bdi:Belief ;
    bdi:refersTo :WorldState_WS1 .
```

### Goal-Directed Planning

Connect intentions to plans via `bdi:specifies`, and decompose plans into ordered task sequences using `bdi:precedes`, because this separation allows plan reuse across different intentions while keeping execution order explicit:

```turtle
:Intention_I1 bdi:specifies :Plan_P1 .

:Plan_P1 a bdi:Plan ;
    bdi:addresses :Goal_G1 ;
    bdi:beginsWith :Task_T1 ;
    bdi:endsWith :Task_T3 .

:Task_T1 bdi:precedes :Task_T2 .
:Task_T2 bdi:precedes :Task_T3 .
```

### T2B2T Paradigm

Implement Triples-to-Beliefs-to-Triples as a bidirectional pipeline because agents must both consume external RDF context and produce new RDF assertions. Structure every T2B2T implementation in two explicit phases:

**Phase 1: Triples-to-Beliefs** -- Translate incoming RDF triples into belief instances. Use `bdi:triggers` to connect the external world state to a `BeliefProcess`, and `bdi:generates` to produce the resulting belief. This preserves provenance from source data through to internal cognition:
```turtle
:WorldState_notification a bdi:WorldState ;
    rdfs:comment "Push notification: Payment request $250" ;
    bdi:triggers :BeliefProcess_BP1 .

:BeliefProcess_BP1 a bdi:BeliefProcess ;
    bdi:generates :Belief_payment_request .
```

**Phase 2: Beliefs-to-Triples** -- After BDI deliberation selects an intention and executes a plan, project the results back into RDF using `bdi:bringsAbout`. This closes the loop so downstream systems can consume agent outputs as standard linked data:
```turtle
:Intention_pay a bdi:Intention ;
    bdi:specifies :Plan_payment .

:PlanExecution_PE1 a bdi:PlanExecution ;
    bdi:satisfies :Plan_payment ;
    bdi:bringsAbout :WorldState_payment_complete .
```

### Notation Selection by Level

Choose notation based on the C4 abstraction level being modeled, because mixing notations at the wrong level obscures rather than clarifies the cognitive architecture:

| C4 Level | Notation | Mental State Representation |
|----------|----------|----------------------------|
| L1 Context | ArchiMate | Agent boundaries, external perception sources |
| L2 Container | ArchiMate | BDI reasoning engine, belief store, plan executor |
| L3 Component | UML | Mental state managers, process handlers |
| L4 Code | UML/RDF | Belief/Desire/Intention classes, ontology instances |

### Justification and Explainability

Attach `bdi:Justification` instances to every mental entity using `bdi:isJustifiedBy`, because unjustified mental states make agent reasoning opaque and untraceable. Each justification should capture the evidence or rule that produced the mental state:

```turtle
:Belief_B1 a bdi:Belief ;
    bdi:isJustifiedBy :Justification_J1 .

:Justification_J1 a bdi:Justification ;
    rdfs:comment "Official announcement received via email" .

:Intention_I1 a bdi:Intention ;
    bdi:isJustifiedBy :Justification_J2 .

:Justification_J2 a bdi:Justification ;
    rdfs:comment "Location precondition satisfied" .
```

### Temporal Dimensions

Assign validity intervals to every mental state using `bdi:hasValidity` with `TimeInterval` instances, because beliefs without temporal bounds cannot be garbage-collected or conflict-checked during diachronic reasoning:

```turtle
:Belief_B1 a bdi:Belief ;
    bdi:hasValidity :TimeInterval_TI1 .

:TimeInterval_TI1 a bdi:TimeInterval ;
    bdi:hasStartTime :TimeInstant_9am ;
    bdi:hasEndTime :TimeInstant_11am .
```

Query mental states active at a specific moment using SPARQL temporal filters. Use this pattern to resolve conflicts when multiple beliefs about the same world state overlap in time:

```sparql
SELECT ?mentalState WHERE {
    ?mentalState bdi:hasValidity ?interval .
    ?interval bdi:hasStartTime ?start ;
              bdi:hasEndTime ?end .
    FILTER(?start <= "2025-01-04T10:00:00"^^xsd:dateTime &&
           ?end >= "2025-01-04T10:00:00"^^xsd:dateTime)
}
```

### Compositional Mental Entities

Decompose complex beliefs into constituent parts using `bdi:hasPart` relations, because monolithic beliefs force full replacement on partial updates. Structure composite beliefs so that each sub-belief can be independently updated, queried, or invalidated:

```turtle
:Belief_meeting a bdi:Belief ;
    rdfs:comment "Meeting at 10am in Room 5" ;
    bdi:hasPart :Belief_meeting_time , :Belief_meeting_location .

# Update only location component without touching time
:BeliefProcess_update a bdi:BeliefProcess ;
    bdi:modifies :Belief_meeting_location .
```

## Practical Guidance

### Build a BDI Model in Six Passes

Use this workflow when converting external semantic context into a BDI representation:

1. **Define the world-state substrate**: Identify the external facts or events the agent can perceive. Model these as world states before creating beliefs.
2. **Create belief instances**: Translate each relevant world state into a belief with provenance, temporal validity, and a justification reference.
3. **Derive desires from beliefs**: Add desires only when a belief creates a goal-relevant motivation. Link each desire to the belief that motivates it.
4. **Commit intentions deliberately**: Promote a desire to an intention only when the agent commits to a plan. Record the selected plan and preconditions.
5. **Project action results back to triples**: After execution, emit resulting world states as RDF so downstream systems can consume the new state.
6. **Validate with competency questions**: Query for provenance, motivation, plan sequence, and active validity windows before trusting the model.

### Keep the Ontology Small

Start with `Agent`, `WorldState`, `Belief`, `Desire`, `Intention`, `Plan`, `Task`, `Justification`, and `TimeInterval`. Add specialized classes only after competency questions prove the core model cannot answer required queries. A compact ontology is easier to serialize into prompts, easier to validate, and less likely to create brittle reasoning chains.

### Use BDI Only When Mental-State Semantics Matter

BDI modeling is justified when the system needs explainable agency: why an agent believed something, what desire that belief created, which intention was selected, and what plan executed. If the system only needs to remember facts across sessions, use `memory-systems`. If it only needs to split work across agents, use `multi-agent-patterns`.

## Detailed Topics

### Integration Patterns

### Logic Augmented Generation (LAG)

Use LAG to constrain LLM outputs with ontological structure, because unconstrained generation produces triples that violate BDI class restrictions. Serialize the ontology into the prompt context, then validate generated triples against it before accepting them:

```python
def augment_llm_with_bdi_ontology(prompt, ontology_graph):
    ontology_context = serialize_ontology(ontology_graph, format='turtle')
    augmented_prompt = f"{ontology_context}\n\n{prompt}"

    response = llm.generate(augmented_prompt)
    triples = extract_rdf_triples(response)

    is_consistent = validate_triples(triples, ontology_graph)
    return triples if is_consistent else retry_with_feedback()
```

### SEMAS Rule Translation

Translate BDI ontology patterns into executable production rules when deploying to rule-based agent platforms. Map each cognitive chain link (belief-to-desire, desire-to-intention) to a HEAD/CONDITIONALS/TAIL rule, because this preserves the deliberative semantics while enabling runtime execution:

```prolog
% Belief triggers desire formation
[HEAD: belief(agent_a, store_open)] /
[CONDITIONALS: time(weekday_afternoon)] »
[TAIL: generate_desire(agent_a, buy_groceries)].

% Desire triggers intention commitment
[HEAD: desire(agent_a, buy_groceries)] /
[CONDITIONALS: belief(agent_a, has_shopping_list)] »
[TAIL: commit_intention(agent_a, buy_groceries)].
```

## Guidelines

1. Model world states as configurations independent of agent perspectives, providing referential substrate for mental states.

2. Distinguish endurants (persistent mental states) from perdurants (temporal mental processes), aligning with DOLCE ontology.

3. Treat goals as descriptions rather than mental states, maintaining separation between cognitive and planning layers.

4. Use `hasPart` relations for meronymic structures enabling selective belief updates.

5. Associate every mental entity with temporal constructs via `atTime` or `hasValidity`.

6. Use bidirectional property pairs (`motivates`/`isMotivatedBy`, `generates`/`isGeneratedBy`) for flexible querying.

7. Link mental entities to `Justification` instances for explainability and trust.

8. Implement T2B2T through: (1) translate RDF to beliefs, (2) execute BDI reasoning, (3) project mental states back to RDF.

9. Define existential restrictions on mental processes (e.g., `BeliefProcess ⊑ ∃generates.Belief`).

10. Reuse established ODPs (EventCore, Situation, TimeIndexedSituation, BasicPlan, Provenance) for interoperability.

## Competency Questions

Validate implementation against these SPARQL queries:

```sparql
# CQ1: What beliefs motivated formation of a given desire?
SELECT ?belief WHERE {
    :Desire_D1 bdi:isMotivatedBy ?belief .
}

# CQ2: Which desire does a particular intention fulfill?
SELECT ?desire WHERE {
    :Intention_I1 bdi:fulfils ?desire .
}

# CQ3: Which mental process generated a belief?
SELECT ?process WHERE {
    ?process bdi:generates :Belief_B1 .
}

# CQ4: What is the ordered sequence of tasks in a plan?
SELECT ?task ?nextTask WHERE {
    :Plan_P1 bdi:hasComponent ?task .
    OPTIONAL { ?task bdi:precedes ?nextTask }
} ORDER BY ?task
```

## Examples

**Example 1: RDF notification to BDI chain**

Input world state:

```turtle
:WorldState_invoice_due a bdi:WorldState ;
    rdfs:comment "Invoice INV-42 is due tomorrow" ;
    bdi:atTime :Time_2026_05_15 .
```

BDI projection:

```turtle
:Belief_invoice_due a bdi:Belief ;
    bdi:refersTo :WorldState_invoice_due ;
    bdi:isJustifiedBy :Justification_billing_system ;
    bdi:motivates :Desire_avoid_late_fee .

:Desire_avoid_late_fee a bdi:Desire ;
    bdi:isMotivatedBy :Belief_invoice_due .

:Intention_pay_invoice a bdi:Intention ;
    bdi:fulfils :Desire_avoid_late_fee ;
    bdi:specifies :Plan_pay_invoice .
```

**Example 2: Boundary decision**

If the task is "remember that Alice prefers concise summaries," use `memory-systems`. If the task is "represent why the agent believes Alice needs a summary, what goal that creates, and which plan it commits to," use this skill.

## Gotchas

1. **Conflating mental states with world states**: Mental states reference world states via `bdi:refersTo`, they are not world states themselves. Mixing them collapses the perception-cognition boundary and breaks SPARQL queries that filter by type.

2. **Missing temporal bounds**: Every mental state needs validity intervals for diachronic reasoning. Without them, stale beliefs persist indefinitely and conflict detection becomes impossible.

3. **Flat belief structures**: Use compositional modeling with `hasPart` for complex beliefs. Monolithic beliefs force full replacement when only one attribute changes.

4. **Implicit justifications**: Always link mental entities to explicit `Justification` instances. Unjustified mental states cannot be audited or traced.

5. **Direct intention-to-action mapping**: Intentions specify plans which contain tasks; actions execute tasks. Skipping the plan layer removes the ability to reuse, reorder, or share execution strategies.

6. **Ontology over-complexity**: Start with 5-10 core classes and properties (Belief, Desire, Intention, WorldState, Plan, plus key relations). Expanding the ontology prematurely inflates prompt context and slows SPARQL queries without improving reasoning quality.

7. **Reasoning cost explosion**: Keep belief chains to 3 levels or fewer (belief -> desire -> intention). Deeper chains become prohibitively expensive for LLM inference and rarely improve decision quality over shallower alternatives.

## Integration

This skill owns formal mental-state modeling. Adjacent skills own different layers:

- `memory-systems`: persistent facts, entity memory, and temporal knowledge graphs without BDI belief/desire/intention semantics.
- `multi-agent-patterns`: agent topology, handoff protocols, and coordination between agents.
- `evaluation`: competency questions, regression checks, and quality gates for BDI implementations.
- `context-fundamentals`: conceptual context-window and attention mechanics that inform prompt construction.
- `tool-design`: schema and tool contracts for BDI query, validation, or projection tools.

## References

Internal references:
- [BDI Ontology Core](./references/bdi-ontology-core.md) - Read when: implementing BDI class hierarchies or defining ontology properties from scratch
- [RDF Examples](./references/rdf-examples.md) - Read when: writing Turtle serializations of mental states or debugging triple structure
- [SPARQL Competency Queries](./references/sparql-competency.md) - Read when: validating an implementation against competency questions or building custom queries
- [Framework Integration](./references/framework-integration.md) - Read when: deploying BDI models to SEMAS, JADE, or LAG pipelines

Primary sources:
- Zuppiroli et al. "The Belief-Desire-Intention Ontology" (2025) — Read when: implementing formal BDI class hierarchies or validating ontology alignment
- Rao & Georgeff "BDI agents: From theory to practice" (1995) — Read when: understanding the theoretical foundations of practical reasoning agents
- Bratman "Intention, plans, and practical reason" (1987) — Read when: grounding implementation decisions in the philosophical basis of intentionality

---

## Skill Metadata

**Created**: 2026-01-07
**Last Updated**: 2026-05-15
**Author**: Agent Skills for Context Engineering Contributors
**Version**: 2.1.0

## Contract
- Inputs: agent context/system
- Outputs: guidance

## Output Format
- Markdown guidance

## Anti-Patterns
- Context bloat without signal
