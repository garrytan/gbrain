import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "scripts" / "compression_evaluator.py"
)
MODULE_SPEC = importlib.util.spec_from_file_location(
    "compression_evaluator", MODULE_PATH
)
if MODULE_SPEC is None or MODULE_SPEC.loader is None:
    raise RuntimeError(f"Unable to load compression_evaluator.py from {MODULE_PATH}")
COMPRESSION_EVALUATOR = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(COMPRESSION_EVALUATOR)


class CompressionEvaluatorTests(unittest.TestCase):
    def test_json_ground_truth_terms_score_when_response_mentions_artifacts(
        self,
    ) -> None:
        evaluator = COMPRESSION_EVALUATOR.CompressionEvaluator()

        rich_score = evaluator._heuristic_score(
            {"id": "artifact_files_modified"},
            "We modified src/app.py and updated README.md during the session.",
            '[{"path": "src/app.py", "operation": "modified"}, {"path": "README.md", "operation": "updated"}]',
        )
        poor_score = evaluator._heuristic_score(
            {"id": "artifact_files_modified"},
            "We changed some files but I do not remember which ones.",
            '[{"path": "src/app.py", "operation": "modified"}, {"path": "README.md", "operation": "updated"}]',
        )

        self.assertGreater(rich_score, poor_score)
        self.assertGreaterEqual(rich_score, 4.0)

    def test_plain_text_ground_truth_still_uses_substring_match(self) -> None:
        evaluator = COMPRESSION_EVALUATOR.CompressionEvaluator()

        exact_score = evaluator._heuristic_score(
            {"id": "continuity_work_state"},
            "Next: fix the websocket timeout before rerunning tests.",
            "fix the websocket timeout",
        )
        missing_score = evaluator._heuristic_score(
            {"id": "continuity_work_state"},
            "Next: inspect logs again.",
            "fix the websocket timeout",
        )

        self.assertGreater(exact_score, missing_score)


if __name__ == "__main__":
    unittest.main()
