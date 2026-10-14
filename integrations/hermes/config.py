"""Profile-local settings. Secrets are resolved only through Hermes' scope."""

from dataclasses import dataclass
from urllib.parse import urlsplit

from agent.secret_scope import get_secret
from hermes_cli.config import load_config, save_config


@dataclass(frozen=True)
class Settings:
    url: str
    source_id: str = ""
    entities: str = ""
    budget_tokens: int = 1200
    timeout_seconds: float = 3.0
    capture: bool = False
    heartbeat_seconds: float = 300.0


def settings():
    block = load_config().get("memory", {})
    values = block.get("gbrain", {}) if isinstance(block, dict) else {}
    if not isinstance(values, dict):
        raise ValueError("memory.gbrain must be a mapping")
    url = str(values.get("url", "")).strip()
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Set memory.gbrain.url to the shared server's HTTP MCP URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("MCP URL must not contain credentials, a query, or a fragment")
    if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("Remote MCP requires HTTPS; HTTP is allowed only on loopback")
    entities = values.get("entities", [])
    if isinstance(entities, list):
        entities = ",".join(str(e) for e in entities[:8])
    if not isinstance(entities, str):
        raise ValueError("memory.gbrain.entities must be a list or comma-separated string")
    budget = values.get("budget_tokens", 1200)
    timeout = values.get("timeout_seconds", 3.0)
    heartbeat = values.get("heartbeat_seconds", 300.0)
    if isinstance(budget, bool) or not isinstance(budget, int) or not 64 <= budget <= 16000:
        raise ValueError("memory.gbrain.budget_tokens must be an integer from 64 to 16000")
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 0.1 <= timeout <= 15:
        raise ValueError("memory.gbrain.timeout_seconds must be from 0.1 to 15")
    if isinstance(heartbeat, bool) or not isinstance(heartbeat, (int, float)) or not 0 <= heartbeat <= 86400:
        raise ValueError("memory.gbrain.heartbeat_seconds must be from 0 to 86400")
    capture = values.get("capture", False)
    if not isinstance(capture, bool):
        raise ValueError("memory.gbrain.capture must be a boolean")
    return Settings(url, str(values.get("source_id", "")).strip(), entities,
                    budget, float(timeout), capture, float(heartbeat))


def token():
    value = get_secret("GBRAIN_MCP_TOKEN", "") or ""
    if not value.strip():
        raise ValueError("Set GBRAIN_MCP_TOKEN in this Hermes profile's .env")
    return value.strip()


def save_settings(values, hermes_home):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    scope = set_hermes_home_override(hermes_home)
    try:
        config = load_config()
        memory = config.setdefault("memory", {})
        block = memory.setdefault("gbrain", {})
        block.update({k: v for k, v in values.items() if k in Settings.__dataclass_fields__})
        save_config(config, merge_existing=True)
    finally:
        reset_hermes_home_override(scope)
