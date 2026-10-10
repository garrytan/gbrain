"""Small, frozen tool surface; the native MCP connection exposes the full catalog."""

import copy


def _tool(name, description, fields, required=()):
    properties = {key: {"type": kind} for key, kind in fields.items()}
    return {"name": "gbrain_" + name, "description": description,
            "parameters": {"type": "object", "properties": properties,
                           "required": list(required), "additionalProperties": False}}


TOOLS = [
    _tool("recall", "Recall saved facts and page evidence. A degraded result is not proof of no notes.",
          {"query": "string", "entity": "string", "budget_tokens": "number", "source_id": "string"}),
    _tool("remember", "Save a user-authorized durable fact with provenance. Use replaces with the prior fact ID for a correction. World facts are shared with connected agents.",
          {"fact": "string", "provenance": "string", "entity": "string", "kind": "string", "ttl": "string",
           "source_id": "string", "request_id": "string", "visibility": "string", "replaces": "string", "infer_entity": "boolean"}, ("fact", "provenance")),
    _tool("forget", "Withdraw a fact by fact_id. Source material, history and backups may remain.",
          {"id": "string", "reason": "string", "request_id": "string"}, ("id",)),
    _tool("entity", "Read an entity card; fetch the page before stating status or dates.", {"name": "string"}, ("name",)),
    _tool("context_pack", "Warm standing entities and core memory at session boundaries, zero LLM.",
          {"entities": "string", "budget_tokens": "number"}),
    _tool("delta", "Read changes since the last wake; has_more is continuation, degraded_reason is failure.",
          {"since": "string", "cursor": "string", "budget_tokens": "number", "entities": "string"}),
    _tool("get_page", "Read the full page underlying recalled evidence.",
          {"slug": "string", "source_id": "string", "include_content": "boolean"}, ("slug",)),
]
TOOLS[1]["parameters"]["properties"]["visibility"].update(
    {"enum": ["world", "private"], "default": "private", "description": "Private facts cannot be recalled over remote MCP. Choose world only when sharing with connected agents is intended."})


def tool_schemas():
    return copy.deepcopy(TOOLS)
