"""Bounded, dependency-free HTTP MCP client. Writes are never retried."""

import json
import threading
import time
from contextlib import contextmanager
from contextvars import ContextVar
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_RESPONSE_BYTES = 2 * 1024 * 1024


class MCPError(RuntimeError):
    def __init__(self, code, message, payload=None):
        super().__init__(message)
        self.code = code
        self.payload = payload or {"code": code, "message": message}


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class HTTPMCP:
    def __init__(self, url, token, timeout=3.0):
        self.url, self.timeout = url, timeout
        self._token = token
        self._opener = build_opener(_NoRedirect())
        self._lock = threading.RLock()
        self._id = 0
        self._session = ""
        self._protocol = "2025-03-26"
        self._tools = None
        self._deadline = ContextVar("gbrain_mcp_deadline", default=None)

    @contextmanager
    def operation_budget(self, seconds):
        prior = self._deadline.get()
        deadline = time.monotonic() + seconds
        scope = self._deadline.set(min(prior, deadline) if prior is not None else deadline)
        try:
            yield
        finally:
            self._deadline.reset(scope)

    @contextmanager
    def _locked(self):
        deadline = self._deadline.get()
        if deadline is None:
            acquired = self._lock.acquire()
        else:
            acquired = self._lock.acquire(timeout=max(0, deadline - time.monotonic()))
        if not acquired:
            raise MCPError("timeout", "GBrain MCP operation exceeded its time budget while waiting for another call")
        try:
            yield
        finally:
            self._lock.release()

    def _request(self, method, params=None, *, notification=False):
        self._id += 1
        request_id = self._id
        body = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            body["params"] = params
        if not notification:
            body["id"] = request_id
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                   "Authorization": "Bearer " + self._token(), "MCP-Protocol-Version": self._protocol}
        if self._session:
            headers["Mcp-Session-Id"] = self._session
        request = Request(self.url, data=json.dumps(body).encode(), headers=headers, method="POST")
        deadline = time.monotonic() + self.timeout
        operation_deadline = self._deadline.get()
        if operation_deadline is not None:
            deadline = min(deadline, operation_deadline)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise MCPError("timeout", "GBrain MCP operation exceeded its time budget")
        try:
            with self._opener.open(request, timeout=remaining) as response:
                if response.status in {202, 204} and notification:
                    return {}
                self._session = response.headers.get("Mcp-Session-Id", self._session)
                event_stream = any(
                    part.strip().lower() == "text/event-stream"
                    for part in response.headers.get("Content-Type", "").split(";")[:1]
                )
                chunks, size, raw = [], 0, bytearray()
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise MCPError("timeout", "GBrain MCP response exceeded its time budget")
                    sock = getattr(getattr(response.fp, "raw", None), "_sock", None)
                    if sock is not None:
                        sock.settimeout(remaining)
                    chunk = response.read1(65536)
                    size += len(chunk)
                    if size > MAX_RESPONSE_BYTES:
                        raise MCPError("response_too_large", "GBrain MCP response exceeds 2 MiB")
                    if event_stream:
                        raw.extend(chunk)
                        found = False
                        while b"\n" in raw:
                            line, rest = raw.split(b"\n", 1)
                            raw = bytearray(rest)
                            line = bytes(line).rstrip(b"\r")
                            if line:
                                chunks.append(line)
                                continue
                            data = b"\n".join(c[5:].lstrip() for c in chunks if c.startswith(b"data:"))
                            chunks = []
                            if not data:
                                continue
                            envelope = json.loads(data)
                            if not isinstance(envelope, dict):
                                raise MCPError("invalid_response", "MCP event must contain a JSON object")
                            if envelope.get("id") == request_id:
                                found = True
                                break
                        if found:
                            break
                        if not chunk:
                            raise MCPError("invalid_response", "MCP stream ended without the requested response")
                    else:
                        raw.extend(chunk)
                        if not chunk:
                            envelope = json.loads(raw)
                            break
        except HTTPError as exc:
            raise MCPError("http_" + str(exc.code), "GBrain MCP HTTP request failed (" + str(exc.code) + "); check this profile's endpoint and token") from None
        except (URLError, TimeoutError, OSError):
            raise MCPError("unavailable", "GBrain MCP server is unreachable or timed out; check the shared server") from None
        except (ValueError, UnicodeError):
            raise MCPError("invalid_response", "GBrain MCP returned invalid JSON") from None
        if not isinstance(envelope, dict) or envelope.get("id") != request_id:
            raise MCPError("invalid_response", "GBrain MCP returned a mismatched response")
        if "error" in envelope:
            raise MCPError("rpc_error", "GBrain MCP refused the request", envelope["error"])
        result = envelope.get("result")
        if not isinstance(result, dict):
            raise MCPError("invalid_response", "GBrain MCP returned no result object")
        return result

    def tools(self):
        with self._locked():
            if self._tools is None:
                result = self._request("initialize", {"protocolVersion": self._protocol,
                    "capabilities": {}, "clientInfo": {"name": "gbrain-hermes", "version": "1.0.0"}})
                self._protocol = result.get("protocolVersion", self._protocol)
                if not isinstance(self._protocol, str) or not self._protocol:
                    raise MCPError("invalid_response", "GBrain initialize returned an invalid protocol version")
                self._request("notifications/initialized", notification=True)
                tools, cursor, seen = {}, None, set()
                for _ in range(16):
                    result = self._request("tools/list", {"cursor": cursor} if cursor else {})
                    entries = result.get("tools")
                    if not isinstance(entries, list):
                        raise MCPError("invalid_response", "GBrain tools/list must return a tools array")
                    for tool in entries:
                        if not isinstance(tool, dict) or not isinstance(tool.get("name"), str):
                            raise MCPError("invalid_response", "GBrain tools/list contains an invalid tool")
                        schema = tool.get("inputSchema")
                        if not isinstance(schema, dict) or not isinstance(schema.get("properties", {}), dict):
                            raise MCPError("invalid_response", "GBrain tool has an invalid input schema")
                        tools[tool["name"]] = tool
                    cursor = result.get("nextCursor")
                    if cursor is not None and not isinstance(cursor, str):
                        raise MCPError("invalid_response", "GBrain tools/list returned an invalid continuation cursor")
                    if not cursor:
                        self._tools = tools
                        break
                    if cursor in seen:
                        raise MCPError("invalid_response", "GBrain tools/list repeats a cursor")
                    seen.add(cursor)
                else:
                    raise MCPError("invalid_response", "GBrain tools/list exceeds 16 pages")
            return self._tools

    def call(self, name, arguments):
        with self._locked():
            if name not in self.tools():
                raise MCPError("unsupported_tool", "The shared server does not advertise " + name + "; check its surface and token scopes")
            try:
                result = self._request("tools/call", {"name": name, "arguments": arguments})
            except MCPError as exc:
                if exc.code != "http_404" or name not in {"recall", "entity", "context_pack", "delta", "get_page"}:
                    raise
                self._session, self._tools = "", None
                if name not in self.tools():
                    raise MCPError("unsupported_tool", "The reconnected server no longer advertises " + name)
                result = self._request("tools/call", {"name": name, "arguments": arguments})
            content = result.get("content", [])
            if not isinstance(content, list) or any(not isinstance(item, dict) for item in content):
                raise MCPError("invalid_response", "GBrain MCP content must be a list of objects")
            texts = [item.get("text", "") for item in content if item.get("type") == "text" and isinstance(item.get("text"), str)]
            payload = result.get("structuredContent")
            notices = texts[:]
            if payload is None:
                try:
                    payload = json.loads(texts[0]) if texts else None
                    notices = texts[1:]
                except (ValueError, TypeError):
                    payload = {"text": "\n".join(texts)}
                    notices = []
            elif texts:
                # MCP often repeats structuredContent in its first text block. Keep
                # every other text block, including host remediation instructions.
                try:
                    if json.loads(texts[0]) == payload:
                        notices = texts[1:]
                except (ValueError, TypeError):
                    pass
            if result.get("isError") or isinstance(payload, dict) and payload.get("error"):
                detail = payload if isinstance(payload, dict) else {"message": "GBrain tool failed"}
                raise MCPError(detail.get("code") or detail.get("error") or "tool_error", "GBrain " + name + " failed", detail)
            if not isinstance(payload, dict):
                raise MCPError("invalid_response", "GBrain " + name + " returned no JSON object")
            if isinstance(result.get("_meta"), dict):
                if isinstance(payload.get("_meta"), dict) and payload["_meta"] != result["_meta"]:
                    payload["_mcp_meta"] = result["_meta"]
                else:
                    payload["_meta"] = result["_meta"]
            if notices:
                payload["_mcp_notices"] = notices
            return payload
