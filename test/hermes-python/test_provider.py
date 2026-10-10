"""Contract tests use the real pinned Hermes ABC, home scope and secret scope.

Run with Hermes on PYTHONPATH. Only config persistence is replaced by an in-memory
profile fixture; HTTP requests use a real isolated loopback MCP server.
"""

import contextlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from agent.memory_provider import MemoryProvider
from agent.secret_scope import set_secret_scope, reset_secret_scope, set_multiplex_active
from hermes_constants import get_hermes_home, set_hermes_home_override, reset_hermes_home_override

CONFIGS = {}
config_module = types.ModuleType("hermes_cli.config")
config_module.load_config = lambda: CONFIGS.get(str(get_hermes_home()), {})
config_module.save_config = lambda config, **kwargs: CONFIGS.__setitem__(str(get_hermes_home()), config)
sys.modules.setdefault("hermes_cli", types.ModuleType("hermes_cli"))
sys.modules["hermes_cli.config"] = config_module

root = Path(__file__).resolve().parents[2] / "integrations" / "hermes"
spec = importlib.util.spec_from_file_location("gbrain_hermes_contract", root / "__init__.py", submodule_search_locations=[str(root)])
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
spec.loader.exec_module(plugin)
from gbrain_hermes_contract.mcp import MCPError, HTTPMCP


@contextlib.contextmanager
def profile(home, token="test-profile-token"):
    h = set_hermes_home_override(home)
    s = set_secret_scope({"GBRAIN_MCP_TOKEN": token}, profile_home=str(home))
    try:
        yield
    finally:
        reset_secret_scope(s)
        reset_hermes_home_override(h)


class Server:
    def __init__(self):
        self.calls = []
        self.payloads = {}
        self.ambient = False
        self.names = {"recall", "context_pack", "delta", "remember", "forget", "entity", "get_page", "capture"}
        self.response_mode = "json"
        self.content_type = ""
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                fixture.calls.append((self.headers.get("Authorization"), body))
                method, params = body["method"], body.get("params", {})
                if method == "notifications/initialized":
                    self.send_response(204)
                    self.end_headers()
                    return
                result = fixture.result(body)
                envelope = {"jsonrpc": "2.0", "id": body.get("id"), "result": result}
                self.send_response(200)
                self.send_header("Content-Type", fixture.content_type or ("text/event-stream" if fixture.response_mode.startswith("sse") else "application/json"))
                self.end_headers()
                if fixture.response_mode == "sse_array":
                    self.wfile.write(b"data: []\n\n")
                elif fixture.response_mode == "sse":
                    self.wfile.write(b"data: " + json.dumps(envelope).encode() + b"\n\n")
                else:
                    self.wfile.write(json.dumps(envelope).encode())

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:" + str(self.server.server_port) + "/mcp"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def result(self, body):
        method, params = body["method"], body.get("params", {})
        if method == "initialize":
            return {"protocolVersion": "2025-03-26", "capabilities": {"tools": {}}}
        if method == "tools/list":
            tools = []
            for name in self.names:
                properties = {"session_id": {"type": "string"}} if name in {"recall", "context_pack", "delta"} else {}
                if name in {"recall", "remember", "get_page", "capture"}:
                    properties["source_id"] = {"type": "string"}
                if name == "capture" and self.ambient:
                    properties["ambient"] = {"type": "boolean"}
                tools.append({"name": name, "inputSchema": {"type": "object", "properties": properties}})
            result = {"tools": tools}
            if hasattr(self, "next_cursor"):
                result["nextCursor"] = self.next_cursor
            return result
        payload = self.payloads.get(params["name"], {"protocol_version": 1, "facts": [], "results": []})
        if self.response_mode == "bad_content":
            return payload
        result = {"content": [{"type": "text", "text": json.dumps(payload)}]}
        if self.response_mode == "structured":
            result["structuredContent"] = payload
        if getattr(self, "response_meta", None):
            result["_meta"] = self.response_meta
            result["content"].append({"type": "text", "text": "[gbrain notice fixture] Follow the host fix."})
        return result

    def ops(self):
        return [(body["params"]["name"], body["params"]["arguments"]) for _, body in self.calls if body["method"] == "tools/call"]


class ContractTests(unittest.TestCase):
    def test_structured_content_keeps_host_notices_and_invalid_rows_fail_visibly(self):
        self.server.response_mode = "structured"
        self.server.response_meta = {"retrieval": {"degraded": "keyword_only"}}
        self.server.payloads["recall"] = {"facts": [], "_meta": {"warnings": ["Payload warning must survive"]}}
        with profile(self.home):
            p = self.provider()
            text = p.prefetch("acme-example")
            self.assertIn("Follow the host fix", text)
            self.assertIn("keyword_only", text)
            self.assertIn("Payload warning must survive", text)
            self.server.payloads["recall"] = {"facts": None}
            self.assertIn("invalid_response", p.prefetch("acme-example"))
            self.server.next_cursor = {"malformed": "cursor"}
            self.assertIn("invalid_response", self.provider().prefetch("acme-example"))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name) / "one"
        self.other = Path(self.temp.name) / "two"
        self.home.mkdir()
        self.other.mkdir()
        self.server = Server()
        for home in (self.home, self.other):
            CONFIGS[str(home)] = {"memory": {"provider": "gbrain", "gbrain": {"url": self.server.url, "heartbeat_seconds": 0}}}
        set_multiplex_active(True)

    def tearDown(self):
        set_multiplex_active(False)
        self.server.close()
        self.temp.cleanup()

    def provider(self, sid="session-one"):
        p = plugin.GBrainMemoryProvider()
        self.assertIsInstance(p, MemoryProvider)
        self.assertTrue(p.is_available())
        p.initialize(sid, hermes_home=str(get_hermes_home()), platform="cli")
        return p

    def test_discovery_registration_and_schemas_are_network_free_and_static(self):
        registered = []
        ctx = types.SimpleNamespace(register_memory_provider=registered.append)
        with profile(self.home):
            plugin.register(ctx)
            p = registered[0]
            before = p.get_tool_schemas()
            self.assertTrue(p.is_available())
            self.assertEqual(self.server.calls, [])
            p.initialize("one", hermes_home=str(self.home))
            prompt = p.system_prompt_block()
            p.prefetch("acme-example")
            p.on_pre_compress([])
            p.on_session_switch("two")
            p.prefetch("acme-example")
            self.assertEqual(before, p.get_tool_schemas())
            self.assertEqual(prompt, p.system_prompt_block())

    def test_remember_schema_advertises_explicit_correction_fields(self):
        with profile(self.home):
            p = self.provider()
            schema = next(tool["parameters"] for tool in p.get_tool_schemas() if tool["name"] == "gbrain_remember")
            self.assertFalse(schema["additionalProperties"])
            self.assertEqual(schema["properties"].get("replaces", {}).get("type"), "string")
            self.assertEqual(schema["properties"].get("infer_entity", {}).get("type"), "boolean")
            args = {"fact": "corrected color", "provenance": "explicit correction", "replaces": "12", "infer_entity": False}
            self.assertLessEqual(set(args), set(schema["properties"]))
            p.handle_tool_call("gbrain_remember", args)
            self.assertEqual(self.server.ops()[-1][1]["replaces"], "12")

    def test_recall_is_keyless_and_exposes_provenance_and_degradation(self):
        self.server.payloads["recall"] = {"protocol_version": 1, "facts": [{"fact": "acme-example uses blue", "fact_id": "12", "provenance": "user request", "trust_tier": "verified"}], "results": [], "search_degraded": "keyword_only"}
        with profile(self.home):
            p = self.provider()
            text = p.prefetch("acme-example")
            self.assertIn("blue", text)
            self.assertIn("user request", text)
            self.assertIn("verified", text)
            self.assertIn("trust_tier", text)
            self.assertIn("keyword_only", text)
            self.assertEqual(p.recall_status().count, 1)
            p.prefetch("hi")
            self.assertIsNone(p.recall_status())

    def test_session_start_post_compression_resume_and_profile_cursors(self):
        with profile(self.home, "profile-one"):
            p = self.provider()
            p.prefetch("work")
            p.prefetch("work")
            p.on_pre_compress([])
            p.prefetch("work")
            p.on_session_switch("session-two", reason="resume")
            p.prefetch("work")
            packs = [a for n, a in self.server.ops() if n == "context_pack"]
            self.assertEqual(len(packs), 3)
            self.assertEqual(packs[0]["session_id"], packs[1]["session_id"])
            self.assertNotEqual(packs[1]["session_id"], packs[2]["session_id"])
        count = len(self.server.calls)
        with profile(self.other, "profile-two"):
            self.assertIn("profile_mismatch", p.prefetch("work"))
            self.assertEqual(len(self.server.calls), count)
            other = self.provider()
            other.prefetch("work")
            self.assertNotEqual(other._remote_session(), packs[0]["session_id"])
        self.assertEqual({header for header, _ in self.server.calls}, {"Bearer profile-one", "Bearer profile-two"})

    def test_profile_mismatch_does_not_drain_or_disclose_queued_private_notice(self):
        with profile(self.home):
            p = self.provider()
            p._state().notices.append("[gbrain notice capture_pending] private-profile-one-receipt")
        with profile(self.other):
            text = p.prefetch("work")
            self.assertIn("profile_mismatch", text)
            self.assertNotIn("private-profile-one-receipt", text)
            self.assertEqual(self.server.calls, [])
        with profile(self.home):
            self.assertIn("private-profile-one-receipt", p.prefetch("work"))
            self.assertNotIn("private-profile-one-receipt", p.prefetch("work"))

    def test_capture_requires_local_opt_in_human_primary_and_server_schema(self):
        with profile(self.home):
            p = self.provider()
            p.sync_turn("remember this", "response", turn_author={"is_bot": False})
            self.assertEqual(self.server.calls, [])
            CONFIGS[str(self.home)]["memory"]["gbrain"]["capture"] = True
            p = self.provider()
            p.sync_turn("text", "response", turn_author={"is_bot": True})
            p.sync_turn("text", "response", turn_author={})
            self.assertEqual(self.server.calls, [])
            p.sync_turn("text", "response", turn_author={"is_bot": False})
            self.assertNotIn("capture", [name for name, _ in self.server.ops()])
            self.assertIn("capture_unavailable", p.prefetch("hi"))
            self.server.ambient = True
            p = self.provider()
            p.sync_turn("text", "response", turn_author={"is_bot": False})
            name, args = self.server.ops()[-1]
            self.assertEqual(name, "capture")
            self.assertIs(args["ambient"], True)
            self.assertIn("## User\ntext", args["content"])
            self.assertIn("## Assistant\nresponse", args["content"])
            first_id = args["request_id"]
            p.sync_turn("text", "response", turn_author={"is_bot": False})
            self.assertEqual(self.server.ops()[-1][1]["request_id"], first_id)
            p.sync_turn("ordinary human", "response")
            self.assertEqual(self.server.ops()[-1][0], "capture")

    def test_explicit_remember_still_works_with_capture_off_and_forget_error_preserved(self):
        self.server.payloads["remember"] = {"protocol_version": 1, "id": "12", "status": "inserted"}
        self.server.payloads["forget"] = {"error": "scope_denied", "message": "Read-only token", "suggestion": "Ask host owner", "protocol_version": 1}
        with profile(self.home):
            p = self.provider()
            self.assertEqual(json.loads(p.handle_tool_call("gbrain_remember", {"fact": "blue", "provenance": "user request"}))["status"], "inserted")
            self.assertEqual(self.server.ops()[-1][1]["visibility"], "private")
            p.handle_tool_call("gbrain_remember", {"fact": "shared blue", "provenance": "user request", "visibility": "world"})
            self.assertEqual(self.server.ops()[-1][1]["visibility"], "world")
            result = json.loads(p.handle_tool_call("gbrain_forget", {"id": "12"}))
            self.assertEqual(result["error"], "scope_denied")
            self.assertEqual(result["suggestion"], "Ask host owner")

    def test_narrow_source_never_falls_back_on_unsupported_boundary(self):
        CONFIGS[str(self.home)]["memory"]["gbrain"]["source_id"] = "notes-example"
        with profile(self.home):
            p = self.provider()
            self.assertIn("source_selector_unsupported", p.prefetch("work"))
            ops = self.server.ops()
            self.assertEqual([name for name, _ in ops], ["recall"])
            self.assertEqual(ops[0][1]["source_id"], "notes-example")

    def test_sse_and_malformed_remote_shapes(self):
        with profile(self.home):
            self.server.response_mode = "sse"
            p = self.provider()
            self.assertEqual(p.prefetch("work"), "")
            self.server.content_type = "TEXT/EVENT-STREAM; charset=utf-8"
            p = self.provider()
            self.assertEqual(p.prefetch("work"), "")
            self.server.content_type = ""
            self.server.response_mode = "sse_array"
            p = self.provider()
            self.assertIn("invalid_response", p.prefetch("work"))
            self.server.response_mode = "json"
            client = HTTPMCP(self.server.url, lambda: "fixture")
            client.tools()
            self.server.response_mode = "bad_content"
            self.server.payloads["recall"] = {"content": [None]}
            with self.assertRaises(MCPError) as error:
                client.call("recall", {})
            self.assertEqual(error.exception.code, "invalid_response")

    def test_bool_config_does_not_accept_truthy_strings(self):
        CONFIGS[str(self.home)]["memory"]["gbrain"]["capture"] = "false"
        with profile(self.home):
            p = plugin.GBrainMemoryProvider()
            self.assertFalse(p.is_available())
            self.assertIn("boolean", p.unavailable_reason())

    def test_failure_is_visible_and_shutdown_refuses_network(self):
        self.server.payloads["recall"] = {"error": "unavailable", "message": "Index unavailable", "suggestion": "Retry later", "protocol_version": 1}
        with profile(self.home):
            p = self.provider()
            self.assertIn("Retry later", p.prefetch("work"))
            p.shutdown()
            count = len(self.server.calls)
            self.assertIn("unavailable", p.prefetch("work"))
            self.assertEqual(len(self.server.calls), count)

    def test_delta_is_per_session_and_degraded_notices_survive(self):
        CONFIGS[str(self.home)]["memory"]["gbrain"]["heartbeat_seconds"] = 300
        self.server.payloads["delta"] = {"protocol_version": 1, "text": "new page", "has_more": True, "degraded_reason": "facts", "notices": [{"code": "delta_incomplete", "fix": {"next": "wait"}}]}
        with profile(self.home):
            p = self.provider()
            text = p.prefetch("work")
            self.assertIn("new page", text)
            self.assertIn("delta_incomplete", text)
            self.assertIn("has_more", text)
            p.prefetch("work")
            self.assertEqual(sum(name == "delta" for name, _ in self.server.ops()), 1)
            p.on_session_switch("second")
            p.prefetch("work")
            deltas = [args for name, args in self.server.ops() if name == "delta"]
            self.assertEqual(len(deltas), 2)
            self.assertNotEqual(deltas[0]["session_id"], deltas[1]["session_id"])

    def test_cron_and_subagent_capture_is_suppressed(self):
        CONFIGS[str(self.home)]["memory"]["gbrain"]["capture"] = True
        self.server.ambient = True
        with profile(self.home):
            for context in ("cron", "subagent", "flush"):
                p = self.provider()
                p.initialize("one", hermes_home=str(self.home), agent_context=context)
                p.sync_turn("human text", "response")
            self.assertEqual(self.server.calls, [])

    def test_redirects_are_never_followed(self):
        from gbrain_hermes_contract.mcp import _NoRedirect
        self.assertIsNone(_NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://other.example/mcp"))

    def test_combined_budget_preserves_degraded_meta_and_extra_blocks(self):
        CONFIGS[str(self.home)]["memory"]["gbrain"]["budget_tokens"] = 200
        self.server.response_meta = {"retrieval": {"degraded": [{"stage": "embed_unavailable"}]}, "warnings": ["Index is incomplete"]}
        self.server.payloads["context_pack"] = {"protocol_version": 1, "text": "pack " * 300}
        self.server.payloads["recall"] = {"protocol_version": 1, "facts": [{"fact": "fact " * 300}], "results": []}
        with profile(self.home):
            p = self.provider()
            text = p.prefetch("work")
            self.assertLessEqual(len(text), 800)
            self.assertIn("embed_unavailable", text)
            self.assertIn("context_budget", text)

    def test_session_end_clears_state_and_session_cache_is_bounded(self):
        with profile(self.home):
            p = self.provider()
            for index in range(100):
                p.on_session_switch("sid-" + str(index))
            self.assertEqual(len(p._sessions), 32)
            p.on_session_end([])
            self.assertEqual(len(p._sessions), 31)
            p.shutdown()
            self.assertEqual(len(p._sessions), 0)

    def test_oversized_delta_is_never_discarded_after_cursor_advances(self):
        CONFIGS[str(self.home)]["memory"]["gbrain"].update({"heartbeat_seconds": 300, "budget_tokens": 200})
        evidence = "first delivered change\n" + "thread " * 300 + "\nlast delivered change"
        self.server.payloads["delta"] = {"protocol_version": 1, "text": evidence,
            "facts": [{"fact_id": "42", "provenance": "saved-user-request"}], "has_more": True,
            "next_cursor": {"cursor": "opaque-continuation"}, "cursor_arms": {"pages": {"next": "saved-page-position"}},
            "threads": [{"provenance": "delivered-thread-source"}]}
        with profile(self.home):
            p = self.provider()
            text = p.prefetch("work")
            self.assertIn(evidence, text)
            self.assertIn("saved-user-request", text)
            self.assertIn("opaque-continuation", text)
            self.assertIn("saved-page-position", text)
            self.assertIn("delivered-thread-source", text)
            self.assertIn("has_more", text)
            self.assertIn("context_budget", text)
            budgets = [args["budget_tokens"] for name, args in self.server.ops() if name in {"delta", "recall", "context_pack"}]
            self.assertEqual(budgets, [66, 66, 66])

    def test_expired_read_session_reconnects_once_and_writes_never_retry(self):
        from unittest.mock import patch
        with profile(self.home):
            client = HTTPMCP(self.server.url, lambda: "fixture")
            client.tools()
            request = client._request
            calls = []
            def expire(method, params=None, **kwargs):
                calls.append(method)
                if method == "tools/call" and calls.count(method) == 1:
                    raise MCPError("http_404", "Session expired")
                return request(method, params, **kwargs)
            with patch.object(client, "_request", expire):
                client.call("recall", {})
            self.assertEqual(calls.count("tools/call"), 2)
            calls.clear()
            with patch.object(client, "_request", expire), self.assertRaises(MCPError):
                client.call("remember", {"fact": "text", "provenance": "user"})
            self.assertEqual(calls, ["tools/call"])

    def test_response_size_limit_and_deadline_surface_errors(self):
        from unittest.mock import patch
        with profile(self.home):
            client = HTTPMCP(self.server.url, lambda: "fixture")
            client.tools()
            self.server.payloads["recall"] = {"text": "x" * (2 * 1024 * 1024 + 100)}
            with self.assertRaises(MCPError) as error:
                client.call("recall", {})
            self.assertEqual(error.exception.code, "response_too_large")
            self.server.payloads["recall"] = {"facts": []}
            with patch("gbrain_hermes_contract.mcp.time.monotonic", side_effect=[0, 10]), self.assertRaises(MCPError) as error:
                client.call("recall", {})
            self.assertEqual(error.exception.code, "timeout")

    def test_prefetch_deadline_keeps_delivered_delta_when_later_recall_times_out(self):
        from unittest.mock import patch
        CONFIGS[str(self.home)]["memory"]["gbrain"]["heartbeat_seconds"] = 300
        self.server.payloads["delta"] = {"text": "delivered change", "has_more": True}
        with profile(self.home):
            p = self.provider()
            p._client.tools()
            clock = [1000.0]
            request = p._client._request
            def slow_recall(method, params=None, **kwargs):
                if method == "tools/call" and params["name"] == "recall":
                    clock[0] += 10
                return request(method, params, **kwargs)
            with patch("gbrain_hermes_contract.mcp.time.monotonic", side_effect=lambda: clock[0]), patch.object(p._client, "_request", slow_recall):
                text = p.prefetch("work")
            self.assertIn("delivered change", text)
            self.assertIn("has_more", text)
            self.assertIn("timeout", text)
            self.assertEqual([name for name, _ in self.server.ops()], ["context_pack", "delta"])
            p.handle_tool_call("gbrain_recall", {"query": "work"})
            self.assertEqual(self.server.ops()[-1][0], "recall")


if __name__ == "__main__":
    unittest.main()
