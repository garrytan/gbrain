"""
Context Optimization Utilities — compaction, masking, budgeting, and cache optimization.

Public API
----------
Functions:
    estimate_token_count(text) -> int
    estimate_message_tokens(messages) -> int
    categorize_messages(messages) -> dict
    summarize_content(content, category, max_length) -> str
    design_stable_prompt(template, dynamic_values) -> str
    calculate_cache_metrics(requests, cache) -> dict

Classes:
    ObservationStore   — Store and mask verbose tool outputs with retrievable references.
    ContextBudget      — Token budget allocation and optimization trigger detection.

PRODUCTION NOTES:
- Token estimation uses simplified heuristics (~4 chars/token for English).
  Production systems should use model-specific tokenizers:
  - OpenAI: tiktoken library
  - Anthropic: anthropic tokenizer
  - Local models: HuggingFace tokenizers

- Summarization functions use simple heuristics for demonstration.
  Production systems should use:
  - LLM-based summarization for high-quality compression
  - Domain-specific summarization models
  - Schema-based summarization for structured outputs

- Cache metrics are illustrative. Production systems should integrate
  with actual inference infrastructure metrics.
"""

from typing import List, Dict, Optional, Tuple
import hashlib
import re
import time

__all__ = [
    "estimate_token_count",
    "estimate_message_tokens",
    "categorize_messages",
    "summarize_content",
    "summarize_tool_output",
    "summarize_conversation",
    "summarize_document",
    "summarize_general",
    "ObservationStore",
    "ContextBudget",
    "design_stable_prompt",
    "calculate_cache_metrics",
    "generate_cache_recommendations",
]


# ---------------------------------------------------------------------------
# Token estimation
# ---------------------------------------------------------------------------

def estimate_token_count(text: str) -> int:
    """
    Estimate token count for text.

    Use when: a quick token budget check is needed and a model-specific
    tokenizer is unavailable or too slow for the hot path.

    Uses approximation: ~4 characters per token for English.

    WARNING: This is a rough estimate. Actual tokenization varies by:
    - Model (GPT-5.2, Claude 4.5, Gemini 3 have different tokenizers)
    - Content type (code typically has higher token density)
    - Language (non-English may have 2-3x higher token/char ratio)

    Production usage::

        import tiktoken
        enc = tiktoken.encoding_for_model("gpt-4")
        token_count = len(enc.encode(text))
    """
    return len(text) // 4


def estimate_message_tokens(messages: List[Dict[str, str]]) -> int:
    """
    Estimate token count for a message list.

    Use when: checking whether the current conversation is approaching
    the context budget threshold before deciding to compact or mask.
    """
    total = 0
    for msg in messages:
        content = msg.get("content", "")
        total += estimate_token_count(content)
        # Add overhead for role/formatting
        total += 10
    return total


# ---------------------------------------------------------------------------
# Compaction functions
# ---------------------------------------------------------------------------

def categorize_messages(messages: List[Dict]) -> Dict[str, List[Dict]]:
    """
    Categorize messages for selective compaction.

    Use when: preparing to compact context and needing to apply different
    summarization strategies per category (tool outputs first, then old
    conversation turns, then retrieved documents — never the system prompt).

    Returns a dict mapping category name to list of messages.
    """
    categories: Dict[str, List[Dict]] = {
        "system_prompt": [],
        "tool_definition": [],
        "tool_output": [],
        "conversation": [],
        "retrieved_document": [],
        "other": [],
    }

    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")

        if role == "system":
            categories["system_prompt"].append({**msg, "category": "system_prompt"})
        elif "tool_use" in msg.get("type", ""):
            categories["tool_output"].append({**msg, "category": "tool_output"})
        elif role == "user":
            categories["conversation"].append({**msg, "category": "conversation"})
        elif "retrieved" in msg.get("tags", []):
            categories["retrieved_document"].append({**msg, "category": "retrieved_document"})
        else:
            categories["other"].append({**msg, "category": "other"})

    return categories


def summarize_content(content: str, category: str, max_length: int = 500) -> str:
    """
    Summarize content for compaction, dispatching by category.

    Use when: compacting context and needing category-aware summarization
    (tool outputs get metric extraction, conversations get decision
    extraction, documents get lead-paragraph extraction).
    """
    if category == "tool_output":
        return summarize_tool_output(content, max_length)
    elif category == "conversation":
        return summarize_conversation(content, max_length)
    elif category == "retrieved_document":
        return summarize_document(content, max_length)
    else:
        return summarize_general(content, max_length)


def summarize_tool_output(content: str, max_length: int = 500) -> str:
    """
    Summarize tool output by extracting metrics and key findings.

    Use when: a tool output has served its immediate purpose and needs
    to be compacted while preserving actionable data points.
    """
    # Look for metrics (numbers with context)
    metrics = re.findall(r'(\w+):\s*([\d.,]+)', content)

    # Look for key findings (lines with important keywords)
    keywords = ["result", "found", "total", "success", "error", "value"]
    findings = []
    for line in content.split('\n'):
        if any(kw in line.lower() for kw in keywords):
            findings.append(line.strip())

    summary_parts = []
    if metrics:
        summary_parts.append(f"Metrics: {', '.join([f'{k}={v}' for k, v in metrics])}")
    if findings:
        summary_parts.append("Key findings: " + "; ".join(findings[:3]))

    result = " | ".join(summary_parts) if summary_parts else "[Tool output summarized]"
    return result[:max_length]


def summarize_conversation(content: str, max_length: int = 500) -> str:
    """
    Summarize conversational content by extracting decisions and questions.

    Use when: older conversation turns need compaction and the key
    decisions/commitments must survive while filler is removed.
    """
    decisions = re.findall(r'(?i)(?:decided|decision|chose|chosen)[:\s]+([^.]+)', content)
    questions = re.findall(r'(?:\?|question)[:\s]+([^.]+)', content)

    summary_parts = []
    if decisions:
        decision_texts = [d.strip() for d in decisions[:5]]
        summary_parts.append(f"Decisions: {'; '.join(decision_texts)}")
    if questions:
        question_texts = [q.strip() for q in questions[:3]]
        summary_parts.append(f"Open questions: {'; '.join(question_texts)}")

    if not summary_parts:
        # Fallback: extract the first few substantive sentences
        sentences = [s.strip() for s in content.split('.') if len(s.strip()) > 20]
        if sentences:
            summary_parts.append('. '.join(sentences[:3]) + '.')

    result = " | ".join(summary_parts) if summary_parts else "[Conversation summarized]"
    return result[:max_length]


def summarize_document(content: str, max_length: int = 500) -> str:
    """
    Summarize document content using lead-paragraph extraction.

    Use when: a retrieved document has been consumed for reasoning and
    only a brief reference needs to remain in context.
    """
    paragraphs = content.split('\n\n')
    if paragraphs:
        first_para = paragraphs[0].strip()
        sentences = first_para.split('. ')
        if len(sentences) > 2:
            first_para = '. '.join(sentences[:2]) + '.'
        return first_para[:max_length]
    return "[Document summarized]"


def summarize_general(content: str, max_length: int = 500) -> str:
    """
    General-purpose summarization via truncation.

    Use when: content does not fit a specific category and a simple
    truncation with ellipsis is acceptable.
    """
    return content[:max_length] + "..." if len(content) > max_length else content


# ---------------------------------------------------------------------------
# Observation masking
# ---------------------------------------------------------------------------

class ObservationStore:
    """
    Store and mask verbose tool outputs with retrievable references.

    Use when: tool outputs dominate context (>50% of tokens) and older
    observations have already served their reasoning purpose. Stores the
    full content externally and replaces it with a compact reference
    containing a key-point summary.

    Example::

        store = ObservationStore(max_size=500)
        masked, ref_id = store.mask(long_tool_output, max_length=200)
        # masked: "[Obs:a1b2c3d4 elided. Key: ... Full content retrievable.]"
        # Later retrieval:
        original = store.retrieve(ref_id)
    """

    def __init__(self, max_size: int = 1000) -> None:
        self.observations: Dict[str, Dict] = {}
        self.order: List[str] = []
        self.max_size = max_size

    def store(self, content: str, metadata: Optional[Dict] = None) -> str:
        """Store observation and return reference ID."""
        ref_id = self._generate_ref_id(content)

        self.observations[ref_id] = {
            "content": content,
            "metadata": metadata or {},
            "stored_at": time.time(),
            "last_accessed": time.time(),
        }
        self.order.append(ref_id)

        # Evict oldest if over limit
        if len(self.order) > self.max_size:
            oldest = self.order.pop(0)
            del self.observations[oldest]

        return ref_id

    def retrieve(self, ref_id: str) -> Optional[str]:
        """Retrieve observation by reference ID."""
        if ref_id in self.observations:
            self.observations[ref_id]["last_accessed"] = time.time()
            return self.observations[ref_id]["content"]
        return None

    def mask(self, content: str, max_length: int = 200) -> Tuple[str, Optional[str]]:
        """
        Mask observation if longer than max_length.

        Use when: deciding per-observation whether to keep inline or
        replace with a compact reference. Returns (masked_content, ref_id)
        where ref_id is None if the content was short enough to keep.
        """
        if len(content) <= max_length:
            return content, None

        ref_id = self.store(content)
        key_point = self._extract_key_point(content)
        masked = f"[Obs:{ref_id} elided. Key: {key_point}. Full content retrievable.]"
        return masked, ref_id

    def _generate_ref_id(self, content: str) -> str:
        """Generate unique reference ID."""
        hash_input = f"{content[:100]}{time.time()}"
        return hashlib.md5(hash_input.encode()).hexdigest()[:8]

    def _extract_key_point(self, content: str) -> str:
        """Extract key point from observation."""
        lines = [line for line in content.split('\n') if len(line) > 20]
        if lines:
            return lines[0][:50] + "..."
        sentences = content.split('. ')
        if sentences:
            return sentences[0][:50] + "..."
        return content[:50] + "..."


# ---------------------------------------------------------------------------
# Context budget management
# ---------------------------------------------------------------------------

class ContextBudget:
    """
    Token budget allocation and optimization trigger detection.

    Use when: building an agent loop that needs to monitor context usage
    across categories and trigger compaction/masking at the right thresholds
    rather than waiting until the window overflows.

    Example::

        budget = ContextBudget(total_limit=128_000)
        budget.allocate("system_prompt", 1500)
        budget.allocate("tool_definitions", 3000)
        # ... after each agent turn:
        should_act, reasons = budget.should_optimize(current_usage)
        if should_act:
            # apply masking or compaction based on reasons
            pass
    """

    def __init__(self, total_limit: int) -> None:
        self.total_limit = total_limit
        self.allocated: Dict[str, int] = {
            "system_prompt": 0,
            "tool_definitions": 0,
            "retrieved_docs": 0,
            "message_history": 0,
            "tool_outputs": 0,
            "other": 0,
        }
        self.reserved = 5000  # Reserved buffer
        self.reservation_limit = total_limit - self.reserved

    def allocate(self, category: str, amount: int) -> bool:
        """
        Allocate budget to category. Returns True on success, False if
        the allocation would exceed the reservation limit.
        """
        if category not in self.allocated:
            category = "other"

        current = sum(self.allocated.values())
        proposed = current + amount

        if proposed > self.reservation_limit:
            return False

        self.allocated[category] += amount
        return True

    def remaining(self) -> int:
        """Get remaining unallocated budget."""
        current = sum(self.allocated.values())
        return self.reservation_limit - current

    def get_usage(self) -> Dict[str, object]:
        """
        Get current usage breakdown.

        Use when: logging or displaying context budget state for
        monitoring dashboards or debug output.
        """
        total = sum(self.allocated.values())
        return {
            "total_used": total,
            "total_limit": self.total_limit,
            "remaining": self.remaining(),
            "by_category": dict(self.allocated),
            "utilization_ratio": total / self.total_limit,
        }

    def should_optimize(
        self, current_usage: int, metrics: Optional[Dict[str, float]] = None
    ) -> Tuple[bool, List[Tuple[str, object]]]:
        """
        Determine if optimization should trigger.

        Use when: called at the end of each agent loop iteration to
        decide whether to apply compaction, masking, or both before
        the next model call.

        Returns (should_optimize, list_of_reasons).
        """
        reasons: List[Tuple[str, object]] = []

        # Check utilization
        utilization = current_usage / self.total_limit
        if utilization > 0.8:
            reasons.append(("high_utilization", utilization))

        # Check degradation metrics if provided
        if metrics:
            if metrics.get("attention_degradation", 0) > 0.3:
                reasons.append(("attention_degradation", True))
            if metrics.get("quality_score", 1.0) < 0.8:
                reasons.append(("quality_degradation", True))

        return len(reasons) > 0, reasons


# ---------------------------------------------------------------------------
# Cache optimization
# ---------------------------------------------------------------------------

def design_stable_prompt(template: str, dynamic_values: Optional[Dict] = None) -> str:
    """
    Stabilize a prompt template for maximum KV-cache hit rate.

    Use when: constructing system prompts or few-shot prefixes that will
    be reused across many requests. Replaces dynamic content (timestamps,
    session IDs, counters) with stable placeholders so the prefix hash
    remains constant.
    """
    result = template

    # Replace timestamps
    date_pattern = r'\d{4}-\d{2}-\d{2}'
    result = re.sub(date_pattern, '[DATE_STABLE]', result)

    # Replace session IDs
    session_pattern = r'Session \d+'
    result = re.sub(session_pattern, 'Session [STABLE]', result)

    # Replace counters
    counter_pattern = r'\d+/\d+'
    result = re.sub(counter_pattern, '[COUNTER_STABLE]', result)

    return result


def calculate_cache_metrics(
    requests: List[Dict], cache: Dict[str, Dict]
) -> Dict[str, object]:
    """
    Calculate KV-cache hit metrics for a request sequence.

    Use when: evaluating whether prompt restructuring improved cache
    utilization. Feed in the request log and current cache state to
    get hit/miss rates and actionable recommendations.
    """
    hits = 0
    misses = 0

    for req in requests:
        prefix = req.get("prefix_hash", "")
        token_count = req.get("token_count", 0)

        if prefix in cache:
            hits += token_count * cache[prefix].get("hit_ratio", 0)
        else:
            misses += token_count

    total = hits + misses

    return {
        "hit_rate": hits / total if total > 0 else 0,
        "cache_hits": hits,
        "cache_misses": misses,
        "recommendations": generate_cache_recommendations(hits, misses),
    }


def generate_cache_recommendations(hits: int, misses: int) -> List[str]:
    """
    Generate recommendations for cache optimization based on hit/miss ratio.

    Use when: cache metrics indicate sub-optimal hit rates and concrete
    next steps are needed.
    """
    recommendations: List[str] = []

    hit_rate = hits / (hits + misses) if (hits + misses) > 0 else 0

    if hit_rate < 0.5:
        recommendations.append("Consider stabilizing system prompts")
        recommendations.append("Reduce variation in request prefixes")

    if hit_rate < 0.8:
        recommendations.append("Group similar requests together")
        recommendations.append("Use consistent formatting across requests")

    return recommendations


# ---------------------------------------------------------------------------
# Demo / smoke test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("=== Context Optimization Utilities — Demo ===\n")

    # 1. Token estimation
    sample_text = "The quick brown fox jumps over the lazy dog. " * 20
    tokens = estimate_token_count(sample_text)
    print(f"1. Token estimate for {len(sample_text)}-char text: ~{tokens} tokens\n")

    # 2. Observation masking
    store = ObservationStore(max_size=100)
    long_output = (
        "Result: 42 items found\n"
        "Total processing time: 3.2s\n"
        "Details:\n" + "\n".join([f"  Item {i}: value={i*10}" for i in range(20)])
    )
    masked, ref_id = store.mask(long_output, max_length=100)
    print(f"2. Masked observation:\n   {masked}")
    print(f"   Ref ID: {ref_id}")
    retrieved = store.retrieve(ref_id)
    print(f"   Retrievable: {retrieved is not None}\n")

    # 3. Context budget
    budget = ContextBudget(total_limit=128_000)
    budget.allocate("system_prompt", 1500)
    budget.allocate("tool_definitions", 3000)
    budget.allocate("message_history", 95_000)
    usage = budget.get_usage()
    print(f"3. Budget utilization: {usage['utilization_ratio']:.1%}")
    should_opt, reasons = budget.should_optimize(
        current_usage=int(128_000 * 0.85)
    )
    print(f"   Should optimize: {should_opt}, reasons: {reasons}\n")

    # 4. Cache-stable prompt
    raw_prompt = "Session 42 started on 2025-12-20. Progress: 3/10 tasks."
    stable = design_stable_prompt(raw_prompt)
    print(f"4. Original prompt:  {raw_prompt}")
    print(f"   Stabilized:       {stable}\n")

    # 5. Summarization
    tool_out = "count: 150\nstatus: success\nFound 3 errors in module A."
    summary = summarize_content(tool_out, "tool_output", max_length=200)
    print(f"5. Tool output summary: {summary}\n")

    print("=== Demo complete ===")
