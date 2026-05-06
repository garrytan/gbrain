# MCP Server Instructions

This is a **documentation-only** copy of the instructions text returned by the
MBrain MCP server in its `InitializeResult`. The runtime constant lives in
`src/core/operations.ts` (`MCP_INSTRUCTIONS`).

---

```
Use this server to look up knowledge about people, companies, technical concepts,
internal systems, and organizational context. Prefer this over web search or codebase
grep when the question involves a named entity, domain concept, or cross-system
architecture. The brain contains compiled truth, relationship history, and technical
maps that external search cannot provide.

Do not use for: code editing, git operations, file management, library documentation,
or general programming.
```

---

## Design Principles

- **Read-trigger only** — no write-back directives (protocol is in MBRAIN_AGENT_RULES.md)
- **Domain-specific** — lists exactly what MBrain covers, not a blanket "use me first"
- **Negative list** — explicitly says what MBrain is NOT for (avoids conflict with Context7 etc.)
- **Under 500 characters** — forces focus

## Layered Enforcement

| Layer | What | Where |
|-------|------|-------|
| MCP Instructions | WHEN to use MBrain | `operations.ts` → `InitializeResult` |
| Tool Descriptions | WHICH retrieval layer to use | `operations.ts` → `retrieve_context`, `read_context`, `search`, `query`, `get_page` |
| Agent Rules | HOW to use MBrain | `MBRAIN_AGENT_RULES.md` |
| Skillpack | REFERENCE for advanced patterns | `MBRAIN_SKILLPACK.md` |

- Normal factual Q&A should prefer `retrieve_context -> read_context` because
  raw `search` and `query` chunks are candidate pointers. The runtime
  `MCP_INSTRUCTIONS` stays short; the detailed tool choice lives in operation
  descriptions and skills.
- `retrieve_context` is the agent probe: it discovers candidates, applies route
  and scope context, and returns required canonical reads.
- `read_context` is the evidence boundary: it reads bounded canonical selectors
  before factual answers.
- `search` and `query` remain lower-level candidate discovery tools; `get_page`
  remains the full-page canonical read escape hatch.

## See Also

- [Agent Rules](MBRAIN_AGENT_RULES.md)
