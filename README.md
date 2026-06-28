# AIMS Brain

**AIMS Brain** is the iTradeAIMS network's owned semantic-memory + code-intelligence
engine — a pull-only derived index over the iTradeAIMS repo network plus MQL/C++
code-intelligence, queried by the coding-agent fleet and the AIMS MCP.

It is a **maintained fork of [`garrytan/gbrain`](https://github.com/garrytan/gbrain)**,
inbound-only: we merge upstream engine + security fixes IN; we do not contribute out
(governance: **ADR-0041** in `itradeaims-agent-workflows`).

## Layers

- **AIMS Brain** — the product/identity: the served brain over the repo network.
- **`itradeaims-brain`** — this repo, the engine.
- **`gbrain-immy`** ([gbrain-immy.fly.dev](https://gbrain-immy.fly.dev)) — the served Fly
  instance; reached over MCP as `mcp__gbrain__*`.
- **`garrytan/gbrain`** — upstream.

## Quick links

- **[`AIMS-BRAIN.md`](AIMS-BRAIN.md)** — the charter: identity, the owned-fork
  relationship, boundaries, how to merge upstream.
- **[`AGENTS.md`](AGENTS.md)** — the agent operating contract + install protocol.
- **[`CLAUDE.md`](CLAUDE.md)** — engine internals, architecture, and cross-cutting
  invariants (read the AIMS-Brain header first).
- **Governance / network** — the AIMS MCP control plane (`itradeaims-agent-workflows`),
  a separate authority (ADR-0031).

For engine internals and the load-bearing invariants, see [`CLAUDE.md`](CLAUDE.md).
