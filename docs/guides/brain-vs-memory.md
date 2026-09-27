# Brain vs Memory vs Session

## Goal

Keep durable, shareable knowledge in GBrain; keep harness configuration and
temporary work in the layer that owns them. The distinction is durability and
authority, not whether a fact describes the user or the outside world.

**Say to your agent:** *"Remember that I prefer three-bullet meeting briefs, and
recall that preference in our next conversation."*

## What goes where

| Information | Home | Example |
|---|---|---|
| Durable facts, preferences, decisions, commitments, corrections | GBrain, with provenance and the intended brain/source | "I prefer concise recommendations"; "alice-example leads widget-co" |
| Agent identity and binding instructions | The harness's instruction files and controls | Which role the agent has; required approval before deployment |
| Tool configuration, credentials, permissions, activation state | Local configuration or the relevant credential/authorization store | MCP endpoint; token; which skill is actually enabled |
| Current conversation and transient task state | Session context or a local task checkpoint | The file currently being reviewed; a temporary command result |

An explicit request to remember a preference is a valid GBrain write. Do not
reject it as "agent configuration." Conversely, remembering that a skill was
enabled once does not prove it is enabled in this harness now. A saved preference
is data, not authority to override instructions or bypass consent.

Preserve existing identity files when adding memory. Bootstrap installations may
keep `MEMORY.md` and identity files in an agent repository, but those files are
not a replacement for shared facts with provenance and correction history.

## Lookup and correction

Recall GBrain for saved preferences, prior decisions, people, projects, and
meetings. Check the harness's actual configuration for questions about enabled
tools or permissions. Use the current conversation for immediate task context.

Save explicit requests without enabling ongoing capture; automatic capture is a
separate opt-in. Read the stored record before correcting or withdrawing it.
`forget` removes a fact from active recall, not necessarily its source material,
history, or private backups. Time-limited facts need an explicit TTL.

## How to verify

1. Save a generic preference with provenance and observe its returned fact ID.
2. Recall it with an actual GBrain call, then verify it in a new conversation in
   the intended harness. A same-process CLI test is not cross-session evidence.
3. Correct the preference and confirm recall returns the replacement.
4. Withdraw the test fact and confirm it is absent from active recall.
5. Inspect actual harness controls separately for any claimed tool activation or
   permission change. Memory does not configure the harness.

See [memory boundaries](memory-boundaries.md) for remote-write graph maintenance,
provider text disclosure, sharing limits, and why Markdown export is not a full
database backup. For new personal-agent identity setup, see [bootstrap](bootstrap.md).

---
*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
