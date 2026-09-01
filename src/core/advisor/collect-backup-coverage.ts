/**
 * advisor/collect-backup-coverage.ts — surfaces the monthly backup-coverage
 * verdict ("which knowledge repos have no git remote?") as advisor findings.
 *
 * Local runs (trusted CLI owner) refresh the verdict through the shared
 * choke point getBackupStatus (stale-only recompute keeps the collector
 * cron-safe; a fresh cache makes this a file read) and emit per-asset
 * findings with fix commands, gated as ONE batch through backupNagGate so
 * the advisor participates in the same bounded-nag budget as every other
 * channel. Remote runs are cache-readers with aggregate counts ONLY
 * (amendment-29 discipline — never a local path or source id) and never
 * write nag state.
 */

import { getBackupStatus } from '../backup/coverage.ts';
import { backupCheckDisabled, backupNagGate, loadBackupStatus } from '../backup/status-file.ts';
import type { AdvisorCollector, AdvisorFinding } from './types.ts';

export const collectBackupCoverage: AdvisorCollector = {
  id: 'backup-coverage',
  collect: async (ctx) => {
    // The off switch silences compute AND every render channel (the ops-doc
    // contract) — including this collector, on both the local compute branch
    // and the remote cache-read branch.
    if (backupCheckDisabled()) return [];
    const findings: AdvisorFinding[] = [];
    const local = !ctx.remote;

    if (!local) {
      // Remote: cache-only read, aggregate wording, no nag writes (D4 — no
      // git subprocesses on a remote surface, ever).
      const s = loadBackupStatus();
      if (!s || s.overall !== 'warn') return [];
      findings.push({
        id: 'backup_coverage_aggregate',
        severity: 'warn',
        title: `${s.totals.no_remote} of ${s.totals.assets} knowledge assets have no git remote (local-only) — run \`gbrain backup status\` on the brain host for fix commands.`,
        fix: { command_argv: null },
        collector: 'backup-coverage',
        ask_user: true,
      });
      return findings;
    }

    const s = await getBackupStatus(ctx.engine, {
      localGitProbes: true,
      computedBy: 'advisor',
      now: ctx.now,
    });
    if (s.overall !== 'warn') return [];

    // One gate for the whole batch (the verdict fingerprint covers the set);
    // recording at collect time matches the collect-mcp-client-fit precedent.
    const gate = backupNagGate('advisor', s, ctx.now.getTime());
    if (!gate.show) return [];

    for (const a of s.assets) {
      if (a.state === 'no_remote' && a.kind === 'source_repo') {
        findings.push({
          id: `backup_source_no_remote:${a.id}`,
          severity: 'warn',
          title: `Knowledge repo ${a.id} has no git remote — a disk loss loses it.`,
          detail: a.detail,
          fix: { command_argv: a.fix_argv ?? null },
          collector: 'backup-coverage',
          ask_user: true,
        });
      } else if (a.state === 'no_remote' && a.kind === 'bootstrap_workspace') {
        findings.push({
          id: 'backup_workspace_no_repo',
          severity: 'warn',
          title: 'Your agent workspace has no private repo yet — a disk loss loses skills, memory, and identity.',
          detail: a.detail,
          // No default fallback here (matches source_repo above): coverage.ts
          // deliberately leaves fix_argv null for this kind since it can't
          // tell an empty origin (bootstrap repo) from an already-pushed
          // out-of-band one (bootstrap attach) without a git subprocess — a
          // hardcoded ['gbrain','bootstrap','repo'] fallback would reintroduce
          // the same wrong-command-in-the-out-of-band-case bug this exists to fix.
          fix: { command_argv: a.fix_argv ?? null },
          collector: 'backup-coverage',
          ask_user: true,
        });
      } else if (a.state === 'no_remote' && a.kind === 'db_content') {
        findings.push({
          id: 'backup_db_content_unbacked',
          severity: 'warn',
          title: 'Your brain lives only in the local database — nothing is git-backed.',
          detail: a.detail,
          fix: { command_argv: a.fix_argv ?? ['gbrain', 'bootstrap', 'repo'] },
          collector: 'backup-coverage',
          ask_user: true,
        });
      }
    }
    const unpushed = s.assets.filter((a) => a.state === 'unpushed');
    if (unpushed.length > 0) {
      findings.push({
        id: 'backup_unpushed_work',
        severity: 'info',
        title: `${unpushed.length} repo(s) have commits not yet on their remote.`,
        detail: unpushed.map((a) => `${a.id}: ${a.detail ?? 'ahead of origin'}`).join('; '),
        fix: { command_argv: null },
        collector: 'backup-coverage',
        ask_user: true,
      });
    }
    if (s.assets.some((a) => a.kind === 'db_only')) {
      findings.push({
        id: 'backup_db_only_caveat',
        severity: 'info',
        title: 'db_only pages are not covered by any git remote — dump them with gbrain export.',
        detail: 'run gbrain doctor (undeclared_db_only_pages) for the page-level audit',
        fix: { command_argv: null },
        collector: 'backup-coverage',
        ask_user: true,
      });
    }

    if (findings.length > 0) gate.record();
    return findings;
  },
};
