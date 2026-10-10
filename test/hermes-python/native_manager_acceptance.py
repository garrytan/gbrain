"""Native profile installation -> Hermes MemoryManager -> real GBrain HTTP/PGLite.

No configuration-module replacement, network response mock, model or live user
store. The child fixture accepts bounded commands only over its private stdin.
"""
from __future__ import annotations

import contextlib
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest

PIN = "46d7718a52ff33accb15dc0501736fbdb6833cab"
REPO = Path(__file__).resolve().parents[2]
checkout = Path(os.environ["HERMES_API_CHECKOUT"]).resolve()
if subprocess.check_output(["git", "-C", str(checkout), "rev-parse", "HEAD"], text=True).strip() != PIN:
    raise RuntimeError("The native Hermes acceptance checkout is not pinned")
sys.path.insert(0, str(checkout))
from agent.memory_manager import MemoryManager
from agent.secret_scope import set_secret_scope, reset_secret_scope, set_multiplex_active
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from hermes_cli.config import load_config, save_config
from plugins.memory import load_memory_provider


@contextlib.contextmanager
def scope(home, token):
    h = set_hermes_home_override(home)
    s = set_secret_scope({"GBRAIN_MCP_TOKEN": token}, profile_home=str(home))
    try:
        yield
    finally:
        reset_secret_scope(s)
        reset_hermes_home_override(h)


class NativeManagerAcceptance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="hermes-manager-acceptance-")
        cls.addClassCleanup(cls.temp.cleanup)
        cls.root = Path(cls.temp.name)
        cls.data_dir = cls.root / "durable-pglite"
        cls.stderr = (cls.root / "server.log").open("w+")
        cls.addClassCleanup(cls.stderr.close)
        server_env = os.environ.copy()
        server_env["GBRAIN_HERMES_FIXTURE_DATA_DIR"] = str(cls.data_dir)
        cls.server_env = server_env
        cls.server = subprocess.Popen(
            [shutil.which("bun"), "test/helpers/hermes-provider-server.ts"], cwd=REPO,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=cls.stderr,
            text=True, bufsize=1, env=server_env,
        )
        cls.addClassCleanup(cls.stop_server)
        cls.lines = queue.Queue()
        def read_lines():
            for line in cls.server.stdout:
                try:
                    cls.lines.put(json.loads(line))
                except json.JSONDecodeError:
                    continue
        cls.reader = threading.Thread(target=read_lines, daemon=True)
        cls.reader.start()
        cls.ready = cls.lines.get(timeout=120)
        if not cls.ready.get("sourceTokens"):
            raise RuntimeError("Native fixture did not return source-scoped grants")
        cls.profiles = []
        for index, grant in enumerate(cls.ready["sourceTokens"]):
            home = cls.root / f"profile-{index}"
            home.mkdir()
            (home / "SOUL.md").write_text("Synthetic identity that installation must preserve.\n")
            credential = cls.root / f"credential-{index}"
            credential.touch(mode=0o600)
            credential.write_text(grant["token"])
            installed = subprocess.run(
                [shutil.which("bun"), "src/cli.ts", "hermes", "setup", "--hermes-home", str(home),
                 "--url", cls.ready["url"], "--token-file", str(credential), "--json"],
                cwd=REPO, capture_output=True, text=True, timeout=90,
            )
            if installed.returncode:
                raise RuntimeError("Native profile setup failed: " + installed.stderr[-1200:])
            receipt = json.loads(installed.stdout)
            if receipt.get("status") != "installed":
                raise RuntimeError("Native setup did not return an installed receipt")
            cls.profiles.append((home, grant))
        set_multiplex_active(True)
        cls.addClassCleanup(set_multiplex_active, False)

    @classmethod
    def stop_server(cls):
        if cls.server.stdin:
            cls.server.stdin.close()
        try:
            cls.server.wait(timeout=20)
        except subprocess.TimeoutExpired:
            cls.server.kill()
            cls.server.wait(timeout=10)
        if cls.server.stdout:
            cls.server.stdout.close()

    @classmethod
    def control(cls, action, **kwargs):
        cls.server.stdin.write(json.dumps({"action": action, **kwargs}) + "\n")
        cls.server.stdin.flush()
        result = cls.lines.get(timeout=30)
        if result.get("control") != action:
            raise RuntimeError("Unexpected fixture control response")
        return result["result"]

    @classmethod
    def restart_fixture_process(cls):
        """Replace the actual Bun/PGLite host process while retaining its on-disk data dir."""
        old = cls.server
        if old.stdin:
            old.stdin.close()
        old.wait(timeout=30)
        if old.stdout:
            old.stdout.close()
        cls.server_env["GBRAIN_HERMES_FIXTURE_REOPEN"] = "1"
        cls.server = subprocess.Popen(
            [shutil.which("bun"), "test/helpers/hermes-provider-server.ts"], cwd=REPO,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=cls.stderr,
            text=True, bufsize=1, env=cls.server_env,
        )
        cls.lines = queue.Queue()
        def read_lines():
            for line in cls.server.stdout:
                try:
                    cls.lines.put(json.loads(line))
                except json.JSONDecodeError:
                    continue
        cls.reader = threading.Thread(target=read_lines, daemon=True)
        cls.reader.start()
        try:
            cls.ready = cls.lines.get(timeout=120)
        except queue.Empty:
            cls.stderr.flush()
            cls.stderr.seek(0)
            raise RuntimeError("Restarted native fixture failed to become ready: " + cls.stderr.read()[-5000:]) from None
        if not cls.ready.get("sourceTokens"):
            raise RuntimeError("Restarted native fixture did not return source-scoped grants")
        return cls.ready

    def manager(self, home, sid):
        provider = load_memory_provider("gbrain")
        self.assertIsNotNone(provider, "Native discovery must load the installed provider")
        self.assertTrue(provider.is_available())
        manager = MemoryManager()
        manager.add_provider(provider)
        manager.initialize_all(sid, hermes_home=str(home), agent_context="primary", platform="cli")
        self.assertIs(manager.get_provider("gbrain"), provider)
        self.assertTrue(manager.has_tool("gbrain_remember"))
        return manager

    def test_01_installed_manager_remembers_across_fresh_sessions_and_corrects_withdraws(self):
        home, grant = self.profiles[0]
        with scope(home, grant["token"]):
            cfg = load_config()
            self.assertEqual(cfg["memory"]["provider"], "gbrain")
            self.assertIn("gbrain", cfg["mcp_servers"])
            self.assertFalse(cfg["memory"]["gbrain"]["capture"])
            self.assertEqual((home / "SOUL.md").read_text(), "Synthetic identity that installation must preserve.\n")
            self.assertTrue((home / "skills" / "brain-ops" / "SKILL.md").is_file())
            first = self.manager(home, "native-first")
            try:
                saved = json.loads(first.handle_tool_call("gbrain_remember", {
                    "fact": "The synthetic orchard telescope color is amber.",
                    "entity": "orchard-telescope", "infer_entity": False,
                    "visibility": "world", "provenance": "user-authorized synthetic test",
                }))
                old_id = saved.get("fact_id") or saved.get("id")
                self.assertTrue(old_id, saved)
            finally:
                first.shutdown_all()
            fresh = self.manager(home, "native-fresh")
            try:
                schemas = fresh.get_all_tool_schemas()
                prompt = fresh.build_system_prompt()
                recalled = json.loads(fresh.handle_tool_call("gbrain_recall", {"entity": "orchard-telescope"}))
                self.assertIn("amber", json.dumps(recalled))
                correction = {
                    "fact": "The synthetic orchard telescope color is copper.",
                    "entity": "orchard-telescope", "infer_entity": False,
                    "visibility": "world", "provenance": "user-authorized synthetic correction", "replaces": str(old_id),
                }
                from jsonschema import validate
                remember_schema = next(tool["parameters"] for tool in fresh.get_provider("gbrain").get_tool_schemas() if tool["name"] == "gbrain_remember")
                validate(correction, remember_schema)
                corrected = json.loads(fresh.handle_tool_call("gbrain_remember", correction))
                new_id = corrected.get("fact_id") or corrected.get("id")
                self.assertTrue(new_id, corrected)
                current = json.loads(fresh.handle_tool_call("gbrain_recall", {"entity": "orchard-telescope"}))
                self.assertIn("copper", json.dumps(current))
                self.assertNotIn("color is amber", json.dumps(current))
                withdrawn = json.loads(fresh.handle_tool_call("gbrain_forget", {"id": str(new_id)}))
                self.assertFalse(withdrawn.get("error"), withdrawn)
                after = fresh.handle_tool_call("gbrain_recall", {"entity": "orchard-telescope"})
                self.assertNotIn("color is copper", after)
                fresh.on_pre_compress([])
                fresh.on_session_switch("native-after-compaction")
                self.assertIn(grant["marker"], fresh.prefetch_all(grant["marker"], session_id="native-after-compaction"))
                self.assertEqual(schemas, fresh.get_all_tool_schemas())
                self.assertEqual(prompt, fresh.build_system_prompt())
                client = fresh.get_provider("gbrain")._client
                tools = set(client.tools())
                for name in ("get_page", "put_page", "add_link", "get_links", "recall"):
                    self.assertIn(name, tools)
                page = client.call("put_page", {"slug": "notes/linked-fixture",
                    "content": "---\ntitle: Linked synthetic fixture\nvisibility: world\n---\n\nSynthetic linked page."})
                self.assertFalse(page.get("error"), page)
                client.call("add_link", {"from": "notes/profile-fixture", "to": "notes/linked-fixture", "link_type": "mentions"})
                from tools.mcp_tool_discovery import discover_mcp_tools
                from tools.mcp_tool_lifecycle import shutdown_mcp_servers
                from tools.registry import registry
                names = discover_mcp_tools(["gbrain"])
                native_get_links = "mcp__gbrain__get_links"
                try:
                    self.assertIn(native_get_links, names)
                    entry = registry.get_entry(native_get_links)
                    self.assertIsNotNone(entry)
                    links = entry.handler({"slug": "notes/profile-fixture"})
                    self.assertIn("notes/linked-fixture", links)
                finally:
                    shutdown_mcp_servers()
                from tools.skills_tool import skill_view
                skill = json.loads(skill_view("brain-ops", preprocess=False))
                self.assertTrue(skill.get("success"), skill)
                self.assertIn("Brain", skill.get("content", ""))
            finally:
                fresh.shutdown_all()

    def test_05_durable_pglite_state_survives_engine_and_http_server_restart(self):
        home, grant = self.profiles[0]
        marker = "durable-after-restart-7319"
        with scope(home, grant["token"]):
            manager = self.manager(home, "before-process-restart")
            try:
                result = json.loads(manager.handle_tool_call("gbrain_remember", {
                    "fact": f"Synthetic restart evidence marker is {marker}.",
                    "entity": "restart-evidence", "infer_entity": False,
                    "visibility": "world", "provenance": "durable restart regression fixture",
                }))
                self.assertNotIn("error", result, result)
                self.assertEqual(result.get("state"), "committed", result)
            finally:
                manager.shutdown_all()

            restarted = self.restart_fixture_process()
            self.assertEqual(self.data_dir.is_dir(), True, "fixture must use a filesystem-backed PGLite data directory")
            self.assertTrue(restarted.get("url"))
            config = load_config()
            config["memory"]["gbrain"]["url"] = restarted["url"]
            save_config(config, merge_existing=True)

            fresh = self.manager(home, "after-process-restart")
            try:
                recalled = fresh.handle_tool_call("gbrain_recall", {"entity": "restart-evidence"})
                self.assertIn(marker, recalled, "fresh provider/manager must read committed state from reopened PGLite")
            finally:
                fresh.shutdown_all()

    def test_06_native_manager_forwards_rewind_and_compression_hooks_for_rehydration(self):
        home, grant = self.profiles[0]
        with scope(home, grant["token"]):
            manager = self.manager(home, "hook-rehydration-session")
            try:
                provider = manager.get_provider("gbrain")
                calls = []
                original_call = provider._client.call
                def record_call(name, arguments):
                    calls.append((name, dict(arguments)))
                    return original_call(name, arguments)
                provider._client.call = record_call

                manager.prefetch_all(grant["marker"])
                manager.on_session_switch("hook-rehydration-session", rewound=True)
                after_undo = manager.prefetch_all(grant["marker"], session_id="hook-rehydration-session")
                self.assertIn(grant["marker"], after_undo)
                manager.on_pre_compress([], require_checkpoint=False)
                after_compress = manager.prefetch_all(grant["marker"], session_id="hook-rehydration-session")
                self.assertIn(grant["marker"], after_compress)
                packs = [args for name, args in calls if name == "context_pack"]
                self.assertGreaterEqual(len(packs), 3, "initial, same-ID rewind, and pre-compress each require rehydration")
            finally:
                manager.shutdown_all()

    def test_02_concurrent_profile_contexts_cannot_read_sibling_sources(self):
        def read_profile(index):
            home, grant = self.profiles[index]
            other = self.profiles[1-index][1]
            with scope(home, grant["token"]):
                manager = self.manager(home, "concurrent-session")
                try:
                    own = manager.prefetch_all(grant["marker"])
                    foreign = manager.prefetch_all(other["marker"])
                    self.assertIn(grant["marker"], own)
                    self.assertNotIn(other["marker"], foreign)
                    self.assertEqual(manager.get_provider("gbrain")._client._token(), grant["token"])
                finally:
                    manager.shutdown_all()
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(read_profile, [0, 1]))

    def test_03_background_capture_obeys_server_consent_and_keeps_profile_scope(self):
        home, grant = self.profiles[0]
        with scope(home, grant["token"]):
            provider = load_memory_provider("gbrain")
            provider.save_config({"capture": True}, str(home))
            manager = self.manager(home, "native-capture")
            try:
                before = self.control("pages", sourceId=grant["sourceId"])
                self.control("consent", enabled=False)
                manager.sync_all("Synthetic denied turn.", "Synthetic answer.", turn_author={"is_bot": False})
                self.assertTrue(manager.flush_pending(timeout=10))
                self.assertEqual(before, self.control("pages", sourceId=grant["sourceId"]))
                self.control("consent", enabled=True)
                manager.sync_all("Synthetic allowed capture orchard.", "Synthetic captured answer.", turn_author={"is_bot": False})
                self.assertTrue(manager.flush_pending(timeout=10))
                captured = self.control("pages", sourceId=grant["sourceId"])
                self.assertIn("Synthetic allowed capture orchard", json.dumps(captured))
                self.control("consent", enabled=False)
                manager.sync_all("Synthetic denied after withdrawal.", "Synthetic answer.", turn_author={"is_bot": False})
                self.assertTrue(manager.flush_pending(timeout=10))
                self.assertEqual(captured, self.control("pages", sourceId=grant["sourceId"]))
                self.assertNotIn("Synthetic allowed capture orchard", json.dumps(self.control("pages", sourceId="hermes-profile-b")))
            finally:
                manager.shutdown_all()
                provider.save_config({"capture": False}, str(home))

    def test_04_server_token_revocation_removes_access_from_warm_provider(self):
        home, grant = self.profiles[1]
        with scope(home, grant["token"]):
            manager = self.manager(home, "native-revocation")
            try:
                self.assertIn(grant["marker"], manager.prefetch_all(grant["marker"]))
                self.assertTrue(self.control("revoke", sourceId=grant["sourceId"])["revoked"])
                denied = manager.prefetch_all(grant["marker"])
                self.assertNotIn(grant["marker"], denied)
                self.assertIn("gbrain notice", denied)
                self.assertIn("http_", denied)
            finally:
                manager.shutdown_all()


if __name__ == "__main__":
    unittest.main(verbosity=2)
