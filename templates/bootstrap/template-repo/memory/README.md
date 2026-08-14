# memory/

Operational memory for {{AGENT_NAME}}. Three tiers:

- **`../MEMORY.md`** — hot state, loaded every main session. Small, curated,
  pruned. The only always-loaded tier.
- **`YYYY-MM-DD.md`** (this directory) — the daily log. Append-only, timestamped,
  quotes {{PRINCIPAL_NAME}}'s exact words. Never edit a daily note retroactively:
  the old entry being wrong is itself information.
- **`reference/`** — cold reference. Retrieved on demand, never auto-loaded.

Rules:

1. Write in the same turn you learn. "I will note that" is a note that never gets
   written.
2. Durable world knowledge (people, companies, decisions, events) does NOT live
   here — it goes to the brain via `put_page`/timeline entries so it is searchable.
   This directory is the agent's operational state, not the knowledge base.
3. Corrections become standing rules in `MEMORY.md`, same turn, with the incident
   attached.
4. Prune weekly. A memory file nobody reads is not memory.
