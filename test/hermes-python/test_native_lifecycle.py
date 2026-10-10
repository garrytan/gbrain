"""Exercise the pinned provider lifecycle against the production GBrain HTTP/PGLite server."""
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

import test_provider as contract


class RealGBrainLifecycle(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="hermes-live-profile-"))
        contract.CONFIGS[str(self.home)] = {"memory": {"provider": "gbrain", "gbrain": {
            "url": os.environ["GBRAIN_NATIVE_MCP_URL"], "heartbeat_seconds": 0,
            "budget_tokens": 512,
        }}}

    def tearDown(self):
        contract.CONFIGS.pop(str(self.home), None)
        shutil.rmtree(self.home, ignore_errors=True)

    def test_real_write_recall_correct_withdraw_and_visibility(self):
        with contract.profile(self.home, os.environ["GBRAIN_NATIVE_MCP_TOKEN"]):
            provider = contract.plugin.GBrainMemoryProvider()
            self.assertTrue(provider.is_available())
            provider.initialize("fresh-native-session", hermes_home=str(self.home))
            schemas = provider.get_tool_schemas()
            delta = provider._call("delta", {"budget_tokens": 128}, session_id="fresh-native-session")
            self.assertEqual(delta.get("protocol_version"), 1)
            self.assertIn("HERMES_WORLD_FIXTURE_7241", provider.prefetch("HERMES_WORLD_FIXTURE_7241"))
            provider.on_pre_compress([])
            self.assertIn("HERMES_WORLD_FIXTURE_7241", provider.prefetch("HERMES_WORLD_FIXTURE_7241"))
            provider.on_session_switch("fresh-native-session-resumed", reason="resume")
            provider.prefetch("HERMES_WORLD_FIXTURE_7241")

            first = json.loads(provider.handle_tool_call("gbrain_remember", {
                "fact": "Synthetic Hermes acceptance marker is blue-7241.",
                "provenance": "synthetic native provider acceptance fixture",
                "entity": "hermes-acceptance", "infer_entity": False, "visibility": "world",
            }))
            self.assertIn(first.get("status"), {"inserted", "duplicate", "superseded"}, first)
            fact_id = first.get("fact_id") or first.get("id")
            self.assertTrue(fact_id, first)
            recalled = json.loads(provider.handle_tool_call("gbrain_recall", {
                "entity": "hermes-acceptance", "limit": 20,
            }))
            facts = recalled.get("facts", [])
            self.assertTrue(any("blue-7241" in row.get("fact", "") for row in facts), recalled)
            fact = next(row for row in facts if "blue-7241" in row.get("fact", ""))
            self.assertIn("trust_tier", fact)
            self.assertIn("provenance", fact)

            corrected = json.loads(provider.handle_tool_call("gbrain_remember", {
                "fact": "Synthetic Hermes acceptance marker is green-7241.",
                "provenance": "synthetic correction fixture",
                "entity": "hermes-acceptance", "infer_entity": False,
                "visibility": "world", "replaces": str(fact_id),
            }))
            self.assertIn(corrected.get("status"), {"inserted", "superseded"}, corrected)
            corrected_id = corrected.get("fact_id") or corrected.get("id")
            self.assertTrue(corrected_id, corrected)
            provider.handle_tool_call("gbrain_forget", {"id": str(corrected_id)})
            after_withdrawal = json.loads(provider.handle_tool_call("gbrain_recall", {
                "entity": "hermes-acceptance", "limit": 20,
            }))
            self.assertFalse(any("green-7241" in row.get("fact", "") for row in after_withdrawal.get("facts", [])), after_withdrawal)

            private = provider.handle_tool_call("gbrain_recall", {"query": "HERMES_PRIVATE_FIXTURE_9813"})
            self.assertNotIn("HERMES_PRIVATE_FIXTURE_9813", private)
            self.assertIn("HERMES_WORLD_FIXTURE_7241", provider.handle_tool_call(
                "gbrain_recall", {"query": "HERMES_WORLD_FIXTURE_7241"}))
            self.assertEqual(schemas, provider.get_tool_schemas())
            provider.shutdown()

    def test_two_real_profile_secrets_and_disjoint_server_grants(self):
        other = self.home.parent / (self.home.name + "-read-only")
        other.mkdir()
        contract.CONFIGS[str(other)] = {"memory": {"provider": "gbrain", "gbrain": {
            "url": os.environ["GBRAIN_NATIVE_MCP_URL"], "heartbeat_seconds": 0,
        }}}
        try:
            with contract.profile(self.home, os.environ["GBRAIN_NATIVE_MCP_TOKEN"]):
                writer = contract.plugin.GBrainMemoryProvider()
                writer.initialize("writer-profile", hermes_home=str(self.home))
                self.assertEqual(writer._client._token(), os.environ["GBRAIN_NATIVE_MCP_TOKEN"])
                writer.prefetch("HERMES_WORLD_FIXTURE_7241")
            with contract.profile(other, os.environ["GBRAIN_NATIVE_READ_TOKEN"]):
                reader = contract.plugin.GBrainMemoryProvider()
                reader.initialize("reader-profile", hermes_home=str(other))
                self.assertEqual(reader._client._token(), os.environ["GBRAIN_NATIVE_READ_TOKEN"])
                self.assertIn("HERMES_WORLD_FIXTURE_7241", reader.prefetch("HERMES_WORLD_FIXTURE_7241"))
                denied = json.loads(reader.handle_tool_call("gbrain_remember", {
                    "fact": "must not write", "provenance": "synthetic grant test",
                    "entity": "hermes-acceptance", "infer_entity": False, "visibility": "world",
                }))
                self.assertTrue(denied.get("error") or denied.get("code"), denied)
                reader.shutdown()
            with contract.profile(self.home, os.environ["GBRAIN_NATIVE_MCP_TOKEN"]):
                self.assertEqual(writer._client._token(), os.environ["GBRAIN_NATIVE_MCP_TOKEN"])
                writer.shutdown()
        finally:
            contract.CONFIGS.pop(str(other), None)
            shutil.rmtree(other, ignore_errors=True)

    def test_capture_opt_in_respects_server_consent_gate_and_local_revoke(self):
        with contract.profile(self.home, os.environ["GBRAIN_NATIVE_MCP_TOKEN"]):
            config = contract.CONFIGS[str(self.home)]["memory"]["gbrain"]
            provider = contract.plugin.GBrainMemoryProvider()
            provider.initialize("capture-off", hermes_home=str(self.home))
            provider._client.tools()
            calls = []
            original_call = provider._client.call
            def record_call(name, arguments):
                calls.append(name)
                return original_call(name, arguments)
            provider._client.call = record_call
            provider.sync_turn("synthetic off", "assistant", turn_author={"is_bot": False})
            self.assertNotIn("capture", calls)
            config["capture"] = True
            provider = contract.plugin.GBrainMemoryProvider()
            provider.initialize("capture-on", hermes_home=str(self.home))
            provider._client.tools()
            calls = []
            original_call = provider._client.call
            def record_call(name, arguments):
                calls.append(name)
                return original_call(name, arguments)
            provider._client.call = record_call
            provider.sync_turn("synthetic denied", "assistant", turn_author={"is_bot": False})
            self.assertIn("capture", calls)
            self.assertIn("capture", provider.prefetch("hi"))
            config["capture"] = False
            provider = contract.plugin.GBrainMemoryProvider()
            provider.initialize("capture-revoked", hermes_home=str(self.home))
            provider._client.tools()
            calls = []
            original_call = provider._client.call
            def record_call(name, arguments):
                calls.append(name)
                return original_call(name, arguments)
            provider._client.call = record_call
            provider.sync_turn("synthetic revoked", "assistant", turn_author={"is_bot": False})
            self.assertNotIn("capture", calls)
            provider.shutdown()


if __name__ == "__main__":
    unittest.main(verbosity=2)
