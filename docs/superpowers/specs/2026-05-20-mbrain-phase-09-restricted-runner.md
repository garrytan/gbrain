# Phase 09: Restricted Claude/Codex Runner

Date: 2026-05-20
Status: Detailed phase spec
Depends on: Phase 05 and Phase 08

## Goal

Allow MBrain to use local Claude Code, Codex, local models, or remote providers
as restricted maintenance runners for memory-specific tasks. Runners improve
extraction and review quality without becoming arbitrary agent execution.

## Design Decisions

- Runner use is configured during onboarding.
- Prefer local Claude Code or Codex when available and allowed.
- Runner authority is task-type allowlisted.
- Runner can use scoped MBrain tools.
- Runner cannot execute arbitrary shell commands.
- Runner cannot access connector credentials.
- Canonical mutation remains controlled by MBrain policy engine.

## In Scope

- runner registry.
- runner availability detection.
- runner job schema integration.
- task-type allowlists.
- scoped raw access.
- tool-call ledger.
- token/cost accounting where available.
- prompt/input/output hashing.
- fallback chain.

## Out Of Scope

- General `mbrain agent run` product surface.
- Arbitrary shell job runner.
- Fanout research platform.
- Remote hosted runner service.

## Runner Priority

Default priority:

1. local Claude Code runner
2. local Codex runner
3. local model runner, such as Ollama/LM Studio
4. configured remote model provider
5. deterministic/report-only fallback

Onboarding may change this priority.

## Task Types

Initial task types:

- `assertion_extraction`
- `consolidation_review`
- `contradiction_review`
- `forgetting_review`
- `source_summary`
- `daily_report`

Each task type has its own tool allowlist.

## Tool Allowlist

Allowed examples:

- read scoped source excerpt
- read assertion context
- create extracted claim
- propose assertion update
- propose supersession
- propose conflict resolution
- propose expire/archive
- draft source summary
- draft report section

Denied by default:

- arbitrary `put_page`
- arbitrary file write
- shell execution
- connector credential access
- full raw source dump
- policy override
- direct purge execution
- direct canonical mutation bypassing policy

## Raw Access

Runner raw access is scoped by:

- source policy
- task type
- source item/chunk ids
- token budget
- time window
- sensitivity
- prompt-injection status
- secret redaction status

Every raw access writes to `raw_access_ledger`.

## Runner Job Records

Tables:

- `runner_jobs`
- `runner_tool_calls`
- `runner_messages`
- `runner_artifacts`

Records include:

- runner kind
- runner version
- model/provider when available
- task type
- source scope
- prompt hash
- input hash
- output hash
- tool calls
- token usage
- cost estimate
- status
- failure class

## Tests

Required tests:

- detects local runner availability
- unavailable local runner falls back
- task type gets correct tool allowlist
- denied tool call fails closed
- runner raw access is redacted and logged
- runner proposal does not directly mutate canonical memory
- budget exhaustion degrades phase
- prompt-injection quarantined source is not sent to runner

## Acceptance Criteria

- MBrain can run scoped maintenance tasks through local Claude/Codex when
  available.
- Runner output flows through extracted claims/proposals and policy.
- Runner cannot become a general-purpose execution platform.
