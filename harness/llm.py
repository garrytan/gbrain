import os
import anthropic

_client = None
# Layer 3: compact when estimated chars exceed this.
_COMPACT_AT = int(os.environ.get("COMPACT_AT", "60000"))
# Layer 2: sliding window — keep at most this many messages (must be even, pairs).
_WINDOW = int(os.environ.get("CONTEXT_WINDOW", "20"))
# Layer 1: truncate individual tool_result content longer than this.
_TOOL_RESULT_CAP = int(os.environ.get("TOOL_RESULT_CAP", "1000"))


def _get_client():
    global _client
    if _client is None:
        _client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    return _client


def _chars(messages: list) -> int:
    return sum(len(str(m.get("content", ""))) for m in messages)


# ── Layer 1: selective drop ───────────────────────────────────────────────────

def _drop_long_tool_results(messages: list) -> list:
    """Truncate oversized tool_result content blocks in-place (returns new list)."""
    out = []
    for m in messages:
        content = m.get("content")
        if not isinstance(content, list):
            out.append(m)
            continue
        new_blocks = []
        for block in content:
            if (isinstance(block, dict)
                    and block.get("type") == "tool_result"
                    and isinstance(block.get("content"), str)
                    and len(block["content"]) > _TOOL_RESULT_CAP):
                block = {**block,
                         "content": block["content"][:_TOOL_RESULT_CAP] + " …[truncated]"}
            new_blocks.append(block)
        out.append({**m, "content": new_blocks})
    return out


# ── Layer 2: sliding window ───────────────────────────────────────────────────

def _sliding_window(messages: list) -> list:
    """Keep the first message (task) + the most recent _WINDOW messages."""
    if len(messages) <= _WINDOW + 1:
        return messages
    tail = messages[-_WINDOW:]
    # Avoid duplicating the task message if it falls inside the tail.
    if tail and tail[0] is messages[0]:
        return tail
    return [messages[0]] + tail


# ── Layer 3: summary compaction ───────────────────────────────────────────────

def _compact(messages: list, system: str, model: str) -> list:
    if len(messages) < 6:
        return messages
    # Build a safe prefix: must end on a user turn so the summary call
    # never ends with an orphaned assistant tool_use block (API rejects that).
    prefix = [m for m in messages[:-2] if m["role"] in ("user", "assistant")]
    while prefix and prefix[-1]["role"] != "user":
        prefix.pop()
    if not prefix:
        return messages
    summary = _get_client().messages.create(
        model=model, max_tokens=600, system=system, tools=[],
        messages=prefix + [{"role": "user", "content":
            "Summarize the conversation so far in ≤200 words: "
            "what was accomplished, what tools were called, what is still pending."}],
    ).content[0].text
    return [
        messages[0],                                              # original task
        {"role": "assistant", "content": f"[context compacted]\n\n{summary}"},
        *messages[-2:],                                           # last exchange
    ]


# ── Public API ────────────────────────────────────────────────────────────────

def complete(messages: list, tools: list, system: str):
    model = os.environ.get("MODEL", "claude-sonnet-4-6")
    # Apply layers 1 and 2 on every call (cheap, no API round-trip).
    messages = _drop_long_tool_results(messages)
    messages = _sliding_window(messages)
    # Layer 3 only when we're still over budget after layers 1+2.
    if _chars(messages) > _COMPACT_AT:
        messages = _compact(messages, system, model)
    return _get_client().messages.create(
        model=model, max_tokens=4096, system=system, messages=messages, tools=tools,
    )
