"""
Context Management Utilities for Agent Systems.

Public API
----------
Functions:
    estimate_token_count     — Rough token estimate from text (demo only).
    estimate_message_tokens  — Token estimate for a message list.
    count_tokens_by_type     — Break down token usage by context component.
    truncate_context         — Trim a context string to a token budget.
    truncate_messages        — Trim message history while preserving structure.
    validate_context_structure — Detect empty, oversized, or duplicate sections.
    build_agent_context      — Assemble an optimized context dict from parts.

Classes:
    ContextBuilder               — Priority-aware context assembly with budgets.
    ProgressiveDisclosureManager — Lazy file loading with caching.

Usage
-----
Import individual utilities or use `build_agent_context` as the high-level
entry point:

    from context_manager import build_agent_context
    result = build_agent_context(
        task="Refactor auth module",
        system_prompt="You are a senior Python engineer.",
        documents=["# Auth module docs ..."],
    )
    print(result["usage_report"])

Run this module directly (`python context_manager.py`) for an interactive demo
that builds a sample context and prints the usage report.

Note: Token estimation in this module uses a character-ratio heuristic. For
production systems, replace `estimate_token_count` with a real tokenizer
(tiktoken for OpenAI, Anthropic's token-counting API, etc.).
"""

from __future__ import annotations

import hashlib
from typing import Any, Dict, List, Optional

__all__ = [
    "estimate_token_count",
    "estimate_message_tokens",
    "count_tokens_by_type",
    "truncate_context",
    "truncate_messages",
    "validate_context_structure",
    "build_agent_context",
    "ContextBuilder",
    "ProgressiveDisclosureManager",
]


# ---------------------------------------------------------------------------
# Token estimation
# ---------------------------------------------------------------------------

def estimate_token_count(text: str) -> int:
    """Return a rough token estimate for *text*.

    Uses the ~4 characters-per-token heuristic for English prose.

    Use when: quick budget checks during development or logging. Do NOT rely
    on this for hard budget enforcement — code, URLs, and non-English text
    tokenize at very different ratios (see module docstring).

    WARNING: Production systems must use a real tokenizer:
    - OpenAI models  → ``tiktoken``
    - Anthropic      → Anthropic token-counting API
    - Others         → provider-specific tokenizer
    """
    return len(text) // 4


def estimate_message_tokens(messages: List[Dict[str, Any]]) -> int:
    """Estimate total tokens across a list of chat messages.

    Use when: deciding whether to trigger compaction on message history.
    Each message adds ~10 tokens of role/formatting overhead on top of
    its content tokens.
    """
    total = 0
    for msg in messages:
        content = msg.get("content", "")
        total += estimate_token_count(content)
        total += 10  # Overhead for role/formatting
    return total


def count_tokens_by_type(context: Dict[str, Any]) -> Dict[str, int]:
    """Break down token usage by context component type.

    Use when: profiling where tokens are spent so the highest-cost
    component can be targeted for compression first.

    Recognized keys in *context*: ``system``, ``tools`` (list),
    ``documents`` (list), ``messages`` (list).
    """
    breakdown: Dict[str, int] = {
        "system_prompt": 0,
        "tool_definitions": 0,
        "retrieved_documents": 0,
        "message_history": 0,
        "tool_outputs": 0,
        "other": 0,
    }

    if "system" in context:
        breakdown["system_prompt"] = estimate_token_count(context["system"])

    if "tools" in context:
        for tool in context["tools"]:
            breakdown["tool_definitions"] += estimate_token_count(str(tool))

    if "documents" in context:
        for doc in context["documents"]:
            breakdown["retrieved_documents"] += estimate_token_count(doc)

    if "messages" in context:
        breakdown["message_history"] = estimate_message_tokens(context["messages"])

    return breakdown


# ---------------------------------------------------------------------------
# Context Builder
# ---------------------------------------------------------------------------

class ContextBuilder:
    """Build context with priority-aware budget management.

    Use when: assembling context from multiple sources (system prompt,
    retrieved documents, task description) and enforcing a hard token
    ceiling. Higher-priority sections are kept first when the budget is
    tight.

    Example::

        builder = ContextBuilder(context_limit=80_000)
        builder.add_section("system", prompt, priority=10)
        builder.add_section("task", task_text, priority=9)
        built = builder.build()
    """

    def __init__(self, context_limit: int = 100_000) -> None:
        self.context_limit: int = context_limit
        self.sections: Dict[str, Dict[str, Any]] = {}
        self.order: List[str] = []

    def add_section(
        self,
        name: str,
        content: str,
        priority: int = 0,
        category: str = "other",
    ) -> None:
        """Add or replace a named section.

        Higher *priority* values are kept first when the budget is tight.
        """
        if name not in self.sections:
            self.order.append(name)

        self.sections[name] = {
            "content": content,
            "priority": priority,
            "category": category,
            "tokens": estimate_token_count(content),
        }

    def build(self, max_tokens: Optional[int] = None) -> str:
        """Assemble context string within the token budget.

        Sections are included in descending priority order until the
        budget is exhausted. Returns the concatenated text of all
        included sections.
        """
        limit = max_tokens or self.context_limit

        sorted_sections = sorted(
            self.order,
            key=lambda n: self.sections[n]["priority"],
            reverse=True,
        )

        context_parts: List[str] = []
        current_tokens = 0

        for name in sorted_sections:
            section = self.sections[name]
            section_tokens = section["tokens"]

            if current_tokens + section_tokens <= limit:
                context_parts.append(section["content"])
                current_tokens += section_tokens

        return "\n\n".join(context_parts)

    def get_usage_report(self) -> Dict[str, Any]:
        """Return a summary of current context utilization.

        Use when: logging context composition during development or
        deciding whether to trigger compaction.
        """
        total = sum(s["tokens"] for s in self.sections.values())
        return {
            "total_tokens": total,
            "limit": self.context_limit,
            "utilization": total / self.context_limit if self.context_limit else 0,
            "by_section": {
                name: s["tokens"] for name, s in self.sections.items()
            },
            "status": self._get_status(total),
        }

    def _get_status(self, total: int) -> str:
        """Return 'critical', 'warning', or 'healthy' based on utilization."""
        ratio = total / self.context_limit if self.context_limit else 0
        if ratio > 0.9:
            return "critical"
        elif ratio > 0.7:
            return "warning"
        else:
            return "healthy"


# ---------------------------------------------------------------------------
# Context Truncation
# ---------------------------------------------------------------------------

def truncate_context(
    context: str,
    max_tokens: int,
    preserve_start: bool = True,
) -> str:
    """Truncate *context* to approximately *max_tokens*.

    Use when: a single large text block must fit a hard budget and
    semantic chunking is not available.

    Set *preserve_start* to ``True`` (default) to keep the beginning
    (system prompts, top-of-file content) or ``False`` to keep the end
    (most recent information).
    """
    tokens = context.split()
    if len(tokens) <= max_tokens:
        return context

    if preserve_start:
        kept = tokens[:max_tokens]
    else:
        kept = tokens[-max_tokens:]

    return " ".join(kept)


def truncate_messages(
    messages: List[Dict[str, Any]],
    max_tokens: int,
) -> List[Dict[str, Any]]:
    """Truncate message history while preserving structural integrity.

    Use when: message history exceeds budget and compaction has not yet
    been implemented. Keeps: (1) the system prompt, (2) any existing
    summary message, and (3) the most recent messages that fit.

    Strategy:
    1. Always keep the system prompt.
    2. Keep any existing summary message.
    3. Fill remaining budget with the most recent messages.
    """
    system_prompt: Optional[Dict[str, Any]] = None
    recent_messages: List[Dict[str, Any]] = []
    summary: Optional[Dict[str, Any]] = None

    for msg in messages:
        if msg.get("role") == "system":
            system_prompt = msg
        elif msg.get("is_summary"):
            summary = msg
        else:
            recent_messages.append(msg)

    tokens_for_system = (
        estimate_token_count(system_prompt["content"]) if system_prompt else 0
    )
    tokens_for_summary = (
        estimate_token_count(summary["content"]) if summary else 0
    )
    available = max_tokens - tokens_for_system - tokens_for_summary

    tokens_for_recent = estimate_message_tokens(recent_messages)
    if tokens_for_recent > available:
        truncated_recent: List[Dict[str, Any]] = []
        current_tokens = 0
        for msg in reversed(recent_messages):
            msg_tokens = estimate_token_count(msg.get("content", ""))
            if current_tokens + msg_tokens <= available:
                truncated_recent.insert(0, msg)
                current_tokens += msg_tokens
        recent_messages = truncated_recent

    result: List[Dict[str, Any]] = []
    if system_prompt:
        result.append(system_prompt)
    if summary:
        result.append(summary)
    result.extend(recent_messages)
    return result


# ---------------------------------------------------------------------------
# Context Validation
# ---------------------------------------------------------------------------

def validate_context_structure(context: Dict[str, Any]) -> Dict[str, Any]:
    """Validate a context dict for common structural issues.

    Use when: testing context assembly before sending to the model.
    Checks for empty sections, excessive length, missing recommended
    sections, and potential duplicate content.

    Returns a dict with ``valid`` (bool), ``issues`` (list), and
    ``recommendations`` (list).
    """
    issues: List[str] = []
    recommendations: List[str] = []

    # Check for empty sections (skip list-type values like documents
    # which are legitimately empty when no documents are retrieved)
    for section, content in context.items():
        if content is None or (isinstance(content, str) and not content):
            issues.append(f"Empty {section} section")
            recommendations.append(f"Remove or populate {section}")

    # Check for excessive length
    total_tokens = sum(estimate_token_count(str(c)) for c in context.values())
    if total_tokens > 80_000:
        issues.append(
            f"Context length ({total_tokens} tokens) exceeds recommended limit"
        )
        recommendations.append("Consider context compaction or partitioning")

    # Check for missing sections
    recommended_sections = ["system", "task"]
    for section in recommended_sections:
        if section not in context:
            issues.append(f"Missing recommended section: {section}")
            recommendations.append(
                f"Add {section} section with relevant information"
            )

    # Check for duplicate content (first 1000 chars, hashed for consistency)
    seen_content: set[str] = set()
    for section, content in context.items():
        content_str = str(content)[:1000]
        content_hash = hashlib.md5(content_str.encode()).hexdigest()
        if content_hash in seen_content:
            issues.append(f"Potential duplicate content in {section}")
        seen_content.add(content_hash)

    return {
        "valid": len(issues) == 0,
        "issues": issues,
        "recommendations": recommendations,
    }


# ---------------------------------------------------------------------------
# Progressive Disclosure
# ---------------------------------------------------------------------------

class ProgressiveDisclosureManager:
    """Lazy loader for progressive disclosure of file-based context.

    Use when: an agent has access to many reference files but should
    only pay the token cost for files that the current task actually
    needs. Summaries are loaded first; detail files are loaded on demand
    and cached for the session.

    Example::

        pdm = ProgressiveDisclosureManager(base_dir="docs")
        overview = pdm.load_summary("docs/api_summary.md")
        # ... later, when detail is needed ...
        detail = pdm.load_detail("docs/api/endpoints.md")
    """

    def __init__(self, base_dir: str = ".") -> None:
        self.base_dir: str = base_dir
        self.loaded_files: Dict[str, str] = {}

    def load_summary(self, summary_path: str) -> str:
        """Load a summary file, returning cached content if available."""
        if summary_path in self.loaded_files:
            return self.loaded_files[summary_path]
        try:
            with open(summary_path, "r") as f:
                content = f.read()
            self.loaded_files[summary_path] = content
            return content
        except FileNotFoundError:
            return ""

    def load_detail(self, detail_path: str, force: bool = False) -> str:
        """Load a detail file on demand.

        Set *force* to ``True`` to bypass the cache and re-read the file
        (useful when the underlying file may have changed).
        """
        if not force and detail_path in self.loaded_files:
            return self.loaded_files[detail_path]
        try:
            with open(detail_path, "r") as f:
                content = f.read()
            self.loaded_files[detail_path] = content
            return content
        except FileNotFoundError:
            return ""

    def get_contextual_info(self, reference: Dict[str, Any]) -> str:
        """Return summary or detail based on the reference's flags.

        Use when: a reference dict carries both ``summary_path`` and
        ``detail_path`` and the caller sets ``need_detail=True`` only
        when full content is required.
        """
        summary_path = reference.get("summary_path")
        detail_path = reference.get("detail_path")
        need_detail = reference.get("need_detail", False)

        if need_detail and detail_path:
            return self.load_detail(detail_path)
        elif summary_path:
            return self.load_summary(summary_path)
        else:
            return ""


# ---------------------------------------------------------------------------
# High-level entry point
# ---------------------------------------------------------------------------

def build_agent_context(
    task: str,
    system_prompt: str,
    documents: Optional[List[str]] = None,
    context_limit: int = 80_000,
) -> Dict[str, Any]:
    """Build an optimized, validated context dict for an agent task.

    Use when: assembling context for a single inference call. Combines
    system prompt, task description, and optional retrieved documents
    into a priority-ordered context string, then validates the result.

    Returns a dict with keys ``context`` (str), ``usage_report`` (dict),
    and ``validation`` (dict).
    """
    builder = ContextBuilder(context_limit=context_limit)

    # System prompt — highest priority, persists across turns
    builder.add_section("system", system_prompt, priority=10, category="system")

    # Task description — second priority
    builder.add_section("task", task, priority=9, category="task")

    # Retrieved documents — loaded just-in-time
    if documents:
        for i, doc in enumerate(documents):
            builder.add_section(
                f"document_{i}",
                doc,
                priority=5,
                category="retrieved",
            )

    context_dict: Dict[str, Any] = {
        "system": system_prompt,
        "task": task,
        "documents": documents or [],
    }

    validation = validate_context_structure(context_dict)

    return {
        "context": builder.build(),
        "usage_report": builder.get_usage_report(),
        "validation": validation,
    }


# ---------------------------------------------------------------------------
# Demo
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("=== Context Manager Demo ===\n")

    sample_prompt = (
        "You are a senior Python engineer. Follow PEP 8, use type hints, "
        "and write docstrings for all public functions."
    )
    sample_task = "Refactor the authentication module to use OAuth 2.0."
    sample_docs = [
        "# OAuth 2.0 Reference\nThe OAuth 2.0 authorization framework...",
        "# Current Auth Module\ndef login(user, password): ...",
    ]

    result = build_agent_context(
        task=sample_task,
        system_prompt=sample_prompt,
        documents=sample_docs,
    )

    report = result["usage_report"]
    print(f"Total tokens : {report['total_tokens']}")
    print(f"Utilization  : {report['utilization']:.1%}")
    print(f"Status       : {report['status']}")
    print(f"\nBreakdown by section:")
    for section, tokens in report["by_section"].items():
        print(f"  {section:20s} : {tokens:,} tokens")

    validation = result["validation"]
    if validation["valid"]:
        print("\nValidation   : PASSED")
    else:
        print(f"\nValidation   : FAILED")
        for issue in validation["issues"]:
            print(f"  - {issue}")
