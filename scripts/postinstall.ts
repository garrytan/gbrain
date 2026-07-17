#!/usr/bin/env bun
// Package installation is deliberately non-stateful. This lifecycle hook must
// never discover or execute a `gbrain` binary, inspect a brain configuration,
// or write to GBRAIN_HOME, GBRAIN_AUDIT_DIR, HOME, or USERPROFILE. Initialization,
// migrations, and upgrades are explicit operator actions documented below.

const ADVISORY = [
  '[gbrain] Package installed. No brain state was read or changed.',
  'Next step for a new brain: gbrain init',
  'After updating a source checkout: gbrain apply-migrations --yes',
  'For a managed installation: gbrain upgrade',
].join('\n');

process.stderr.write(`${ADVISORY}\n`);
