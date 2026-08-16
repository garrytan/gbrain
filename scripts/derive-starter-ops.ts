#!/usr/bin/env bun
/**
 * derive-starter-ops.ts — propose the STARTER_OPS daily-driver slice from
 * production `mcp_request_log` usage (amendment 23 + D12).
 *
 * Run: bun run scripts/derive-starter-ops.ts [--days N] [--target N]
 *
 * Reads the active brain (loadConfig → engine) through the shared usage
 * reader (src/core/mcp-usage.ts — the same hygiene rules as the E4 CLI and
 * the E3 advisor drift check: JSON-RPC method rows and 'surface_change'
 * audit rows dropped, the legacy 'tools/call:<name>' prefix stripped),
 * excludes automation-shaped clients (D12: >90% context_pack/delta boundary
 * calls), and ranks ops by CLIENT COUNT — the union of per-client
 * DISTINCT-op sets, never raw call volume, so one chatty client cannot
 * define the starter set.
 *
 * PRINTS a proposed block for a human to paste into src/mcp/surface.ts
 * (replacing FALLBACK_DAILY_OPS). It NEVER edits files. The always-included
 * slices (VERB_NAMES spread + whoami + request_tools + the agent lane) are
 * composed in surface.ts itself and excluded from the proposal.
 *
 * Caveats printed with the proposal:
 *   - HTTP clients only (stdio never writes mcp_request_log).
 *   - BRAIN_TOOL_ALLOWLIST cross-check (D12): allowlist members missing from
 *     the derived set are listed — dropping one strands subagent parity.
 *   - test/mcp-surface.test.ts pins membership + monotonicity
 *     (verbs ⊆ starter ⊆ full); run it after pasting.
 */

import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import { readClientOpUsage, MCP_USAGE_DEFAULT_WINDOW_DAYS } from '../src/core/mcp-usage.ts';
import { operations } from '../src/core/operations.ts';
import { ALWAYS_INCLUDED_STARTER_OPS } from '../src/mcp/surface.ts';
import { BRAIN_TOOL_ALLOWLIST } from '../src/core/minions/tools/brain-allowlist.ts';

/** Ops surface.ts always includes regardless of derivation (shared constant). */
const ALWAYS_INCLUDED = ALWAYS_INCLUDED_STARTER_OPS;

/**
 * Default `--target` for this usage-driven recommendation tool (a tuning knob,
 * not the shipped surface — the committed STARTER_OPS set is ~26 ops).
 */
const DEFAULT_TARGET_SIZE = 20;

function parseArgs(argv: string[]): { days: number; target: number } {
  let days = MCP_USAGE_DEFAULT_WINDOW_DAYS;
  let target = DEFAULT_TARGET_SIZE;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') {
      days = Number(argv[++i]);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        console.error('--days must be an integer between 1 and 3650');
        process.exit(1);
      }
    } else if (argv[i] === '--target') {
      target = Number(argv[++i]);
      if (!Number.isInteger(target) || target < ALWAYS_INCLUDED.size) {
        console.error(`--target must be an integer >= ${ALWAYS_INCLUDED.size} (the always-included slice)`);
        process.exit(1);
      }
    } else {
      console.error(`Unknown flag: ${argv[i]}`);
      console.error('Usage: bun run scripts/derive-starter-ops.ts [--days N] [--target N]');
      process.exit(1);
    }
  }
  return { days, target };
}

const { days, target } = parseArgs(process.argv.slice(2));

const config = loadConfig();
if (!config) {
  console.error('No GBrain config found. Run `gbrain init` first, or set DATABASE_URL / GBRAIN_DATABASE_URL.');
  process.exit(1);
}
const engineConfig = toEngineConfig(config);
const engine = await createEngine(engineConfig);
await engine.connect(engineConfig);

async function run(): Promise<number> {
  let usage: Awaited<ReturnType<typeof readClientOpUsage>>;
  try {
    usage = await readClientOpUsage(engine, { days });
  } catch (e) {
    // A brain that never served remote MCP may lack the table entirely.
    console.error('Could not read mcp_request_log — has this brain ever served remote MCP?');
    console.error(`  ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const automation = usage.filter((u) => u.likely_automation);
  const real = usage.filter((u) => !u.likely_automation);

  const knownOps = new Map(operations.map((o) => [o.name, o]));

  // Client-count ranking over per-client DISTINCT-op sets (D12).
  const clientCount = new Map<string, number>();
  const callCount = new Map<string, number>();
  const skippedUnknown = new Set<string>();
  for (const u of real) {
    for (const op of u.distinct_ops) {
      const known = knownOps.get(op);
      if (!known) {
        skippedUnknown.add(op); // attempted-but-nonexistent names from error rows
        continue;
      }
      if (known.localOnly) continue; // never proposable for a network surface
      clientCount.set(op, (clientCount.get(op) ?? 0) + 1);
      callCount.set(op, (callCount.get(op) ?? 0) + (u.ops[op] ?? 0));
    }
  }

  const ranked = [...clientCount.entries()]
    .sort((a, b) => b[1] - a[1] || (callCount.get(b[0]) ?? 0) - (callCount.get(a[0]) ?? 0) || (a[0] < b[0] ? -1 : 1))
    .map(([op]) => op);
  const derivedSlots = Math.max(0, target - ALWAYS_INCLUDED.size);
  const proposal = ranked.filter((op) => !ALWAYS_INCLUDED.has(op)).slice(0, derivedSlots);

  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push('/**');
  lines.push(` * STARTER_OPS daily-driver slice — derived from production mcp_request_log.`);
  lines.push(` * Provenance: window=${days}d, generated=${today}, script=scripts/derive-starter-ops.ts,`);
  lines.push(` * clients=${real.length} (excluded ${automation.length} automation-shaped: >90% context_pack/delta).`);
  lines.push(` * HTTP clients only — stdio does not write mcp_request_log.`);
  lines.push(` * NOTE: VERB_NAMES + whoami + request_tools + the agent lane (submit_agent,`);
  lines.push(` * get_agent_job) are ALWAYS included by surface.ts and are not listed here.`);
  lines.push(' */');
  lines.push('const DERIVED_DAILY_OPS: readonly string[] = [');
  for (const op of proposal) {
    lines.push(`  '${op}', // ${clientCount.get(op)} client${clientCount.get(op) === 1 ? '' : 's'}, ${callCount.get(op)} calls/${days}d`);
  }
  lines.push('];');

  console.log(`# derive-starter-ops — ${days}d window, ${usage.length} clients seen (${automation.length} automation-shaped excluded)\n`);
  if (real.length === 0) {
    console.log('No non-automation HTTP client usage in the window. The FOV-6b fallback');
    console.log('(BRAIN_TOOL_ALLOWLIST ∪ agent lane) in src/mcp/surface.ts remains the right set.');
    return 0;
  }

  console.log('Ranked ops (client count desc, then call count):');
  for (const op of ranked) {
    const marks: string[] = [];
    if (ALWAYS_INCLUDED.has(op)) marks.push('always-included');
    if (proposal.includes(op)) marks.push('PROPOSED');
    console.log(`  ${op.padEnd(28)} clients=${clientCount.get(op)}  calls=${callCount.get(op)}${marks.length ? '  [' + marks.join(', ') + ']' : ''}`);
  }
  if (skippedUnknown.size > 0) {
    console.log(`\nSkipped ${skippedUnknown.size} logged name(s) not in the operations catalog (failed-call attempts).`);
  }

  const allowlistMissing = [...BRAIN_TOOL_ALLOWLIST].filter(
    (op: string) => !proposal.includes(op) && !ALWAYS_INCLUDED.has(op),
  );
  if (allowlistMissing.length > 0) {
    console.log(`\nWARNING (D12 cross-check): BRAIN_TOOL_ALLOWLIST members absent from the proposal:`);
    console.log(`  ${allowlistMissing.join(', ')}`);
    console.log('  Dropping these breaks subagent/starter parity — include them unless deliberate.');
  }

  console.log('\nProposed block — paste into src/mcp/surface.ts (replacing FALLBACK_DAILY_OPS),');
  console.log('then run: bun test --timeout=60000 test/mcp-surface.test.ts && bun run scripts/generate-tool-catalog.ts\n');
  console.log(lines.join('\n'));
  return 0;
}

let exitCode = 1;
try {
  exitCode = await run();
} finally {
  await engine.disconnect();
}
process.exit(exitCode);
