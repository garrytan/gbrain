from __future__ import annotations
import os, requests
from tools import Tool

GBRAIN_BASE = "https://gbrain-production-18fa.up.railway.app"


_otp_cache: tuple[int, str] | None = None


def _otp() -> str:
    global _otp_cache
    if os.environ.get("GBRAIN_OTP"):
        return os.environ["GBRAIN_OTP"]
    import hmac, hashlib, time
    day = int(time.time() * 1000 // 86_400_000)
    if _otp_cache and _otp_cache[0] == day:
        return _otp_cache[1]
    secret = os.environ["GBRAIN_TOTP_SECRET"]
    code = hmac.new(secret.encode(), str(day).encode(), hashlib.sha256).digest().hex()[:10]
    _otp_cache = (day, code)
    return code

def _headers() -> dict:
    return {"Authorization": f"OTP {_otp()}"}


def _schema(name: str, desc: str, props: dict, required: list) -> dict:
    return {"name": name, "description": desc,
            "input_schema": {"type": "object", "properties": props, "required": required}}


class SearchMemory(Tool):
    name = "search_memory"
    description = "Search gbrain. mode: hybrid (default), keyword, or semantic."
    schema = _schema(name, description, {
        "q":    {"type": "string", "description": "Search query"},
        "mode": {"type": "string", "enum": ["hybrid", "keyword", "semantic"],
                 "description": "hybrid=lex+vec (default), keyword=lex only, semantic=vec only"},
    }, ["q"])

    def execute(self, q: str, mode: str = "hybrid") -> str:
        base = {"limit": 5, "include_pending": "1"}
        extra = {"keyword": {"lex": q}, "semantic": {"vec": q}}.get(mode, {"lex": q, "vec": q})
        r = requests.get(f"{GBRAIN_BASE}/search", params={**base, **extra},
                         headers=_headers(), timeout=15)
        r.raise_for_status()
        results = r.json().get("results", [])
        if not results:
            return "No results found."
        lines = []
        for item in results[:5]:
            snippet = (item.get("chunk_text") or item.get("body") or "")[:300]
            lines.append(f"slug: {item['slug']}\ntitle: {item.get('title','')}\n{snippet}\n---")
        return "\n".join(lines)


class ReadMemory(Tool):
    name = "read_memory"
    description = "Read a gbrain page by slug. Returns full markdown content."
    schema = _schema(name, description,
                     {"slug": {"type": "string", "description": "Page slug (e.g. mem/foo)"}}, ["slug"])

    def execute(self, slug: str) -> str:
        r = requests.get(f"{GBRAIN_BASE}/page", params={"slug": slug},
                         headers=_headers(), timeout=15)
        if r.status_code == 404:
            return f"Page not found: {slug}"
        r.raise_for_status()
        data = r.json()
        return data.get("body") or data.get("content") or str(data)


class WriteMemory(Tool):
    name = "write_memory"
    description = "Write a page to gbrain. Slug must start with mem/ or wiki/. Search first to avoid duplicates."
    schema = _schema(name, description, {
        "slug":  {"type": "string", "description": "Page slug, must start with mem/ or wiki/"},
        "title": {"type": "string", "description": "Page title"},
        "body":  {"type": "string", "description": "Full markdown content"},
    }, ["slug", "title", "body"])

    def execute(self, slug: str, title: str, body: str) -> str:
        if not (slug.startswith("mem/") or slug.startswith("wiki/")):
            raise ValueError(f"slug must start with mem/ or wiki/, got: {slug}")
        content = f"---\ntitle: {title}\nsource: agent\n---\n\n{body}"
        r = requests.put(f"{GBRAIN_BASE}/page",
                         json={"slug": slug, "content": content, "source": "agent", "tags": ["fact"]},
                         params={"async": "1"}, headers=_headers(), timeout=20)
        r.raise_for_status()
        data = r.json()
        return f"Written: slug={slug}, hash={data.get('content_hash') or data.get('hash') or '?'}"
