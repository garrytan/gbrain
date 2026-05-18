import re
import requests
from tools import Tool

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s{3,}")


def _strip_html(text: str) -> str:
    text = _TAG_RE.sub(" ", text)
    return _WS_RE.sub("\n", text).strip()


class WebFetch(Tool):
    name = "web_fetch"
    description = "Fetch text content from a URL. Returns up to 5000 characters of cleaned text."
    schema = {
        "name": "web_fetch",
        "description": description,
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "URL to fetch"},
            },
            "required": ["url"],
        },
    }

    def execute(self, url: str) -> str:
        r = requests.get(url, timeout=15, headers={"User-Agent": "harness/1.0"})
        r.raise_for_status()
        content_type = r.headers.get("content-type", "")
        text = _strip_html(r.text) if "html" in content_type else r.text
        return text[:5000]
