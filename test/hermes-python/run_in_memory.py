"""Run parser/lifecycle tests when a sandbox prohibits binding loopback sockets.

This substitutes only urllib's opener. It does not prove native HTTP networking.
The ordinary unittest discovery command always runs the real loopback fixture.
"""

import io
import json
import unittest
from unittest.mock import patch

import test_provider as contract


class Response(io.BytesIO):
    def __init__(self, body, fixture):
        result = fixture.result(body) if body["method"] != "notifications/initialized" else {}
        value = {"jsonrpc": "2.0", "id": body.get("id"), "result": result}
        self.status = 204 if body["method"] == "notifications/initialized" else 200
        self.headers = {"Content-Type": "text/event-stream" if fixture.response_mode.startswith("sse") else "application/json"}
        if fixture.response_mode == "sse_array":
            data = b"data: []\n\n"
        elif fixture.response_mode == "sse":
            data = b"data: " + json.dumps(value).encode() + b"\n\n"
        else:
            data = json.dumps(value).encode()
        super().__init__(data)
        self.fp = self


class MemoryServer(contract.Server):
    def __init__(self):
        self.calls, self.payloads, self.ambient = [], {}, False
        self.names = {"recall", "context_pack", "delta", "remember", "forget", "entity", "get_page", "capture"}
        self.response_mode = "json"
        self.url = "http://127.0.0.1:9999/mcp"
        self.patch = patch("gbrain_hermes_contract.mcp.build_opener", return_value=self)
        self.patch.start()

    def open(self, request, timeout=None):
        body = json.loads(request.data)
        self.calls.append((request.get_header("Authorization"), body))
        return Response(body, self)

    def close(self):
        self.patch.stop()


if __name__ == "__main__":
    with patch.object(contract, "Server", MemoryServer):
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(contract.ContractTests)
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        raise SystemExit(not result.wasSuccessful())
