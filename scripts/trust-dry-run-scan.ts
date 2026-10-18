#!/usr/bin/env bun
/**
 * #5575 owner-custody dry run (CEO-25 / ENG-17): what the write gate would
 * flag or quarantine in an existing brain, by projected trust tier and reason
 * family. Strictly read-only:
 *   - Postgres: every read runs inside one REPEATABLE READ READ ONLY
 *     transaction, so the server refuses any write; no migrations run.
 *   - PGLite: the data directory is copied to a temp dir first and only the
 *     copy is opened (opening a PGLite directory can write WAL files), then
 *     the copy is deleted.
 * No receipts, holds, markers or config are written. The report has counts
 * and pattern names only, never content, slugs or ids.
 *
 * Usage:
 *   bun scripts/trust-dry-run-scan.ts [--json] [--source <id>] [--limit <rows per table>]
 *     [--tables pages,facts,takes,timeline_entries] [--batch <n>] [--database-url <url>]
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import type { EngineConfig } from '../src/core/types.ts';
import { scanWriteGateExposure, WRITE_GATE_SCAN_TABLES, type WriteGateScanReport, type WriteGateScanTable } from '../src/core/write-gate-scan.ts';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function pct(n: number, d: number): string {
  return d ? `${((100 * n) / d).toFixed(2)}%` : '-';
}

export function renderReport(r: WriteGateScanReport): string {
  const lines = [`write-gate dry run (detector v${r.detector_version}, external_mode=${r.config.externalMode}, agent_mode=${r.config.agentMode}${r.source_id ? `, source ${r.source_id}` : ''}); nothing was written.`];
  for (const [table, t] of Object.entries(r.tables)) {
    if (!t) continue;
    lines.push('', `${table}: ${t.scanned} rows${t.truncated ? ' (limit reached)' : ''}`);
    lines.push('  tier                 rows      detector hits   flag      quarantine  families');
    for (const [tier, s] of Object.entries(t.by_tier)) {
      if (!s.rows) continue;
      const fam = Object.entries(s.families).filter(([, n]) => n).map(([f, n]) => `${f}=${n}`).join(' ');
      lines.push(`  ${tier.padEnd(20)} ${String(s.rows).padEnd(9)} ${`${s.detector_hits} (${pct(s.detector_hits, s.rows)})`.padEnd(15)} ${`${s.verdicts.flag}`.padEnd(9)} ${`${s.verdicts.quarantine}`.padEnd(11)} ${fam}`);
    }
    const top = Object.entries(t.patterns).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([p, n]) => `${p}=${n}`).join(' ');
    if (top) lines.push(`  top patterns: ${top}`);
  }
  const tt = r.totals;
  lines.push('', `total: ${tt.rows} rows; would flag ${tt.flagged} (${pct(tt.flagged, tt.rows)}), quarantine ${tt.quarantined} (${pct(tt.quarantined, tt.rows)}); detector hit rate if every row were agent-written ${pct(tt.detector_hits, tt.rows)}.`);
  return lines.join('\n');
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: bun scripts/trust-dry-run-scan.ts [--json] [--source <id>] [--limit <rows per table>] [--tables pages,facts,takes,timeline_entries] [--batch <n>] [--database-url <url>]');
    return 0;
  }
  const tables = (flag(args, '--tables')?.split(',').map(t => t.trim()).filter(Boolean) ?? [...WRITE_GATE_SCAN_TABLES]) as WriteGateScanTable[];
  const unknown = tables.filter(t => !WRITE_GATE_SCAN_TABLES.includes(t));
  if (unknown.length) { console.error(`Unknown table(s): ${unknown.join(', ')}. Choose from ${WRITE_GATE_SCAN_TABLES.join(', ')}.`); return 2; }
  const limit = flag(args, '--limit');
  const batch = flag(args, '--batch');
  const url = flag(args, '--database-url');
  const config = loadConfig();
  let engineConfig: EngineConfig;
  if (url) engineConfig = { engine: 'postgres', database_url: url };
  else if (config) engineConfig = toEngineConfig(config);
  else { console.error('No GBrain config found. Pass --database-url, or run on the brain host.'); return 1; }
  let copyDir: string | null = null;
  if ((engineConfig.engine ?? (engineConfig.database_url ? 'postgres' : 'pglite')) === 'pglite') {
    if (!engineConfig.database_path) { console.error('PGLite brain has no database_path in its config.'); return 1; }
    copyDir = mkdtempSync(join(tmpdir(), 'gbrain-trust-dry-run-'));
    const target = join(copyDir, 'brain.pglite');
    cpSync(engineConfig.database_path, target, { recursive: true });
    rmSync(join(target, 'postmaster.pid'), { force: true });
    engineConfig = { ...engineConfig, database_path: target };
    process.stderr.write(`[trust-dry-run] PGLite: scanning a copy at ${target}; the original is not opened.\n`);
  }
  const engine = await createEngine(engineConfig);
  try {
    await engine.connect(engineConfig);
    const report = await engine.transaction(async tx => {
      await tx.executeRaw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return scanWriteGateExposure(tx, {
        tables, ...(flag(args, '--source') ? { sourceId: flag(args, '--source') } : {}),
        ...(limit ? { limitPerTable: Number(limit) } : {}), ...(batch ? { batchSize: Number(batch) } : {}),
        onBatch: (table, n) => process.stderr.write(`[trust-dry-run] ${table}: ${n} rows\n`),
      });
    });
    console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : renderReport(report));
    return 0;
  } finally {
    await engine.disconnect().catch(() => {});
    if (copyDir) rmSync(copyDir, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(await main());
