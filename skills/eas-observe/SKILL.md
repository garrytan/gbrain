---
name: eas-observe
description: EAS service (paid). Use for anything related to EAS Observe - adding `expo-observe` to an Expo project (AppMetricsRoot/ObserveRoot HOC, markInteractive, the useObserve hook, the Expo Router / React Navigation integrations for per-route metrics, and user-defined events via `Observe.logEvent`), querying via the EAS CLI (`eas observe:metrics-summary`, `observe:metrics`, `observe:routes`, `observe:events`, `observe:versions`), or interpreting the resulting metrics (cold/warm launch, TTR, TTI, navigation cold/warm TTR, update download, and the TTI frameRate params for triaging slow startups).
version: 1.0.0
license: MIT
---

# EAS Observe

> **EAS service - costs apply.** EAS Observe is a paid Expo Application Services product with free-tier limits. Ingesting and querying production metrics counts against your plan's event/usage allowance. Review https://expo.dev/pricing before enabling it in production.

EAS Observe tracks startup, navigation, and custom-event performance from production Expo apps.

> **Source of truth:** https://docs.expo.dev/eas/observe/ — always consult the canonical docs when API details matter, especially get-started, configuration, integrations, and the metrics reference. EAS Observe is evolving; this skill's references are written to stay accurate but may lag the docs.

## Which reference to read

The three reference files in `./references/` cover the three things people typically need this skill for:

- **Adding EAS Observe to a project** → [`./references/setup.md`](./references/setup.md). Install, wrap the root layout (`AppMetricsRoot` on SDK 55, `ObserveRoot` on SDK 56+), call `markInteractive()` (global on SDK 55, via the `useObserve()` hook on SDK 56+), optional per-route navigation metrics through the Expo Router / React Navigation integrations, and user-defined events via `Observe.logEvent` (SDK 56+).
- **Querying metrics from the terminal** → [`./references/queries.md`](./references/queries.md). The five `eas observe:*` commands — `metrics-summary`, `metrics`, `routes`, `events`, `versions` — with flags, table layouts, JSON shapes, and common workflows.
- **Reading a dashboard or CLI output** → [`./references/metrics.md`](./references/metrics.md). Target thresholds per metric, what the TTI `frameRate.*` params mean, and diagnostic patterns for telling slow-but-smooth startup apart from main-thread contention or hard blocks.

## Quick links to the docs

- Get started: https://docs.expo.dev/eas/observe/get-started/
- Dashboard guide: https://docs.expo.dev/eas/observe/dashboard/
- Metrics reference: https://docs.expo.dev/eas/observe/reference/metrics/
- Expo Router integration: https://docs.expo.dev/eas/observe/integrations/expo-router/
- React Navigation integration: https://docs.expo.dev/eas/observe/integrations/react-navigation/
- User-defined events: https://docs.expo.dev/eas/observe/events/
- Configuration: https://docs.expo.dev/eas/observe/configuration/


## Contract

This skill guarantees:

- Covers its source domain per the skill description: EAS service (paid). Use for anything related to EAS Observe - adding `expo-observe` to an Expo project (AppMetricsRoot/ObserveRoot HOC, markInteractive, the useObserve hook, the Expo Router / React Navigation integrations for per-route metrics, and user-define
- Loads only task-relevant references/scripts and keeps context lean.
- Produces concrete, source-grounded output: exact commands, code snippets, app configuration, token values, or platform steps as applicable.
- Never fabricates APIs, configuration keys, UI tokens, store metadata, or platform behavior not present in the source references or current project.

## Output Format

Lead with the actionable result. For implementation tasks, return the changed files/commands and verification result. For design/mobile guidance, return concise token/component/platform steps grounded in the skill references. Avoid dumping complete reference files; cite the relevant path and extract only the decisive snippet.

## Anti-Patterns

- Inventing APIs, store metadata, UI tokens, or platform capabilities.
- Copying large references into the response when a targeted excerpt is enough.
- Applying this skill outside its domain when a more specific skill exists.
- Skipping verification commands or platform checks after making changes.
