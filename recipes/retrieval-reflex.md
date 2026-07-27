---
id: retrieval-reflex
name: Retrieval Reflex
version: 0.1.0
description: Teaches the host agent WHEN to look something up and WHAT to pull. Ships a policy skill (trigger + retrieval spec) into the host resolver; pairs with the deterministic pointer layer in the context engine.
category: reflex
install_kind: copy-into-host-repo
requires: []
secrets: []
health_checks:
  - type: command
    argv: [gbrain, doctor, --json]
    label: Retrieval reflex wiring (see retrieval_reflex_health)
setup_time: 2 min
cost_estimate: "$0 — zero-LLM deterministic layer + a prose policy skill"
---

# Retrieval Reflex: teach the agent *when* and *what* to retrieve

gbrain is great at **storing** knowledge and at **injecting deterministic
context** every turn. It does not, by itself, teach the host agent the *policy*
of retrieval: **when** to look something up and **what** to pull. Without it,
the agent can discuss a person who has a rich brain page for several messages
without ever opening it — then answer generically about facts the brain already
knew.

This reflex has two halves:

1. **Deterministic pointer layer (automatic, on by default).** The
   `gbrain-context` engine scans each turn's user message for salient,
   resolvable entities and injects a compact pointer (name → slug → one-line
   summary) so the agent *knows the page exists*. Zero-LLM, fail-open. Nothing
   to install — it's on unless `retrieval_reflex` is disabled in
   `~/.gbrain/config.json` or `GBRAIN_RETRIEVAL_REFLEX=false`.

2. **Policy skill (this recipe installs it).** A SKILL fragment in the host
   resolver that encodes the trigger policy and retrieval spec the agent
   follows when a pointer appears or an entity becomes the subject.

## IMPORTANT: Instructions for the Agent

**You are the installer.** Run these steps on behalf of the user.

1. Confirm the deterministic layer isn't disabled:
   `gbrain doctor --json | jq '.checks[] | select(.name=="retrieval_reflex_health")'`
2. Install the policy skill into the host repo (the OpenClaw/agent repo that
   holds `skills/RESOLVER.md` or `AGENTS.md`):
   `gbrain integrations install retrieval-reflex --target <host-repo>`
3. Verify: re-run `gbrain doctor` and confirm `retrieval_reflex_health` is `ok`.

The deterministic layer needs no install. On a PGLite brain it resolves through
the running `gbrain serve` (or a host-provided capability); if neither is
available it stays disabled and this policy skill carries the behavior — the
doctor check reports which.
