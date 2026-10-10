"""Native CI entry point: real pinned Hermes imports, discovery and loopback HTTP.

No model SDKs or provider dependencies are needed. The actual Hermes utils module
imports hermes_yaml, so install its exact ruamel.yaml==0.18.16 dependency first.
Configuration persistence is the same isolated fixture used by the contract suite.
"""

import importlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HERMES_COMMIT_SHA = "46d7718a52ff33accb15dc0501736fbdb6833cab"


def main():
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError("This pinned provider contract lane requires Python 3.12")
    checkout = Path(os.environ["HERMES_API_CHECKOUT"]).resolve()
    actual = subprocess.check_output(["git", "-C", str(checkout), "rev-parse", "HEAD"], text=True).strip()
    if actual != HERMES_COMMIT_SHA:
        raise RuntimeError("Hermes checkout must be pinned to " + HERMES_COMMIT_SHA)
    sys.path.insert(0, str(checkout))
    # Import the ordinary suite; its config persistence fixture does not replace
    # the real Hermes ABC, home scope, secret scope, utils or plugin loader.
    import test_provider as contracts
    for name in ("agent.memory_provider", "agent.secret_scope", "hermes_constants", "utils"):
        origin = Path(importlib.import_module(name).__file__).resolve()
        if not origin.is_relative_to(checkout):
            raise RuntimeError("Expected a real pinned Hermes module: " + name)

    def cfg_get(config, *keys):
        for key in keys:
            if not isinstance(config, dict):
                return None
            config = config.get(key)
        return config

    contracts.config_module.cfg_get = cfg_get
    from plugins.memory import find_provider_dir
    from plugins import plugin_loader
    with tempfile.TemporaryDirectory() as temporary:
        home = Path(temporary)
        target = home / "plugins" / "gbrain"
        shutil.copytree(contracts.root, target)
        with contracts.profile(home):
            discovered = find_provider_dir("gbrain")
            if discovered != target:
                raise RuntimeError("Native Hermes discovery did not select the profile plugin")
            if not plugin_loader.read_plugin_description(target):
                raise RuntimeError("Native Hermes manifest reading failed")
    print("Pinned native Hermes directory discovery passed; running real loopback contracts.")
    suite = unittest.defaultTestLoader.loadTestsFromModule(contracts)
    server = None
    try:
        repo = Path(__file__).resolve().parents[2]
        bun = shutil.which("bun")
        if not bun:
            raise RuntimeError("Bun is required to start the isolated real GBrain PGLite fixture")
        server = subprocess.Popen([bun, "test/helpers/hermes-provider-server.ts"], cwd=repo,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, bufsize=1)
        ready = None
        for line in server.stdout:
            try:
                candidate = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(candidate, dict) and candidate.get("url", "").endswith("/mcp") and candidate.get("token"):
                ready = candidate
                break
        if ready is None:
            stderr = server.stderr.read() if server.poll() is not None else ""
            raise RuntimeError("Real GBrain PGLite HTTP fixture failed to start: " + stderr[-2000:])
        os.environ["GBRAIN_NATIVE_MCP_URL"] = ready["url"]
        os.environ["GBRAIN_NATIVE_MCP_TOKEN"] = ready["token"]
        os.environ["GBRAIN_NATIVE_READ_TOKEN"] = ready["readOnlyToken"]
        import test_native_lifecycle as lifecycle
        suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(lifecycle))
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        return 0 if result.wasSuccessful() else 1
    finally:
        os.environ.pop("GBRAIN_NATIVE_MCP_URL", None)
        os.environ.pop("GBRAIN_NATIVE_MCP_TOKEN", None)
        os.environ.pop("GBRAIN_NATIVE_READ_TOKEN", None)
        if server is not None:
            if server.stdin:
                server.stdin.close()
            try:
                server.wait(timeout=30)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


if __name__ == "__main__":
    raise SystemExit(main())
