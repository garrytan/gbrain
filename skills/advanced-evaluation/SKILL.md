---
name: advanced-evaluation
description: "This skill should be used for advanced LLM evaluation: LLM-as-judge systems, direct scoring, pairwise comparison, rubric calibration, evaluator bias mitigation, confidence scoring, and automated quality assessment."
---

# Advanced Evaluation

This skill covers production-grade techniques for evaluating LLM outputs using LLMs as judges. It synthesizes research from academic papers, industry practices, and practical implementation experience into actionable patterns for building reliable evaluation systems.

**Key insight**: LLM-as-a-Judge is not a single technique but a family of approaches, each suited to different evaluation contexts. Choosing the right approach and mitigating known biases is the core competency this skill develops.

## When to Activate

Activate this skill when:

- Building LLM-as-judge systems for LLM outputs
- Comparing multiple model responses to select the best one
- Establishing consistent quality standards across evaluation teams
- Debugging evaluation systems that show inconsistent results
- Designing A/B tests for prompt or model changes
- Creating rubrics specifically for LLM or human/LLM hybrid judges
- Analyzing correlation between automated and human judgments

Do not activate this skill for adjacent work owned by other skills:
- General deterministic checks, regression suites, production quality gates, or outcome metrics: `evaluation`.
- Autonomous loop governance, locked rubrics, rollback, or PR approval boundaries: `harness-engineering`.
- Tool API contracts for evaluation tools: `tool-design`.

## Core Concepts

### The Evaluation Taxonomy

Select between two primary approaches based on whether ground truth exists:

**Direct Scoring** — Use when objective criteria exist (factual accuracy, instruction following, toxicity). A single LLM rates one response on a defined scale. Achieves moderate-to-high reliability for well-defined criteria. Watch for score calibration drift and inconsistent scale interpretation.

**Pairwise Comparison** — Use for subjective preferences (tone, style, persuasiveness). An LLM compares two responses and selects the better one. Pairwise methods often correlate better with human preference than open-ended direct scoring for subjective tasks (claim-advanced-evaluation-position-swap). Watch for position bias and length bias.

### The Bias Landscape

Mitigate these systematic biases in every evaluation system:

**Position Bias**: First-position responses get preferential treatment. Mitigate by evaluating twice with swapped positions, then apply majority vote or consistency check.

**Length Bias**: Longer responses score higher regardless of quality. Mitigate by explicitly prompting to ignore length and applying length-normalized scoring.

**Self-Enhancement Bias**: Models rate their own outputs higher. Mitigate by using different models for generation and evaluation.

**Verbosity Bias**: Excessive detail scores higher even when unnecessary. Mitigate with criteria-specific rubrics that penalize irrelevant detail.

**Authority Bias**: Confident tone scores higher regardless of accuracy. Mitigate by requiring evidence citation and adding a fact-checking layer.

### Metric Selection Framework

Match metrics to the evaluation task structure:

| Task Type | Primary Metrics | Secondary Metrics |
|-----------|-----------------|-------------------|
| Binary classification (pass/fail) | Recall, Precision, F1 | Cohen's kappa |
| Ordinal scale (1-5 rating) | Spearman's rho, Kendall's tau | Cohen's kappa (weighted) |
| Pairwise preference | Agreement rate, Position consistency | Confidence calibration |
| Multi-label | Macro-F1, Micro-F1 | Per-label precision/recall |

Prioritize systematic disagreement patterns over absolute agreement rates because a judge that consistently disagrees with humans on specific criteria is more problematic than one with random noise.

## Evaluation Approaches

### Direct Scoring Implementation

Build direct scoring with three components: clear criteria, a calibrated scale, and structured output format.

**Criteria Definition Pattern**:
```
Criterion: [Name]
Description: [What this criterion measures]
Weight: [Relative importance, 0-1]
```

**Scale Calibration** — Choose scale granularity based on rubric detail:
- 1-3: Binary with neutral option, lowest cognitive load
- 1-5: Standard Likert, best balance of granularity and reliability
- 1-10: Use only with detailed per-level rubrics because calibration is harder

**Prompt Structure for Direct Scoring**:
```
You are an expert evaluator assessing response quality.

## Task
Evaluate the following response against each criterion.

## Original Prompt
{prompt}

## Response to Evaluate
{response}

## Criteria
{for each criterion: name, description, weight}

## Instructions
For each criterion:
1. Find specific evidence in the response
2. Score according to the rubric (1-{max} scale)
3. Justify your score with evidence
4. Suggest one specific improvement

## Output Format
Respond with structured JSON containing scores, justifications, and summary.
```

Require evidence before the score in scoring prompts so the judge must anchor its decision in observable output features before emitting a number.

### Pairwise Comparison Implementation

Apply position bias mitigation in every pairwise evaluation:

1. Run deterministic pre-checks first: both candidates must satisfy the same schema, source-evidence requirements, and scope constraints.
2. First judge pass: Response A in first position, Response B in second.
3. Second judge pass: Response B in first position, Response A in second.
4. Consistency check: If passes disagree, return TIE with reduced confidence.
5. Final verdict: Consistent winner with averaged confidence and explicit tie-breaker rationale.

**Prompt Structure for Pairwise Comparison**:
```
You are an expert evaluator comparing two AI responses.

## Critical Instructions
- Do NOT prefer responses because they are longer
- Do NOT prefer responses based on position (first vs second)
- Focus ONLY on quality according to the specified criteria
- Ties are acceptable when responses are genuinely equivalent

## Original Prompt
{prompt}

## Response A
{response_a}

## Response B
{response_b}

## Comparison Criteria
{criteria list}

## Instructions
1. Analyze each response independently first
2. Compare them on each criterion
3. Determine overall winner with confidence level

## Output Format
JSON with per-criterion comparison, overall winner, confidence (0-1), and reasoning.
```

**Confidence Calibration** — Map confidence to position consistency:
- Both passes agree: confidence = average of individual confidences
- Passes disagree: confidence = 0.5, verdict = TIE

### Rubric Generation

Generate rubrics to reduce evaluation variance compared to open-ended scoring. Treat exact variance reduction as workload-specific unless measured on the target eval set.

**Include these rubric components**:
1. **Level descriptions**: Clear boundaries for each score level
2. **Characteristics**: Observable features that define each level
3. **Examples**: Representative text for each level (optional but valuable)
4. **Edge cases**: Guidance for ambiguous situations
5. **Scoring guidelines**: General principles for consistent application

**Set strictness calibration** for the use case:
- **Lenient**: Lower passing bar, appropriate for encouraging iteration
- **Balanced**: Typical production expectations
- **Strict**: High standards for safety-critical or high-stakes evaluation

Adapt rubrics to the domain — use domain-specific terminology. A code readability rubric mentions variables, functions, and comments. A medical accuracy rubric references clinical terminology and evidence standards.

## Practical Guidance

### Evaluation Pipeline Design

Build production evaluation systems with these layers: Criteria Loader (rubrics + weights) -> Primary Scorer (direct or pairwise) -> Bias Mitigation (position swap, etc.) -> Confidence Scoring (calibration) -> Output (scores + justifications + confidence). See [Evaluation Pipeline Diagram](./references/evaluation-pipeline.md) for the full visual layout.

### Decision Framework: Direct vs. Pairwise

Apply this decision tree:

```
Is there an objective ground truth?
+-- Yes -> Direct Scoring
|   Examples: factual accuracy, instruction following, format compliance
|
+-- No -> Is it a preference or quality judgment?
    +-- Yes -> Pairwise Comparison
    |   Examples: tone, style, persuasiveness, creativity
    |
    +-- No -> Consider reference-based evaluation
        Examples: summarization (compare to source), translation (compare to reference)
```

### Scaling Evaluation

For high-volume evaluation, apply one of these strategies:

1. **Panel of LLMs (PoLL)**: Use multiple models as judges and aggregate votes to reduce individual model bias. More expensive but more reliable for high-stakes decisions.

2. **Hierarchical evaluation**: Use a fast cheap model for screening and an expensive model for edge cases. Requires calibration of the screening threshold.

3. **Human-in-the-loop**: Automate clear cases and route low-confidence decisions to human review. Design feedback loops to improve automated evaluation over time.

## Examples

### Example 1: Direct Scoring for Accuracy

**Input**:
```
Prompt: "What causes seasons on Earth?"
Response: "Seasons are caused by Earth's tilted axis. As Earth orbits the Sun,
different hemispheres receive more direct sunlight at different times of year."
Criterion: Factual Accuracy (weight: 1.0)
Scale: 1-5
```

**Output**:
```json
{
  "criterion": "Factual Accuracy",
  "score": 5,
  "evidence": [
    "Correctly identifies axial tilt as primary cause",
    "Correctly explains differential sunlight by hemisphere",
    "No factual errors present"
  ],
  "justification": "Response accurately explains the cause of seasons with correct
scientific reasoning. Both the axial tilt and its effect on sunlight distribution
are correctly described.",
  "improvement": "Could add the specific tilt angle (23.5 degrees) for completeness."
}
```

### Example 2: Pairwise Comparison with Position Swap

**Input**:
```
Prompt: "Explain machine learning to a beginner"
Response A: [Technical explanation with jargon]
Response B: [Simple analogy-based explanation]
Criteria: ["clarity", "accessibility"]
```

**First Pass (A first)**:
```json
{ "winner": "B", "confidence": 0.8 }
```

**Second Pass (B first)**:
```json
{ "winner": "A", "confidence": 0.6 }
```
(Note: Winner is A because B was in first position)

**Mapped Second Pass**:
```json
{ "winner": "B", "confidence": 0.6 }
```

**Final Result**:
```json
{
  "winner": "B",
  "confidence": 0.7,
  "positionConsistency": {
    "consistent": true,
    "firstPassWinner": "B",
    "secondPassWinner": "B"
  }
}
```

### Example 3: Rubric Generation

**Input**:
```
criterionName: "Code Readability"
criterionDescription: "How easy the code is to understand and maintain"
domain: "software engineering"
scale: "1-5"
strictness: "balanced"
```

**Output** (abbreviated):
```json
{
  "levels": [
    {
      "score": 1,
      "label": "Poor",
      "description": "Code is difficult to understand without significant effort",
      "characteristics": [
        "No meaningful variable or function names",
        "No comments or documentation",
        "Deeply nested or convoluted logic"
      ]
    },
    {
      "score": 3,
      "label": "Adequate",
      "description": "Code is understandable with some effort",
      "characteristics": [
        "Most variables have meaningful names",
        "Basic comments present for complex sections",
        "Logic is followable but could be cleaner"
      ]
    },
    {
      "score": 5,
      "label": "Excellent",
      "description": "Code is immediately clear and maintainable",
      "characteristics": [
        "All names are descriptive and consistent",
        "Comprehensive documentation",
        "Clean, modular structure"
      ]
    }
  ],
  "edgeCases": [
    {
      "situation": "Code is well-structured but uses domain-specific abbreviations",
      "guidance": "Score based on readability for domain experts, not general audience"
    }
  ]
}
```

## Guidelines

1. **Always require evidence before scores** - Evidence-first prompts make judgments easier to audit and reduce ungrounded numeric scoring

2. **Always swap positions in pairwise comparison** - Single-pass comparison is corrupted by position bias

3. **Match scale granularity to rubric specificity** - Don't use 1-10 without detailed level descriptions

4. **Separate objective and subjective criteria** - Use direct scoring for objective, pairwise for subjective

5. **Include confidence scores** - Calibrate to position consistency and evidence strength

6. **Define edge cases explicitly** - Ambiguous situations cause the most evaluation variance

7. **Use domain-specific rubrics** - Generic rubrics produce generic (less useful) evaluations

8. **Validate against human judgments** - Automated evaluation is only valuable if it correlates with human assessment

9. **Monitor for systematic bias** - Track disagreement patterns by criterion, response type, model

10. **Design for iteration** - Evaluation systems improve with feedback loops

## Gotchas

1. **Scoring without justification**: Scores lack grounding and are difficult to debug. Always require evidence-based justification before the score.

2. **Single-pass pairwise comparison**: Position bias corrupts results when positions are not swapped. Always evaluate twice with swapped positions and check consistency.

3. **Overloaded criteria**: Criteria that measure multiple things at once produce unreliable scores. Enforce one criterion = one measurable aspect.

4. **Missing edge case guidance**: Evaluators handle ambiguous cases inconsistently without explicit instructions. Include edge cases in rubrics with clear resolution rules.

5. **Ignoring confidence calibration**: High-confidence wrong judgments are worse than low-confidence ones. Calibrate confidence to position consistency and evidence strength.

6. **Rubric drift**: Rubrics become miscalibrated as quality standards evolve or model capabilities improve. Schedule periodic rubric reviews and re-anchor score levels against fresh human-annotated examples.

7. **Evaluation prompt sensitivity**: Minor wording changes in evaluation prompts can cause material score swings. Version-control evaluation prompts and run regression tests before deploying prompt changes.

8. **Uncontrolled length bias**: Longer responses systematically score higher even when conciseness is preferred. Add explicit length-neutrality instructions to evaluation prompts and validate with length-controlled test pairs.

## Integration

This skill owns judge design and bias mitigation. Adjacent skills own broader quality gates and infrastructure:

- `evaluation`: general deterministic checks, regression suites, quality gates, and production monitoring.
- `context-fundamentals`: context structure for judge prompts.
- `tool-design`: schemas and error handling for evaluation tools.
- `context-optimization`: token and latency efficiency for high-volume evals.
- `harness-engineering`: locked evaluator surfaces and governance for autonomous loops.

## References

Internal reference:
- [LLM-as-Judge Implementation Patterns](./references/implementation-patterns.md) - Read when: building an evaluation pipeline from scratch or integrating LLM judges into CI/CD
- [Bias Mitigation Techniques](./references/bias-mitigation.md) - Read when: evaluation results show inconsistent or suspicious scoring patterns
- [Metric Selection Guide](./references/metrics-guide.md) - Read when: choosing statistical metrics to validate evaluation reliability
- [Evaluation Pipeline Diagram](./references/evaluation-pipeline.md) - Read when: designing the architecture of a multi-stage evaluation system

External research:
- [Eugene Yan: Evaluating the Effectiveness of LLM-Evaluators](https://eugeneyan.com/writing/llm-evaluators/) - Read when: surveying the state of the art in LLM evaluation
- [Judging LLM-as-a-Judge (Zheng et al., 2023)](https://arxiv.org/abs/2306.05685) - Read when: understanding position bias and MT-Bench methodology
- [G-Eval: NLG Evaluation using GPT-4 (Liu et al., 2023)](https://arxiv.org/abs/2303.16634) - Read when: implementing chain-of-thought evaluation scoring
- [Large Language Models are not Fair Evaluators (Wang et al., 2023)](https://arxiv.org/abs/2305.17926) - Read when: diagnosing systematic bias in evaluation outputs

Related skills in this collection:
- evaluation - Foundational evaluation concepts
- context-fundamentals - Context structure for evaluation prompts
- tool-design - Building evaluation tools

---

## Skill Metadata

**Created**: 2025-12-24
**Last Updated**: 2026-05-15
**Author**: Agent Skills for Context Engineering Contributors
**Version**: 2.1.0

## Contract
- Inputs: agent/system context
- Outputs: guidance

## Anti-Patterns
- Stuffing context without signal; ignoring degradation
