"""Advanced Evaluation Example

Use when: building LLM-as-judge evaluation pipelines, comparing model outputs
with position-bias mitigation, or generating domain-specific scoring rubrics.

This module demonstrates the three core evaluation patterns from the
advanced-evaluation skill: direct scoring, pairwise comparison with position
swapping, and rubric generation. All functions use pseudocode-style examples
that work across Python environments without specific dependencies.
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "direct_scoring_example",
    "pairwise_comparison_example",
    "rubric_generation_example",
]


# =============================================================================
# DIRECT SCORING EXAMPLE
# =============================================================================


def direct_scoring_example() -> dict[str, Any]:
    """Rate a single response against defined criteria using direct scoring.

    Use when: evaluating objective criteria like factual accuracy, instruction
    following, or toxicity where a clear ground truth or rubric exists.

    Returns:
        Dictionary containing per-criterion scores, evidence, justifications,
        and a weighted summary.
    """

    # Input
    prompt: str = "Explain quantum entanglement to a high school student"
    response: str = (
        "Quantum entanglement is like having two magical coins that are connected. "
        "When you flip one and it lands on heads, the other instantly shows tails, "
        'no matter how far apart they are. Scientists call this "spooky action at a distance."'
    )

    criteria: list[dict[str, Any]] = [
        {"name": "Accuracy", "description": "Scientific correctness", "weight": 0.4},
        {"name": "Clarity", "description": "Understandable for audience", "weight": 0.3},
        {"name": "Engagement", "description": "Interesting and memorable", "weight": 0.3},
    ]

    # System prompt for the evaluator
    system_prompt: str = (
        "You are an expert evaluator. Assess the response against each criterion.\n\n"
        "For each criterion:\n"
        "1. Find specific evidence in the response\n"
        "2. Score according to the rubric (1-5 scale)\n"
        "3. Justify your score with evidence\n"
        "4. Suggest one specific improvement\n\n"
        "Be objective and consistent. Base scores on explicit evidence."
    )

    # User prompt structure
    user_prompt: str = f"""## Original Prompt
{prompt}

## Response to Evaluate
{response}

## Criteria
1. **Accuracy** (weight: 0.4): Scientific correctness
2. **Clarity** (weight: 0.3): Understandable for audience
3. **Engagement** (weight: 0.3): Interesting and memorable

## Output Format
Respond with valid JSON:
{{
  "scores": [
    {{
      "criterion": "Accuracy",
      "score": 4,
      "evidence": ["quote or observation"],
      "justification": "why this score",
      "improvement": "specific suggestion"
    }}
  ],
  "summary": {{
    "assessment": "overall quality summary",
    "strengths": ["strength 1"],
    "weaknesses": ["weakness 1"]
  }}
}}"""

    # Expected output structure
    expected_output: dict[str, Any] = {
        "scores": [
            {
                "criterion": "Accuracy",
                "score": 4,
                "evidence": ["Correctly uses analogy", "Mentions spooky action at a distance"],
                "justification": "Core concept is correct, analogy is appropriate",
                "improvement": "Could mention it's a quantum mechanical phenomenon",
            },
            {
                "criterion": "Clarity",
                "score": 5,
                "evidence": ["Simple coin analogy", "No jargon"],
                "justification": "Appropriate for high school level",
                "improvement": "None needed",
            },
            {
                "criterion": "Engagement",
                "score": 4,
                "evidence": ["Magical coins", "Spooky action quote"],
                "justification": "Memorable imagery and Einstein quote",
                "improvement": "Could add a real-world application",
            },
        ],
        "summary": {
            "assessment": "Good explanation suitable for the target audience",
            "strengths": ["Clear analogy", "Age-appropriate language"],
            "weaknesses": ["Could be more comprehensive"],
        },
    }

    # Calculate weighted score
    total_weight: float = sum(c["weight"] for c in criteria)
    weighted_score: float = sum(
        s["score"] * next(c["weight"] for c in criteria if c["name"] == s["criterion"])
        for s in expected_output["scores"]
    ) / total_weight

    print(f"Weighted Score: {weighted_score:.2f}/5")
    return expected_output


# =============================================================================
# PAIRWISE COMPARISON WITH POSITION BIAS MITIGATION
# =============================================================================


def pairwise_comparison_example() -> dict[str, Any]:
    """Compare two responses with position-swapped bias mitigation.

    Use when: evaluating subjective preferences like tone, style, or
    persuasiveness where pairwise comparison achieves higher human-judge
    agreement than direct scoring.

    Returns:
        Dictionary containing the winner, confidence score, and whether
        position consistency was achieved across both passes.
    """

    prompt: str = "Explain machine learning to a beginner"

    response_a: str = (
        "Machine learning is a subset of artificial intelligence that enables "
        "systems to learn and improve from experience without being explicitly "
        "programmed. It uses statistical techniques to give computers the ability "
        "to identify patterns in data."
    )

    response_b: str = (
        "Imagine teaching a dog a new trick. You show the dog what to do, give "
        "treats when it's right, and eventually it learns. Machine learning works "
        "similarly - we show computers lots of examples, tell them when they're "
        "right, and they learn to recognize patterns on their own."
    )

    criteria: list[str] = ["clarity", "accessibility", "accuracy"]

    # System prompt emphasizing bias awareness
    system_prompt: str = (
        "You are an expert evaluator comparing two AI responses.\n\n"
        "CRITICAL INSTRUCTIONS:\n"
        "- Do NOT prefer responses because they are longer\n"
        "- Do NOT prefer responses based on position (first vs second)\n"
        "- Focus ONLY on quality according to the specified criteria\n"
        "- Ties are acceptable when responses are genuinely equivalent"
    )

    # Build evaluation prompt for a given ordering
    def evaluate_pass(
        first_response: str,
        second_response: str,
        first_label: str,
        second_label: str,
    ) -> str:
        """Build evaluation prompt for one pass of position-swapped comparison.

        Use when: constructing the prompt for a single evaluation pass before
        swapping response positions for bias mitigation.
        """
        return f"""## Original Prompt
{prompt}

## Response {first_label}
{first_response}

## Response {second_label}
{second_response}

## Comparison Criteria
{', '.join(criteria)}

## Output Format
{{
  "comparison": [
    {{"criterion": "clarity", "winner": "A|B|TIE", "reasoning": "..."}}
  ],
  "result": {{
    "winner": "A|B|TIE",
    "confidence": 0.0-1.0,
    "reasoning": "overall reasoning"
  }}
}}"""

    # Position bias mitigation protocol
    print("Pass 1: A in first position")
    pass1_result: dict[str, Any] = {"winner": "B", "confidence": 0.8}

    print("Pass 2: B in first position (swapped)")
    pass2_result: dict[str, Any] = {"winner": "A", "confidence": 0.75}  # A because B was first

    # Map pass2 result back (swap labels)
    def map_winner(winner: str) -> str:
        """Map winner label after position swap."""
        return {"A": "B", "B": "A", "TIE": "TIE"}[winner]

    pass2_mapped: str = map_winner(pass2_result["winner"])
    print(f"Pass 2 mapped winner: {pass2_mapped}")

    # Check consistency
    consistent: bool = pass1_result["winner"] == pass2_mapped

    final_result: dict[str, Any]
    if consistent:
        final_result = {
            "winner": pass1_result["winner"],
            "confidence": (pass1_result["confidence"] + pass2_result["confidence"]) / 2,
            "position_consistent": True,
        }
    else:
        final_result = {
            "winner": "TIE",
            "confidence": 0.5,
            "position_consistent": False,
            "bias_detected": True,
        }

    print(f"\nFinal Result: {final_result}")
    return final_result


# =============================================================================
# RUBRIC GENERATION
# =============================================================================


def rubric_generation_example() -> dict[str, Any]:
    """Generate a domain-specific scoring rubric for consistent evaluation.

    Use when: establishing evaluation standards for a new criterion, reducing
    scoring variance (rubrics cut variance by 40-60%), or onboarding new
    evaluators to an existing evaluation pipeline.

    Returns:
        Dictionary containing score levels, characteristics, examples,
        scoring guidelines, and edge case handling.
    """

    criterion_name: str = "Code Readability"
    criterion_description: str = "How easy the code is to understand and maintain"
    domain: str = "software engineering"
    scale: str = "1-5"
    strictness: str = "balanced"

    system_prompt: str = (
        f"You are an expert in creating evaluation rubrics.\n"
        f"Create clear, actionable rubrics with distinct boundaries between levels.\n\n"
        f"Strictness: {strictness}\n"
        f"- lenient: Lower bar for passing scores\n"
        f"- balanced: Fair, typical expectations\n"
        f"- strict: High standards, critical evaluation"
    )

    user_prompt: str = f"""Create a scoring rubric for:

**Criterion**: {criterion_name}
**Description**: {criterion_description}
**Scale**: {scale}
**Domain**: {domain}

Generate:
1. Clear descriptions for each score level
2. Specific characteristics that define each level
3. Brief example text for each level
4. General scoring guidelines
5. Edge cases with guidance"""

    # Expected rubric structure
    rubric: dict[str, Any] = {
        "criterion": criterion_name,
        "scale": {"min": 1, "max": 5},
        "levels": [
            {
                "score": 1,
                "label": "Poor",
                "description": "Code is difficult to understand without significant effort",
                "characteristics": [
                    "No meaningful variable or function names",
                    "No comments or documentation",
                    "Deeply nested or convoluted logic",
                ],
                "example": "def f(x): return x[0]*x[1]+x[2]",
            },
            {
                "score": 3,
                "label": "Adequate",
                "description": "Code is understandable with some effort",
                "characteristics": [
                    "Most variables have meaningful names",
                    "Basic comments for complex sections",
                    "Logic is followable but could be cleaner",
                ],
                "example": (
                    "def calc_total(items): # calculate sum\n"
                    "    total = 0\n"
                    "    for i in items: total += i\n"
                    "    return total"
                ),
            },
            {
                "score": 5,
                "label": "Excellent",
                "description": "Code is immediately clear and maintainable",
                "characteristics": [
                    "All names are descriptive and consistent",
                    "Comprehensive documentation",
                    "Clean, modular structure",
                ],
                "example": (
                    "def calculate_total_price(items: List[Item]) -> Decimal:\n"
                    "    '''Calculate the total price of all items.'''\n"
                    "    return sum(item.price for item in items)"
                ),
            },
        ],
        "scoring_guidelines": [
            "Focus on readability, not cleverness",
            "Consider the intended audience (team skill level)",
            "Consistency matters more than style preference",
        ],
        "edge_cases": [
            {
                "situation": "Code uses domain-specific abbreviations",
                "guidance": "Score based on readability for domain experts, not general audience",
            },
            {
                "situation": "Code is auto-generated",
                "guidance": "Apply same standards but note in evaluation",
            },
        ],
    }

    print("Generated Rubric:")
    for level in rubric["levels"]:
        print(f"  {level['score']}: {level['label']} - {level['description']}")

    return rubric


# =============================================================================
# MAIN
# =============================================================================

if __name__ == "__main__":
    print("=" * 60)
    print("DIRECT SCORING EXAMPLE")
    print("=" * 60)
    direct_scoring_example()

    print("\n" + "=" * 60)
    print("PAIRWISE COMPARISON EXAMPLE")
    print("=" * 60)
    pairwise_comparison_example()

    print("\n" + "=" * 60)
    print("RUBRIC GENERATION EXAMPLE")
    print("=" * 60)
    rubric_generation_example()
