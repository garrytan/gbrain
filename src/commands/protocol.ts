/**
 * MEMORY_VERBS v1 — `gbrain protocol` (Cathedral 1, E2 + E4 + D6C).
 *
 *   gbrain protocol [--json]            machine-readable verb schemas + version
 *   gbrain protocol conformance [...]   certify an MCP endpoint against the contract
 *   gbrain protocol stats [--days N]    local verb usage + TTHW (never uploaded)
 *
 * Conformance targets:
 *   (default)                     spawn gbrain's own stdio server (self-certify)
 *   --target http://host/mcp      Streamable HTTP endpoint [--token gbrain_xxx]
 *   --target "cmd arg arg"        spawn any stdio MCP server (space-split; for
 *                                 commands with complex quoting, certify via a
 *                                 small wrapper script)
 *
 * Input schemas emit from the LIVE Operation defs (doc/code can't drift);
 * response shapes come from the hand-authored RESPONSE_SCHEMAS registry,
 * which conformance validates LIVE responses against — registry-vs-code
 * drift is caught by the same fixtures that certify servers [c8].
 */

import { operationsByName } from '../core/operations.ts';
import {
  RESPONSE_SCHEMAS,
  ERROR_SCHEMA,
  MEMORY_VERBS_VERSION,
  VERB_NAMES,
  type VerbName,
} from '../core/verbs.ts';
import { buildToolDefs } from '../mcp/tool-defs.ts';
import { runConformance, type ConformanceClient } from '../core/verbs/conformance.ts';
import { readVerbUsage, earliestVerbUsageTs, usageLogPath } from '../core/verbs/usage-log.ts';
import { loadConfig } from '../core/config.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';

const HELP = `gbrain protocol — the MEMORY_VERBS v1 wire contract (frozen, additive-forever)

Usage:
  gbrain protocol [--json]              Print the protocol: verb input schemas
                                        (from live defs), response schemas, error
                                        contract, version. --json for machines.
  gbrain protocol conformance           Certify an MCP endpoint against the
                                        contract. Default target: gbrain's own
                                        stdio server (self-certification).
    --target http://host:3131/mcp       HTTP MCP endpoint (add --token gbrain_xxx)
    --target "bun run src/cli.ts serve" Any stdio MCP server command
    --synthesize                        Also live-call synthesize (costs money
                                        when an LLM key is configured; without
                                        one it asserts the clean 'unavailable'
                                        error — what CI does)
    --json                              Machine-readable report
  gbrain protocol stats [--days N]      Per-verb usage, error rate, budget drops,
                                        entity hit rate, TTHW (install -> first
                                        verb call). Local JSONL only — this data
                                        never leaves the machine. Default 30 days.

Docs: docs/protocol/MEMORY_VERBS_v1.md
Why default surface is 'full': verbs is for agents and quickstarts
(gbrain serve --surface verbs); full preserves existing advanced tooling.`;

export async function runProtocol(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }
  const sub = args[0] && !args[0].startsWith('--') ? args[0] : null;

  if (sub === 'conformance') {
    await runConformanceCommand(args.slice(1));
    return;
  }
  if (sub === 'stats') {
    await runStatsCommand(args.slice(1));
    return;
  }
  if (sub === null) {
    printProtocol(args.includes('--json'));
    return;
  }
  console.error(`Unknown protocol subcommand: ${sub}`);
  console.log(HELP);
  // [ship P1.3] PGLite/WASM clobbers process.exitCode; the CLI exit seam reads
  // the gbrain-owned verdict (setCliExitVerdict), not process.exitCode.
  setCliExitVerdict(1);
}

// ─── protocol [--json] ───────────────────────────────────────────────────────

function buildProtocolDocument() {
  const verbOps = VERB_NAMES.map(n => operationsByName[n]).filter(Boolean);
  const toolDefs = buildToolDefs(verbOps);
  const verbs: Record<string, unknown> = {};
  for (const def of toolDefs) {
    verbs[def.name] = {
      description: def.description,
      input_schema: def.inputSchema,
      ...(def.annotations ? { annotations: def.annotations } : {}),
      response_schema: RESPONSE_SCHEMAS[def.name as VerbName],
    };
  }
  return {
    protocol: 'MEMORY_VERBS',
    protocol_version: MEMORY_VERBS_VERSION,
    versioning_policy:
      'additive-forever: v1 field names and semantics never change; new optional fields/params may be added; breaking changes require MEMORY_VERBS_v2 (expected never)',
    verbs,
    error_schema: ERROR_SCHEMA,
  };
}

function printProtocol(json: boolean): void {
  const doc = buildProtocolDocument();
  if (json) {
    console.log(JSON.stringify(doc, null, 2));
    return;
  }
  console.log(`MEMORY_VERBS v${MEMORY_VERBS_VERSION} — the frozen memory protocol (additive-forever)\n`);
  for (const name of VERB_NAMES) {
    const op = operationsByName[name];
    if (!op) continue;
    const params = Object.entries(op.params)
      .map(([k, v]) => `${k}${v.required ? '' : '?'}`)
      .join(', ');
    console.log(`  ${name}(${params})`);
    console.log(`      ${op.description.split('. ')[0]}.`);
  }
  console.log(`\nFull schemas: gbrain protocol --json`);
  console.log(`Doc: docs/protocol/MEMORY_VERBS_v1.md`);
}

// ─── protocol conformance ────────────────────────────────────────────────────

async function runConformanceCommand(args: string[]): Promise<void> {
  const json = args.includes('--json');
  const synthesize = args.includes('--synthesize');
  const targetIdx = args.indexOf('--target');
  const target = targetIdx >= 0 ? args[targetIdx + 1] : null;
  const tokenIdx = args.indexOf('--token');
  const token = tokenIdx >= 0 ? args[tokenIdx + 1] : null;

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const client = new Client({ name: 'gbrain-conformance', version: '1.0.0' }, { capabilities: {} });

  let transport: { close(): Promise<void> };
  if (target && /^https?:\/\//.test(target)) {
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const t = new StreamableHTTPClientTransport(new URL(target), {
      ...(token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {}),
    });
    await client.connect(t);
    transport = t;
  } else {
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    let command: string;
    let cmdArgs: string[];
    if (target) {
      const parts = target.split(/\s+/).filter(Boolean);
      command = parts[0];
      cmdArgs = parts.slice(1);
    } else {
      // Self-certification: spawn our own server. Dev (bun run src/cli.ts)
      // vs compiled binary both resolve to "this gbrain, serve".
      const entry = process.argv[1] ?? '';
      if (entry.endsWith('.ts')) {
        command = process.execPath;
        cmdArgs = ['run', entry, 'serve'];
      } else {
        command = process.execPath;
        cmdArgs = ['serve'];
      }
    }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    const t = new StdioClientTransport({ command, args: cmdArgs, env });
    await client.connect(t);
    transport = t;
  }

  const adapter: ConformanceClient = {
    listTools: async () => {
      const { tools } = await client.listTools();
      return tools.map(t => ({
        name: t.name,
        description: t.description,
        annotations: (t as { annotations?: unknown }).annotations,
      }));
    },
    callTool: async (name, callArgs) => {
      const res = (await client.callTool({ name, arguments: callArgs })) as {
        isError?: boolean;
        content?: Array<{ type?: string; text?: string }>;
      };
      const text = (res.content ?? []).map(c => (typeof c.text === 'string' ? c.text : '')).join('\n');
      return { isError: res.isError, text };
    },
  };

  try {
    const report = await runConformance(adapter, { synthesize });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`MEMORY_VERBS v${report.protocol_version} conformance — target: ${target ?? 'self (stdio)'}\n`);
      for (const r of report.results) {
        const mark = r.status === 'pass' ? '✓' : r.status === 'skip' ? '−' : '✗';
        console.log(`  ${mark} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
      }
      console.log(`\n${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`);
      console.log(report.ok ? 'CONFORMANT' : 'NOT CONFORMANT');
    }
    // [ship P1.3] non-conformant target MUST exit non-zero so CI fails. The
    // CLI exit seam reads setCliExitVerdict (process.exitCode is unreliable on
    // PGLite/WASM and ignored by the force-exit path).
    if (!report.ok) setCliExitVerdict(1);
  } finally {
    try { await client.close(); } catch { /* best-effort */ }
    try { await transport.close(); } catch { /* best-effort */ }
  }
}

// ─── protocol stats ──────────────────────────────────────────────────────────

async function runStatsCommand(args: string[]): Promise<void> {
  const json = args.includes('--json');
  const daysIdx = args.indexOf('--days');
  const days = daysIdx >= 0 ? parseInt(args[daysIdx + 1] ?? '30', 10) || 30 : 30;

  const events = await readVerbUsage({ days });
  const byVerb = new Map<string, { calls: number; errors: number; latency: number; budgetDropped: number; entityFound: number; entityMiss: number }>();
  for (const e of events) {
    const v = byVerb.get(e.verb) ?? { calls: 0, errors: 0, latency: 0, budgetDropped: 0, entityFound: 0, entityMiss: 0 };
    v.calls += 1;
    if (!e.ok) v.errors += 1;
    v.latency += e.latency_ms;
    if (typeof e.budget_dropped === 'number') v.budgetDropped += e.budget_dropped;
    if (e.entity_found === true) v.entityFound += 1;
    if (e.entity_found === false) v.entityMiss += 1;
    byVerb.set(e.verb, v);
  }

  // TTHW [D6C]: install stamp → first verb call, the real measured number the
  // post-ship boomerang review compares against the 2–5 min target.
  const cfg = loadConfig();
  const installedAt = cfg?.protocol_installed_at ?? null;
  const firstCall = await earliestVerbUsageTs();
  let tthw: string | null = null;
  if (installedAt && firstCall) {
    const deltaMs = Date.parse(firstCall) - Date.parse(installedAt);
    if (Number.isFinite(deltaMs) && deltaMs >= 0) tthw = formatDuration(deltaMs);
  }

  if (json) {
    console.log(JSON.stringify({
      days,
      total_calls: events.length,
      by_verb: Object.fromEntries(
        [...byVerb.entries()].map(([k, v]) => [k, {
          calls: v.calls,
          errors: v.errors,
          avg_latency_ms: v.calls ? Math.round(v.latency / v.calls) : 0,
          budget_dropped_total: v.budgetDropped,
          ...(k === 'entity' ? { found: v.entityFound, miss: v.entityMiss } : {}),
        }]),
      ),
      tthw_install_to_first_verb: tthw,
      installed_at: installedAt,
      first_verb_call: firstCall,
      sidecar: usageLogPath(),
      privacy: 'local JSONL only — never uploaded',
    }, null, 2));
    return;
  }

  console.log(`MEMORY_VERBS usage — last ${days} days (local JSONL only, never uploaded)\n`);
  if (events.length === 0) {
    console.log('  no verb calls recorded yet');
  } else {
    for (const [verb, v] of [...byVerb.entries()].sort((a, b) => b[1].calls - a[1].calls)) {
      const extras = [
        v.errors ? `${v.errors} errors` : null,
        v.budgetDropped ? `${v.budgetDropped} budget-dropped` : null,
        verb === 'entity' && (v.entityFound || v.entityMiss)
          ? `hit ${v.entityFound}/${v.entityFound + v.entityMiss}`
          : null,
      ].filter(Boolean).join(', ');
      console.log(`  ${verb.padEnd(11)} ${String(v.calls).padStart(5)} calls  avg ${Math.round(v.latency / v.calls)}ms${extras ? `  (${extras})` : ''}`);
    }
  }
  if (tthw) console.log(`\n  TTHW: first verb call ${tthw} after install`);
  else if (installedAt) console.log(`\n  TTHW: no verb calls since install (${installedAt})`);
  console.log(`  sidecar: ${usageLogPath()}`);
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ''}`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d`;
}

/** Test seam: the protocol document, without printing. */
export { buildProtocolDocument };
