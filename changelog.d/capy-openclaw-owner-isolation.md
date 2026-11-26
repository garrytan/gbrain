---
important: security
---
**On OpenClaw, another person's message on a session the owner shares no longer runs under the owner's operator rule, pins and session brief, and owner-only skills can now be marked by name.**

<!-- behavior-change: openclaw_owner_context_withdrawn_gst4030 -->

### Fixed
- OpenClaw keeps a session's system prompt fixed and sends later changes as updates, so with its default `session.dmScope: main` the owner's rule and pins from an earlier turn stayed in force when someone else wrote next, even with `--owner-sender` set. The skill-resolver plugin (code version 7) now sends an `<owner_context_withdrawn>` block on every live conversation turn that can follow an owner turn on the same session (the main session, or any conversation OpenClaw marks with a memory audience), ahead of that conversation's own rule and pins, and logs `withdrawn: true`. Groups, channels and the owner's own heartbeat, cron and relay turns are unchanged.
- The plugin no longer logs a `skill_resolver_worker_crash` at every gateway start. OpenClaw registers plugins once for tool discovery from a temporary copy it deletes right away; the plugin warmed its worker from that copy, and the worker then failed to load. It now warms the worker only for the gateway's own load (`registrationMode` `full`, or none on older hosts), and a crash line now carries the error message.

### Added
- `gbrain setup openclaw --owner-skill <name>` (repeatable) keeps a skill to the owner's sessions by name, whatever copy OpenClaw loads, so a host-local copy without `audience: owner` front matter is never suggested or pinned in a conversation. Each run adds to the agent's list, `--no-owner-skill <name>` removes a name, and the list shows in the setup output and the plugin state. The host's skill files are never edited.
- gbrain's own owner-data skills carry `audience: owner`: briefing, daily-task-prep, cold-start, company-brainify, conversation-archive and daily-task-manager.
