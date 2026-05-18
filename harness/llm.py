import os
import anthropic

_client = None
# Compact when estimated chars exceed this. Override with COMPACT_AT env var.
_COMPACT_AT = int(os.environ.get("COMPACT_AT", "60000"))


def _get_client():
    global _client
    if _client is None:
        _client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    return _client


def _chars(messages: list) -> int:
    return sum(len(str(m.get("content", ""))) for m in messages)


def _compact(messages: list, system: str, model: str) -> list:
    if len(messages) < 6:
        return messages
    # Build a safe prefix: truncate at last user turn so the summary call
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


def complete(messages: list, tools: list, system: str):
    model = os.environ.get("MODEL", "claude-sonnet-4-6")
    if _chars(messages) > _COMPACT_AT:
        messages = _compact(messages, system, model)
    return _get_client().messages.create(
        model=model, max_tokens=4096, system=system, messages=messages, tools=tools,
    )
