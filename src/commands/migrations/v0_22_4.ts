/**
 * v0.22.4 migration orchestrator — frontmatter-guard adoption.
 *
 * v0.22.4 ships a shared frontmatter validator (parseMarkdown(..., {validate:true})),
 * a doctor subcheck (frontmatter_integrity), a top-level `gbrain frontmatter`
 * CLI (validate / audit / install-hook), and a new `frontmatter-guard` skill.
 *
 * This migration is AUDIT-ONLY (per D5): it reads the user's brain pages,
 * writes a JSON report to ~/.gbrain/migrations/v0.22.4-audit.json, and emits
 * one entry per source-with-issues to ~/.gbrain/migrations/pending-host-work.jsonl.
 * It NEVER mutates brain content. The agent reads skills/migrations/v0.22.4.md
 * after upgrade and runs `gbrain frontmatter validate <source-path> --fix` with
 * explicit user consent.
 *
 * Phases (all idempotent):
 *   A. Schema   — no-op (no DB changes in v0.22.4).
 *   B. Audit    — scanBrainSources → write JSON report.
 *   C. Emit-todo — append pending-host-work.jsonl entry per source with errors.
 *   D. Record   — runner-owned ledger write.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import type { Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult } from './types.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { loadConfig, toEngineConfig } from '../../core/config.ts';
import { createEngine } from '../../core/engine-factory.ts';
import { scanBrainSources, type AuditReport } from '../../core/brain-writer.ts';

/** Test-only injection point for the audit phase. When set, phaseBAudit uses
 *  this engine instead of loading config + creating a fresh one. Mirrors the
 *  repair-jsonb pattern. Reset to null in afterAll. */
let testEngineOverride: BrainEngine | null = null;
export function __setTestEngineOverride(engine: BrainEngine | null): void {
  testEngineOverride = engine;
}

function gbrainDir(): string {
  return join(process.env.HOME || '', '.gbrain');
}
function migrationsDir(): string { return join(gbrainDir(), 'migrations'); }
function auditReportPath(): string { return join(migrationsDir(), 'v0.22.4-audit.json'); }
function pendingHostWorkPath(): string { return join(migrationsDir(), 'pending-host-work.jsonl'); }

interface PendingHostWorkEntry {
  migration: string;
  ts: string;
  skill: string;
  reason: string;
  source_id: string;
  source_path: string;
  command: string;
}

// ── Phase A — Schema (no-op) ───────────────────────────────

function phaseASchema(opts: OrchestratorOpts): OrchestratorPhaseResult {
  if (opts.dryRun) return { name: 'schema', status: 'skipped', detail: 'dry-run' };
  return { name: 'schema', status: 'complete', detail: 'no schema changes in v0.22.4' };
}

// ── Phase B — Audit ────────────────────────────────────────

async function phaseBAudit(opts: OrchestratorOpts): Promise<{ phase: OrchestratorPhaseResult; report: AuditReport | null }> {
  if (opts.dryRun) return { phase: { name: 'audit', status: 'skipped', detail: 'dry-run' }, report: null };
  try {
    let report: AuditReport;
    if (testEngineOverride) {
      // Test injection path: caller manages engine lifecycle.
      report = await scanBrainSources(testEngineOverride);
    } else {
      const config = loadConfig();
      if (!config) {
        // No brain configured (fresh dev install or test environment). The
        // migration audit needs a real brain to walk; treat this as a clean
        // skip rather than a failure so apply-migrations doesn't break.
        return {
          phase: { name: 'audit', status: 'skipped', detail: 'no_brain_configured' },
          report: null,
        };
      }
      const engineConfig = toEngineConfig(config);
      const engine = await createEngine(engineConfig);
      await engine.connect(engineConfig);
      try {
        report = await scanBrainSources(engine);
      } finally {
        await engine.disconnect();
      }
    }
    if (report.per_source.length === 0) {
      // No sources registered — fresh install or dev-only install. Skip
      // cleanly; the orchestrator should report success.
      return {
        phase: { name: 'audit', status: 'skipped', detail: 'no_sources_registered' },
        report,
      };
    }
    mkdirSync(migrationsDir(), { recursive: true });
    writeFileSync(auditReportPath(), JSON.stringify(report, null, 2));
    return {
      phase: {
        name: 'audit',
        status: 'complete',
        detail: `${report.total} issue(s) across ${report.per_source.length} source(s); report at ${auditReportPath()}`,
      },
      report,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { phase: { name: 'audit', status: 'failed', detail: msg }, report: null };
  }
}

// ── Phase C — Emit pending-host-work entries ──────────────

function existingEntriesForVersion(version: string): Set<string> {
  const out = new Set<string>();
  const p = pendingHostWorkPath();
  if (!existsSync(p)) return out;
  try {
    const raw = readFileSync(p, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as PendingHostWorkEntry;
        if (obj.migration === version && obj.source_id) {
          out.add(obj.source_id);
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* read error */ }
  return out;
}

function phaseCEmitTodo(opts: OrchestratorOpts, report: AuditReport | null): OrchestratorPhaseResult {
  if (opts.dryRun) return { name: 'emit-todo', status: 'skipped', detail: 'dry-run' };
  if (!report) return { name: 'emit-todo', status: 'skipped', detail: 'no report' };

  const sourcesWithIssues = report.per_source.filter(s => s.total > 0);
  if (sourcesWithIssues.length === 0) {
    return { name: 'emit-todo', status: 'complete', detail: 'no issues; nothing to queue' };
  }

  try {
    mkdirSync(migrationsDir(), { recursive: true });
    const already = existingEntriesForVersion('0.22.4');
    let added = 0;
    for (const src of sourcesWithIssues) {
      if (already.has(src.source_id)) continue;
      const entry: PendingHostWorkEntry = {
        migration: '0.22.4',
        ts: new Date().toISOString(),
        skill: 'skills/migrations/v0.22.4.md',
        reason: `${src.total} frontmatter issue(s) in source ${src.source_id}`,
        source_id: src.source_id,
        source_path: src.source_path,
        command: `gbrain frontmatter validate ${src.source_path} --fix`,
      };
      appendFileSync(pendingHostWorkPath(), JSON.stringify(entry) + '\n');
      added++;
    }
    return {
      name: 'emit-todo',
      status: 'complete',
      detail: `appended ${added} entr${added === 1 ? 'y' : 'ies'} to ${pendingHostWorkPath()}`,
    };
  } catch (e) {
    return { name: 'emit-todo', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Orchestrator ────────────────────────────────────────────

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  console.log('');
  console.log('=== v0.22.4 — frontmatter-guard adoption ===');
  if (opts.dryRun) console.log('  (dry-run; no side effects)');
  console.log('');

  const phases: OrchestratorPhaseResult[] = [];

  phases.push(phaseASchema(opts));

  const { phase: bPhase, report } = await phaseBAudit(opts);
  phases.push(bPhase);
  if (bPhase.status === 'failed') {
    return { version: '0.22.4', status: 'partial', phases };
  }

  phases.push(phaseCEmitTodo(opts, report));

  const overallStatus: 'complete' | 'partial' | 'failed' =
    phases.some(p => p.status === 'failed') ? 'partial' : 'complete';

  return {
    version: '0.22.4',
    status: overallStatus,
    phases,
    pending_host_work: report?.per_source.filter(s => s.total > 0).length ?? 0,
  };
}

export const v0_22_4: Migration = {
  version: '0.22.4',
  featurePitch: {
    headline: 'Frontmatter-guard ships — broken brain pages can\'t hide',
    description:
      'gbrain v0.22.4 adds end-to-end frontmatter validation: a `gbrain frontmatter` CLI ' +
      '(validate / audit / install-hook), a `frontmatter_integrity` doctor subcheck, a ' +
      'pre-commit hook helper, and a new frontmatter-guard skill. The migration is audit-only ' +
      '(it never mutates your brain) — it scans every registered source, writes a per-source ' +
      'report to ~/.gbrain/migrations/v0.22.4-audit.json, and queues a TODO with the exact fix ' +
      'command. Run `gbrain frontmatter validate <source-path> --fix` to repair (creates .bak ' +
      'backups). Resolves all 7 check-resolvable warnings on master; ships frontmatter-guard.',
  },
  orchestrator,
};

/** Exported for unit tests. */
export const __testing = {
  phaseASchema,
  phaseBAudit,
  phaseCEmitTodo,
  auditReportPath,
  pendingHostWorkPath,
};
