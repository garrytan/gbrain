"""Agent Evaluation Framework for context-engineered agent systems.

Use when: building evaluation pipelines, scoring agent outputs against
multi-dimensional rubrics, managing test sets, or monitoring production
agent quality. Provides composable classes that can be used independently
or wired together into a full evaluation pipeline.

Typical usage::

    evaluator = AgentEvaluator()
    test_set = TestSet("my_tests").create_standard_tests()
    runner = EvaluationRunner(evaluator, test_set)
    summary = runner.run_all(verbose=True)
    print(summary)
"""

from typing import Dict, List, Any, Optional
from dataclasses import dataclass
from enum import Enum
import time

__all__ = [
    "ScoreLevel",
    "RubricDimension",
    "DEFAULT_RUBRIC",
    "AgentEvaluator",
    "TestSet",
    "EvaluationRunner",
    "ProductionMonitor",
]


class ScoreLevel(Enum):
    """Use when: mapping qualitative judgments to numeric scores."""

    EXCELLENT = 1.0
    GOOD = 0.8
    ACCEPTABLE = 0.6
    POOR = 0.3
    FAILED = 0.0


@dataclass
class RubricDimension:
    """Definition of a single evaluation dimension.

    Use when: defining custom rubric dimensions beyond the defaults.
    """

    name: str
    weight: float
    description: str
    levels: Dict[str, str]  # level_name -> description


DEFAULT_RUBRIC: Dict[str, RubricDimension] = {
    "factual_accuracy": RubricDimension(
        name="factual_accuracy",
        weight=0.30,
        description="Claims in output match ground truth",
        levels={
            "excellent": "All claims verified, no errors",
            "good": "Minor errors not affecting main conclusions",
            "acceptable": "Major claims correct, minor inaccuracies",
            "poor": "Significant factual errors",
            "failed": "Fundamental factual errors",
        },
    ),
    "completeness": RubricDimension(
        name="completeness",
        weight=0.25,
        description="Output covers all requested aspects",
        levels={
            "excellent": "All aspects thoroughly covered",
            "good": "Most aspects covered, minor gaps",
            "acceptable": "Key aspects covered, some gaps",
            "poor": "Major aspects missing",
            "failed": "Fundamental aspects missing",
        },
    ),
    "citation_accuracy": RubricDimension(
        name="citation_accuracy",
        weight=0.15,
        description="Citations match claimed sources",
        levels={
            "excellent": "All citations accurate and complete",
            "good": "Minor citation issues",
            "acceptable": "Major citations accurate",
            "poor": "Significant citation problems",
            "failed": "Citations missing or incorrect",
        },
    ),
    "source_quality": RubricDimension(
        name="source_quality",
        weight=0.10,
        description="Uses appropriate primary sources",
        levels={
            "excellent": "Primary sources, authoritative",
            "good": "Mostly primary, some secondary",
            "acceptable": "Mix of primary and secondary",
            "poor": "Mostly secondary or unreliable",
            "failed": "No credible sources",
        },
    ),
    "tool_efficiency": RubricDimension(
        name="tool_efficiency",
        weight=0.20,
        description="Uses right tools reasonable number of times",
        levels={
            "excellent": "Optimal tool selection and count",
            "good": "Good tool selection, minor inefficiencies",
            "acceptable": "Appropriate tools, some redundancy",
            "poor": "Wrong tools or excessive calls",
            "failed": "Severe tool misuse",
        },
    ),
}


# ---------------------------------------------------------------------------
# Evaluation Engine
# ---------------------------------------------------------------------------


class AgentEvaluator:
    """Main evaluation engine for agent outputs.

    Use when: scoring a single agent output against a multi-dimensional rubric.
    Instantiate with a custom rubric or rely on ``DEFAULT_RUBRIC``.
    """

    def __init__(self, rubric: Optional[Dict[str, RubricDimension]] = None) -> None:
        self.rubric: Dict[str, RubricDimension] = rubric or DEFAULT_RUBRIC
        self.evaluation_history: List[Dict[str, Any]] = []

    def evaluate(
        self,
        task: Dict[str, Any],
        output: str,
        ground_truth: Optional[Dict[str, Any]] = None,
        tool_calls: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """Evaluate agent output against task requirements.

        Use when: you have a single (task, output) pair and need per-dimension
        scores plus an overall pass/fail verdict.

        Returns evaluation results with per-dimension scores.
        """
        scores: Dict[str, Dict[str, Any]] = {}

        for dimension_name, dimension in self.rubric.items():
            score = self._evaluate_dimension(
                dimension=dimension,
                task=task,
                output=output,
                ground_truth=ground_truth,
                tool_calls=tool_calls,
            )

            scores[dimension_name] = {
                "score": score,
                "weight": dimension.weight,
                "level": self._score_to_level(score),
            }

        # Calculate weighted overall
        overall: float = sum(
            s["score"] * self.rubric[k].weight for k, s in scores.items()
        )

        result: Dict[str, Any] = {
            "overall_score": overall,
            "dimension_scores": scores,
            "passed": overall >= 0.7,
            "timestamp": time.time(),
        }

        self.evaluation_history.append(result)
        return result

    def _evaluate_dimension(
        self,
        dimension: RubricDimension,
        task: Dict[str, Any],
        output: str,
        ground_truth: Optional[Dict[str, Any]] = None,
        tool_calls: Optional[List[Dict[str, Any]]] = None,
    ) -> float:
        """Evaluate a single dimension.

        Use when: extending the evaluator with custom dimension logic.
        In production, replace heuristics with LLM judgment or human evaluation.
        """
        output_lower: str = output.lower()
        task_type: str = task.get("type", "")

        if dimension.name == "factual_accuracy":
            if ground_truth:
                return self._check_factual_accuracy(output, ground_truth)
            return 0.7  # Default assumption

        elif dimension.name == "completeness":
            required: List[str] = task.get("requirements", [])
            if required:
                covered = sum(1 for r in required if r.lower() in output_lower)
                return covered / len(required)
            return 0.8

        elif dimension.name == "citation_accuracy":
            if task.get("requires_citations"):
                # Look for citation patterns like [1], [Author 2024], [source]
                # Avoid false positives from code brackets or JSON
                citation_pattern = r'\[\d+\]|\[[A-Z][a-z]+(?:\s+(?:et al\.?|&)\s+[A-Z][a-z]+)?\s*[\d,]+\]|\[(?:source|ref|cite)[^\]]*\]'
                import re as _re
                citations_found = _re.findall(citation_pattern, output)
                if len(citations_found) >= 1:
                    return 1.0
                elif any(marker in output_lower for marker in ["according to", "cited in", "reported by"]):
                    return 0.7
                return 0.4
            return 0.8  # Citations not required

        elif dimension.name == "source_quality":
            quality_markers = ["according to", "reported by", "data from", "study"]
            quality_count = sum(1 for m in quality_markers if m in output_lower)
            return min(1.0, 0.5 + quality_count * 0.1)

        elif dimension.name == "tool_efficiency":
            if tool_calls:
                expected_count = self._estimate_expected_tools(task_type)
                actual_count = len(tool_calls)
                if actual_count <= expected_count:
                    return 1.0
                elif actual_count <= expected_count * 1.5:
                    return 0.7
                else:
                    return 0.4
            return 0.8  # No tool calls needed or recorded

        return 0.5  # Default

    def _check_factual_accuracy(
        self, output: str, ground_truth: Dict[str, Any]
    ) -> float:
        """Check output against ground truth.

        Use when: ground truth key_claims are available for comparison.
        """
        if not ground_truth:
            return 0.7

        key_claims: List[str] = ground_truth.get("key_claims", [])
        if not key_claims:
            return 0.7

        output_lower: str = output.lower()
        matched: int = sum(1 for claim in key_claims if claim.lower() in output_lower)

        if matched == len(key_claims):
            return 1.0
        elif matched >= len(key_claims) * 0.7:
            return 0.8
        elif matched >= len(key_claims) * 0.5:
            return 0.6
        else:
            return 0.3

    def _estimate_expected_tools(self, task_type: str) -> int:
        """Estimate expected tool count for task type."""
        estimates: Dict[str, int] = {
            "research": 3,
            "create": 2,
            "analyze": 2,
            "general": 1,
        }
        return estimates.get(task_type, 1)

    def _score_to_level(self, score: float) -> str:
        """Convert numeric score to level name."""
        if score >= 0.9:
            return "excellent"
        elif score >= 0.7:
            return "good"
        elif score >= 0.5:
            return "acceptable"
        elif score >= 0.25:
            return "poor"
        else:
            return "failed"


# ---------------------------------------------------------------------------
# Test Set Management
# ---------------------------------------------------------------------------


class TestSet:
    """Manage evaluation test sets with tagging and complexity stratification.

    Use when: building, filtering, or analyzing collections of evaluation
    test cases. Supports tag-based indexing and complexity distribution
    analysis.
    """

    def __init__(self, name: str) -> None:
        self.name: str = name
        self.tests: List[Dict[str, Any]] = []
        self.tags: Dict[str, List[int]] = {}

    def add_test(self, test: Dict[str, Any]) -> None:
        """Add a test case to the test set.

        Use when: incrementally building a test set from individual cases.
        """
        self.tests.append(test)
        idx: int = len(self.tests) - 1

        for tag in test.get("tags", []):
            if tag not in self.tags:
                self.tags[tag] = []
            self.tags[tag].append(idx)

    def filter(self, **criteria: Any) -> List[Dict[str, Any]]:
        """Filter tests by criteria.

        Use when: selecting a subset of tests matching specific field values.
        """
        results: List[Dict[str, Any]] = []
        for test in self.tests:
            match = True
            for key, value in criteria.items():
                if test.get(key) != value:
                    match = False
                    break
            if match:
                results.append(test)
        return results

    def get_complexity_distribution(self) -> Dict[str, int]:
        """Get distribution of tests by complexity.

        Use when: verifying test set balance across difficulty levels.
        """
        distribution: Dict[str, int] = {}
        for test in self.tests:
            complexity: str = test.get("complexity", "medium")
            distribution[complexity] = distribution.get(complexity, 0) + 1
        return distribution

    def create_standard_tests(self) -> "TestSet":
        """Populate with standard test cases for context engineering evaluation.

        Use when: bootstrapping a test set quickly for initial development.
        """
        tests: List[Dict[str, Any]] = [
            {
                "name": "simple_lookup",
                "input": "What is the capital of France?",
                "expected": {"type": "fact", "answer": "Paris"},
                "complexity": "simple",
                "tags": ["knowledge", "simple"],
            },
            {
                "name": "context_retrieval",
                "input": "Based on the user preferences, recommend a restaurant",
                "context": {
                    "user_preferences": {
                        "cuisine": "Italian",
                        "price_range": "moderate",
                    }
                },
                "complexity": "medium",
                "tags": ["retrieval", "reasoning"],
            },
            {
                "name": "multi_step_reasoning",
                "input": "Analyze the sales data and create a summary report",
                "complexity": "complex",
                "tags": ["analysis", "multi-step"],
            },
        ]

        for test in tests:
            self.add_test(test)

        return self


# ---------------------------------------------------------------------------
# Evaluation Runner
# ---------------------------------------------------------------------------


class EvaluationRunner:
    """Run evaluations across an entire test set and produce summaries.

    Use when: executing a full evaluation pass over a test set, comparing
    agent versions, or generating evaluation reports.
    """

    def __init__(self, evaluator: AgentEvaluator, test_set: TestSet) -> None:
        self.evaluator: AgentEvaluator = evaluator
        self.test_set: TestSet = test_set
        self.results: List[Dict[str, Any]] = []

    def run_all(self, verbose: bool = False) -> Dict[str, Any]:
        """Run evaluation on all tests in the test set.

        Use when: performing a complete evaluation pass.
        """
        self.results = []

        for i, test in enumerate(self.test_set.tests):
            if verbose:
                print(
                    f"Running test {i + 1}/{len(self.test_set.tests)}: {test['name']}"
                )

            result = self.run_test(test)
            self.results.append(result)

        return self.summarize()

    def run_test(self, test: Dict[str, Any]) -> Dict[str, Any]:
        """Run a single evaluation test.

        Use when: evaluating an individual test case outside of a full run.
        In production, replace the simulated output with actual agent execution.
        """
        # In production, run actual agent
        # Here we simulate
        output: str = f"Simulated output for: {test.get('input', '')}"

        evaluation: Dict[str, Any] = self.evaluator.evaluate(
            task=test,
            output=output,
            ground_truth=test.get("expected"),
            tool_calls=[],
        )

        return {
            "test": test,
            "output": output,
            "evaluation": evaluation,
            "passed": evaluation["passed"],
        }

    def summarize(self) -> Dict[str, Any]:
        """Summarize evaluation results with per-dimension averages.

        Use when: generating a report after a full evaluation run.
        """
        if not self.results:
            return {"error": "No results"}

        passed: int = sum(1 for r in self.results if r["passed"])

        # Dimension averages
        dimension_totals: Dict[str, Dict[str, float]] = {}
        for dim_name in self.evaluator.rubric.keys():
            dimension_totals[dim_name] = {"total": 0.0, "count": 0.0}

        for result in self.results:
            for dim_name, score in result["evaluation"]["dimension_scores"].items():
                dimension_totals[dim_name]["total"] += score["score"]
                dimension_totals[dim_name]["count"] += 1

        dimension_averages: Dict[str, float] = {}
        for dim_name, data in dimension_totals.items():
            if data["count"] > 0:
                dimension_averages[dim_name] = data["total"] / data["count"]

        return {
            "total_tests": len(self.results),
            "passed": passed,
            "failed": len(self.results) - passed,
            "pass_rate": passed / len(self.results) if self.results else 0,
            "dimension_averages": dimension_averages,
            "failures": [
                {
                    "test": r["test"]["name"],
                    "score": r["evaluation"]["overall_score"],
                }
                for r in self.results
                if not r["passed"]
            ],
        }


# ---------------------------------------------------------------------------
# Production Monitoring
# ---------------------------------------------------------------------------


class ProductionMonitor:
    """Monitor agent performance in production via sampling.

    Use when: setting up continuous quality monitoring for a deployed agent.
    Samples interactions at a configurable rate and tracks pass rate, average
    score, and alert status.
    """

    def __init__(self, sample_rate: float = 0.01) -> None:
        import random

        self.sample_rate: float = sample_rate
        self._rng: random.Random = random.Random()
        self.samples: List[Dict[str, Any]] = []
        self.alert_thresholds: Dict[str, float] = {
            "pass_rate_warning": 0.85,
            "pass_rate_critical": 0.70,
        }

    def should_sample(self) -> bool:
        """Determine if current interaction should be sampled.

        Use when: deciding at request time whether to evaluate this interaction.
        """
        return self._rng.random() < self.sample_rate

    def record_sample(
        self, query: str, output: str, evaluation: Dict[str, Any]
    ) -> None:
        """Record a production sample for evaluation.

        Use when: storing evaluated production interactions for trend analysis.
        """
        sample: Dict[str, Any] = {
            "query": query[:200],
            "output_preview": output[:200],
            "score": evaluation.get("overall_score", 0),
            "passed": evaluation.get("passed", False),
            "timestamp": time.time(),
        }
        self.samples.append(sample)

    def get_metrics(self) -> Dict[str, Any]:
        """Calculate current metrics from collected samples.

        Use when: checking production health or generating monitoring reports.
        """
        if not self.samples:
            return {"status": "insufficient_data"}

        passed: int = sum(1 for s in self.samples if s["passed"])
        pass_rate: float = passed / len(self.samples)
        avg_score: float = sum(s["score"] for s in self.samples) / len(self.samples)

        status: str = "healthy"
        if pass_rate < self.alert_thresholds["pass_rate_critical"]:
            status = "critical"
        elif pass_rate < self.alert_thresholds["pass_rate_warning"]:
            status = "warning"

        return {
            "sample_count": len(self.samples),
            "pass_rate": pass_rate,
            "average_score": avg_score,
            "status": status,
            "alerts": self._generate_alerts(pass_rate, avg_score),
        }

    def _generate_alerts(
        self, pass_rate: float, avg_score: float
    ) -> List[Dict[str, str]]:
        """Generate alerts based on metrics."""
        alerts: List[Dict[str, str]] = []

        if pass_rate < self.alert_thresholds["pass_rate_critical"]:
            alerts.append(
                {
                    "type": "critical",
                    "message": f"Pass rate ({pass_rate:.2f}) below critical threshold",
                }
            )
        elif pass_rate < self.alert_thresholds["pass_rate_warning"]:
            alerts.append(
                {
                    "type": "warning",
                    "message": f"Pass rate ({pass_rate:.2f}) below warning threshold",
                }
            )

        if avg_score < 0.6:
            alerts.append(
                {
                    "type": "quality",
                    "message": f"Average score ({avg_score:.2f}) indicates quality issues",
                }
            )

        return alerts


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("=== Agent Evaluation Framework Demo ===\n")

    # 1. Create evaluator with default rubric
    evaluator = AgentEvaluator()
    print(f"Rubric dimensions: {list(evaluator.rubric.keys())}\n")

    # 2. Build a standard test set
    test_set = TestSet("demo").create_standard_tests()
    print(f"Test set: {test_set.name}")
    print(f"Test count: {len(test_set.tests)}")
    print(f"Complexity distribution: {test_set.get_complexity_distribution()}\n")

    # 3. Run evaluation
    runner = EvaluationRunner(evaluator, test_set)
    summary = runner.run_all(verbose=True)

    print(f"\n--- Summary ---")
    print(f"Total: {summary['total_tests']}")
    print(f"Passed: {summary['passed']}")
    print(f"Failed: {summary['failed']}")
    print(f"Pass rate: {summary['pass_rate']:.1%}")
    print(f"Dimension averages: {summary['dimension_averages']}")

    if summary["failures"]:
        print(f"\nFailures:")
        for f in summary["failures"]:
            print(f"  - {f['test']}: {f['score']:.2f}")
