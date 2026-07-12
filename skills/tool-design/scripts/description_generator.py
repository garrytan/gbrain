"""
Tool Description Engineering -- Generation and Evaluation Utilities.

Use when: building, auditing, or iterating on tool descriptions for agent
systems.  Provides templates for structured descriptions, a scoring evaluator
that flags vague or incomplete descriptions, error-message generators that
produce agent-recoverable responses, and a builder that assembles complete
tool schemas.

Typical workflow:
    1. Define a tool spec with ``ToolSchemaBuilder``.
    2. Generate a rendered description with ``generate_tool_description``.
    3. Score the description with ``ToolDescriptionEvaluator.evaluate``.
    4. Generate error templates with ``ErrorMessageGenerator.generate``.

Example::

    builder = ToolSchemaBuilder("get_customer")
    builder.set_description("Retrieve customer record", "Full details...")
    builder.add_parameter("customer_id", "string", "CUST-######", required=True)
    schema = builder.build()

    desc = generate_tool_description(schema)
    scores = ToolDescriptionEvaluator().evaluate(desc, schema)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Protocol, Sequence
import json
import re


__all__ = [
    "generate_tool_description",
    "generate_usage_context",
    "ToolDescriptionEvaluator",
    "ErrorMessageGenerator",
    "ToolSchemaBuilder",
]


# ---------------------------------------------------------------------------
# Protocols -- lightweight structural typing for tool specs
# ---------------------------------------------------------------------------

class ToolSpec(Protocol):
    """Structural interface expected by generation helpers.

    Use when: passing tool metadata objects that were not built with
    ``ToolSchemaBuilder`` (e.g., third-party specs).
    """

    name: str
    description: str
    triggers: Sequence[str]
    examples: Sequence[Any]
    parameters: Sequence[Dict[str, Any]]
    returns: Dict[str, Any]
    errors: Sequence[Dict[str, Any]]


@dataclass
class _BuiltToolSpec:
    """Concrete implementation of ToolSpec returned by ToolSchemaBuilder.build()."""

    name: str
    description: str
    triggers: List[str]
    examples: List[Dict[str, str]]
    parameters: List[Dict[str, Any]]
    returns: Dict[str, Any]
    errors: List[Dict[str, Any]]


# ---------------------------------------------------------------------------
# Description Templates
# ---------------------------------------------------------------------------

TOOL_DESCRIPTION_TEMPLATE: str = """
## {tool_name}

{detailed_description}

### When to Use
{usage_context}

### Parameters
{parameters_description}

### Returns
{returns_description}

### Errors
{errors_description}
"""

PARAM_TEMPLATE: str = """
- **{param_name}** ({param_type}{required_label})

  {param_description}
  {default_label}
"""


# ---------------------------------------------------------------------------
# Generation helpers
# ---------------------------------------------------------------------------

def generate_tool_description(tool_spec: ToolSpec) -> str:
    """Render a complete markdown tool description from *tool_spec*.

    Use when: producing human-readable or agent-injectable documentation
    from a structured spec object.
    """
    description: str = TOOL_DESCRIPTION_TEMPLATE.format(
        tool_name=tool_spec.name,
        detailed_description=tool_spec.description,
        usage_context=generate_usage_context(tool_spec),
        parameters_description=_generate_parameters(tool_spec.parameters),
        returns_description=_generate_returns(tool_spec.returns),
        errors_description=_generate_errors(tool_spec.errors),
    )
    return description


def generate_usage_context(tool_spec: ToolSpec) -> str:
    """Build the 'When to Use' section from triggers and examples.

    Use when: the caller needs only the usage-context fragment rather
    than the full rendered description.
    """
    contexts: list[str] = []

    for trigger in tool_spec.triggers:
        contexts.append(f"- When {trigger}")

    if tool_spec.examples:
        contexts.append("\n**Examples**:\n")
        for example in tool_spec.examples:
            if isinstance(example, dict):
                contexts.append(f"- Input: {example.get('input', '')}")
                contexts.append(f"  Output: {example.get('tool_call', '')}")
            else:
                contexts.append(f"- {example}")

    return "\n".join(contexts)


def _generate_parameters(parameters: Sequence[Dict[str, Any]]) -> str:
    """Render parameter list to markdown."""
    parts: list[str] = []
    for p in parameters:
        required_label = " | required" if p.get("required") else " | optional"
        default = p.get("default")
        default_label = f"Default: {default}" if default is not None else ""
        parts.append(
            f"- **{p['name']}** ({p['type']}{required_label})\n"
            f"  {p['description']}\n"
            f"  {default_label}".rstrip()
        )
    return "\n".join(parts)


def _generate_returns(returns: Optional[Dict[str, Any]]) -> str:
    """Render the returns section to markdown."""
    if not returns:
        return "No return value documented."
    desc = returns.get("description", "")
    rtype = returns.get("type", "object")
    return f"{rtype} -- {desc}"


def _generate_errors(errors: Sequence[Dict[str, Any]]) -> str:
    """Render error definitions to markdown."""
    if not errors:
        return "No error conditions documented."
    parts: list[str] = []
    for err in errors:
        parts.append(f"- **{err['code']}**: {err['description']} -- {err.get('resolution', '')}")
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Evaluator
# ---------------------------------------------------------------------------

class ToolDescriptionEvaluator:
    """Score a rendered description against quality criteria.

    Use when: auditing existing tool descriptions for clarity,
    completeness, accuracy, actionability, and consistency.
    """

    CRITERIA: List[str] = [
        "clarity",
        "completeness",
        "accuracy",
        "actionability",
        "consistency",
    ]

    def evaluate(self, description: str, tool_spec: ToolSpec) -> Dict[str, float]:
        """Return per-criterion scores (0.0 -- 1.0) for *description*.

        Use when: running automated quality checks on tool descriptions
        before deploying them into an agent system.
        """
        results: Dict[str, float] = {
            "clarity": self._check_clarity(description),
            "completeness": self._check_completeness(description, tool_spec),
            "accuracy": self._check_accuracy(description, tool_spec),
            "actionability": self._check_actionability(description),
            "consistency": self._check_consistency(description, tool_spec),
        }
        return results

    # -- private scoring helpers ------------------------------------------

    def _check_clarity(self, description: str) -> float:
        """Score description clarity (0-1).

        Use when: detecting vague or ambiguous language that would
        confuse an agent during tool selection.
        """
        vague_terms: list[str] = ["help", "assist", "thing", "stuff", "handle"]
        vague_count: int = sum(1 for term in vague_terms if term in description.lower())

        ambiguous: list[str] = ["it", "this", "that"]
        ambiguous_count: int = sum(1 for term in ambiguous if f" {term} " in description)

        clarity: float = 1.0 - (vague_count * 0.1) - (ambiguous_count * 0.05)
        return max(0.0, clarity)

    def _check_completeness(self, description: str, tool_spec: ToolSpec) -> float:
        """Score presence of required sections (0-1).

        Use when: verifying a description has all mandatory sections
        before publishing.
        """
        required_patterns: list[tuple[str, str]] = [
            ("description", r"## " + re.escape(str(getattr(tool_spec, "name", "")))),
            ("parameters", r"### Parameters"),
            ("returns", r"### Returns"),
            ("errors", r"### Errors"),
        ]
        present: int = sum(
            1 for _, pattern in required_patterns if re.search(pattern, description)
        )
        return present / len(required_patterns)

    def _check_accuracy(self, description: str, tool_spec: ToolSpec) -> float:
        """Score alignment between description text and spec metadata.

        Use when: detecting description rot where the text no longer
        matches the current tool spec.
        """
        score = 1.0
        # Check that tool name appears in description
        if hasattr(tool_spec, "name") and tool_spec.name not in description:
            score -= 0.3
        # Check parameter names appear
        if hasattr(tool_spec, "parameters"):
            for param in tool_spec.parameters:
                pname = param.get("name", "") if isinstance(param, dict) else ""
                if pname and pname not in description:
                    score -= 0.15
        return max(0.0, score)

    def _check_actionability(self, description: str) -> float:
        """Score whether the description contains actionable cues.

        Use when: confirming agents can determine correct usage from
        the description alone.
        """
        signals: list[str] = ["Use when", "Returns", "Errors", "Args", "Parameters"]
        found: int = sum(1 for s in signals if s in description)
        return min(1.0, found / max(1, len(signals)))

    def _check_consistency(self, description: str, tool_spec: ToolSpec) -> float:
        """Score naming and formatting consistency.

        Use when: checking that parameter and section naming follows
        conventions across the tool collection.
        """
        # Penalise mixed naming styles (camelCase vs snake_case)
        camel = len(re.findall(r"[a-z][A-Z]", description))
        snake = len(re.findall(r"[a-z]_[a-z]", description))
        if camel > 0 and snake > 0:
            return 0.5
        return 1.0


# ---------------------------------------------------------------------------
# Error Message Generator
# ---------------------------------------------------------------------------

class ErrorMessageGenerator:
    """Produce structured, agent-recoverable error messages.

    Use when: building error responses that tell agents what went wrong,
    why, and how to correct the call.
    """

    TEMPLATES: Dict[str, str] = {
        "NOT_FOUND": json.dumps({
            "error": "{error_code}",
            "message": "{specific_message}",
            "resolution": "{how_to_resolve}",
            "example": "{correct_format}",
        }, indent=2),

        "INVALID_INPUT": json.dumps({
            "error": "{error_code}",
            "message": "Invalid {field}: {received_value}",
            "expected_format": "{expected_format}",
            "resolution": "Provide value matching {expected_format}",
        }, indent=2),

        "RATE_LIMITED": json.dumps({
            "error": "{error_code}",
            "message": "Rate limit exceeded",
            "retry_after": "{seconds}",
            "resolution": "Wait {seconds} seconds before retrying",
        }, indent=2),
    }

    def generate(self, error_type: str, context: Dict[str, str]) -> str:
        """Render an error message for *error_type* using *context* values.

        Use when: a tool needs to return a structured error that an agent
        can parse and act on.
        """
        template: str = self.TEMPLATES.get(error_type, self.TEMPLATES["INVALID_INPUT"])
        return template.format(**context)


# ---------------------------------------------------------------------------
# Schema Builder
# ---------------------------------------------------------------------------

class ToolSchemaBuilder:
    """Fluent builder for complete tool schemas.

    Use when: defining a new tool's schema programmatically and want
    compile-time structure rather than hand-written dictionaries.
    """

    def __init__(self, name: str) -> None:
        self.name: str = name
        self.description: str = ""
        self.detailed_description: str = ""
        self.parameters: List[Dict[str, Any]] = []
        self.returns: Optional[Dict[str, Any]] = None
        self.errors: List[Dict[str, str]] = []
        self._triggers: List[str] = []
        self._examples: List[Dict[str, str]] = []

    def set_description(self, short: str, detailed: str) -> "ToolSchemaBuilder":
        """Set short and detailed description sections.

        Use when: providing both a one-line summary and a full
        multi-paragraph description for the tool.
        """
        self.description = short
        self.detailed_description = detailed
        return self

    def add_parameter(
        self,
        name: str,
        param_type: str,
        description: str,
        required: bool = False,
        default: Optional[Any] = None,
        enum: Optional[List[str]] = None,
    ) -> "ToolSchemaBuilder":
        """Append a parameter definition.

        Use when: declaring each accepted input for the tool.
        """
        self.parameters.append({
            "name": name,
            "type": param_type,
            "description": description,
            "required": required,
            "default": default,
            "enum": enum,
        })
        return self

    def set_returns(
        self,
        return_type: str,
        description: str,
        properties: Dict[str, Any],
    ) -> "ToolSchemaBuilder":
        """Define the return value schema.

        Use when: documenting what the tool sends back on success.
        """
        self.returns = {
            "type": return_type,
            "description": description,
            "properties": properties,
        }
        return self

    def add_error(
        self,
        code: str,
        description: str,
        resolution: str,
    ) -> "ToolSchemaBuilder":
        """Register an error condition with recovery guidance.

        Use when: enumerating known failure modes so agents can
        handle them gracefully.
        """
        self.errors.append({
            "code": code,
            "description": description,
            "resolution": resolution,
        })
        return self

    def build(self) -> "_BuiltToolSpec":
        """Assemble and return the complete tool spec.

        Use when: the builder is fully configured and the schema is
        ready for registration, serialization, or passing to
        ``generate_tool_description``.

        Returns a ``_BuiltToolSpec`` object that satisfies the ``ToolSpec``
        protocol, so it can be used directly with ``generate_tool_description``
        and ``ToolDescriptionEvaluator``.
        """
        return _BuiltToolSpec(
            name=self.name,
            description=self.detailed_description or self.description,
            triggers=self._triggers,
            examples=self._examples,
            parameters=list(self.parameters),
            returns=self.returns or {},
            errors=list(self.errors),
        )

    def add_trigger(self, trigger: str) -> "ToolSchemaBuilder":
        """Add an activation trigger for the tool.

        Use when: documenting when agents should select this tool.
        """
        self._triggers.append(trigger)
        return self

    def add_example(
        self, input_text: str, tool_call: str
    ) -> "ToolSchemaBuilder":
        """Add a usage example.

        Use when: providing concrete input/output pairs that help agents
        understand expected usage.
        """
        self._examples.append({"input": input_text, "tool_call": tool_call})
        return self


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # Quick demo: build a schema, render it, and evaluate it.
    builder = ToolSchemaBuilder("get_customer")
    builder.set_description(
        "Retrieve customer record by ID",
        "Fetches a customer object from the primary datastore. "
        "Supports concise and detailed response formats.",
    )
    builder.add_parameter(
        "customer_id", "string",
        'Customer identifier in CUST-###### format (e.g., "CUST-000001")',
        required=True,
    )
    builder.add_parameter(
        "format", "string",
        '"concise" for key fields, "detailed" for complete record',
        required=False,
        default="concise",
        enum=["concise", "detailed"],
    )
    builder.set_returns(
        "object",
        "Customer object with requested fields",
        {"id": {"type": "string"}, "name": {"type": "string"}},
    )
    builder.add_error("NOT_FOUND", "Customer ID not in datastore", "Verify ID format and retry")
    builder.add_error("INVALID_FORMAT", "ID does not match CUST-######", "Use CUST-###### pattern")

    spec = builder.build()

    print("=== Built Spec ===")
    print(f"Name: {spec.name}")
    print(f"Parameters: {[p['name'] for p in spec.parameters]}")
    print(f"Errors: {[e['code'] for e in spec.errors]}")

    # Generate and evaluate description
    description = generate_tool_description(spec)
    print("\n=== Generated Description ===")
    print(description)

    evaluator = ToolDescriptionEvaluator()
    scores = evaluator.evaluate(description, spec)
    print("\n=== Evaluation Scores ===")
    for criterion, score in scores.items():
        print(f"  {criterion}: {score:.2f}")

    # Generate an error message example
    err_gen = ErrorMessageGenerator()
    err_msg = err_gen.generate("NOT_FOUND", {
        "error_code": "NOT_FOUND",
        "specific_message": "No customer with ID CUST-999999",
        "how_to_resolve": "Check ID and retry",
        "correct_format": "CUST-######",
    })
    print("\n=== Sample Error Message ===")
    print(err_msg)
