/**
 * gbrain transcripts archive setup-import: the brain side of the history import gbrain setup offers on a new personal
 * install (core: src/core/onboard/setup-history.ts). Setup is engine-free and runs these as children; a person can run
 * them too. Trusted local CLI only; no MCP operation.
 *
 *   receipt --harness H [--created-by-setup] [--blocker R]   write the install receipt once (setup, right after init)
 *   preview --stage latest|range [--days N] [--dir D] [--offer]  what would be imported; --offer stores it as the pending decision
 *   run (--decision ID | --stage latest|range [--days N]) [--dir D] [--no-extract]  import one stage (exit 10: accepted, not yet published)
 *   decline --stage latest|range                             record a no, so setup never asks that stage again
 *   card --harness H                                         what the brain now holds, and three questions from it
 *
 * Every subcommand takes --deadline-ms <epoch ms> (default now + 20 s) and --json.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { CliDispatchContext } from '../cli/command-table.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';

export const SETUP_IMPORT_HELP = 'Usage:\n'
  + '  gbrain transcripts archive setup-import receipt --harness H [--created-by-setup] [--blocker REASON] [--json]\n'
  + '  gbrain transcripts archive setup-import preview --stage latest|range [--days N] [--dir DIR] [--offer] [--json]\n'
  + '  gbrain transcripts archive setup-import run (--decision ID | --stage latest|range [--days N]) [--dir DIR] [--no-extract] --harness H [--json]\n'
  + '  gbrain transcripts archive setup-import decline --stage latest|range [--json]\n'
  + '  gbrain transcripts archive setup-import card --harness H [--json]\n\n'
  + 'The history import gbrain setup offers on a new personal install: preview first, then the newest session, then up to\n'
  + '30 days on a second yes. It writes only into the private archive source, calls no model provider and never changes\n'
  + 'the archive switch. --dir reads <dir>/claude-code, <dir>/codex and <dir>/openclaw instead of the harness folders.\n'
  + 'Guide: docs/guides/conversation-archive.md#setup-history-import';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function runSetupImport(engine: BrainEngine, args: string[], dispatch: Pick<CliDispatchContext, 'makeContext'> = {}): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  const json = rest.includes('--json');
  const history = await import('../core/onboard/setup-history.ts');
  const { exitCliError, usageError } = await import('../cli/cli-error.ts');
  const usage = (message: string) => exitCliError(usageError(message, 'Pass the flags its usage line names, for example gbrain transcripts archive setup-import preview --stage latest --json.'), 'transcripts', { json });
  const out = (doc: unknown, human: () => void) => { if (json) console.log(JSON.stringify(doc, null, 2)); else human(); };
  if (!sub || sub === '--help' || rest.includes('--help')) { console.log(SETUP_IMPORT_HELP); return; }
  const deadlineRaw = flag(rest, '--deadline-ms');
  const deadlineAtMs = deadlineRaw === undefined ? Date.now() + history.SETUP_HISTORY_BUDGET_MS : Number(deadlineRaw);
  if (!Number.isFinite(deadlineAtMs)) return usage('--deadline-ms needs epoch milliseconds.');
  const stageRaw = flag(rest, '--stage');
  if (stageRaw !== undefined && stageRaw !== 'latest' && stageRaw !== 'range') return usage('--stage is latest or range.');
  const stage = stageRaw as 'latest' | 'range' | undefined;
  const daysRaw = flag(rest, '--days');
  const days = daysRaw === undefined ? undefined : Number(daysRaw);
  if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > history.HISTORY_MAX_DAYS)) return usage('--days is a whole number from 1 to ' + history.HISTORY_MAX_DAYS + '.');
  const dir = flag(rest, '--dir');
  const harness = flag(rest, '--harness') ?? 'claude-code';

  if (sub === 'receipt') {
    const blocker = flag(rest, '--blocker') as Parameters<typeof history.recordInstallReceipt>[1]['setupReason'];
    const r = await history.recordInstallReceipt(engine, { harness, createdBySetup: rest.includes('--created-by-setup'), ...(blocker ? { setupReason: blocker } : {}) });
    out({ ...r.receipt, created: r.created }, () => console.log('install receipt ' + (r.created ? 'written' : 'kept') + ': ' + (r.receipt.eligible ? 'history import offered' : 'no history import (' + r.receipt.reason + ')')));
    return;
  }
  if (sub === 'preview') {
    if (!stage) return usage('preview needs --stage latest or range.');
    const preview = await history.previewHistory(engine, { stage, days, dir, env: process.env, deadlineAtMs });
    const decision = rest.includes('--offer') && preview.files.length ? await history.offerHistoryDecision(engine, preview) : null;
    const { files: _files, ...shown } = preview;
    out({ ...shown, ...(decision ? { decision: { id: decision.id, stage: decision.stage, expires_at: decision.expires_at } } : {}) }, () => {
      console.log(preview.sessions + ' session(s) from ' + preview.from + ' to ' + preview.to + ' would go to ' + preview.destination);
      for (const h of preview.harnesses) console.log('  ' + h.harness.padEnd(12) + ' ' + h.sessions + ' session(s), ' + h.bytes + ' bytes in ' + h.root + (h.oversized ? ' (' + h.oversized + ' oversized, skipped)' : ''));
      if (decision) console.log('decision ' + decision.id + ' (expires ' + decision.expires_at + ')');
    });
    return;
  }
  if (sub === 'run') {
    const decisionId = flag(rest, '--decision');
    if (!decisionId && !stage) return usage('run needs --decision ID or --stage latest|range.');
    if (decisionId && stage) return usage('pass --decision or --stage, not both.');
    const makeContext = dispatch.makeContext;
    const result = await history.runSetupHistory(engine, {
      harness, deadlineAtMs, noExtract: rest.includes('--no-extract'), dir, env: process.env, ...(decisionId ? { decisionId } : { stage, days }),
      ...(makeContext ? { makeContext: (source: string) => makeContext(engine, { source }) } : {}),
    });
    out(result, () => console.log('history import ' + result.stage + ': ' + result.status + ', ' + result.sessions_imported + ' session(s), ' + result.days_written + ' day page(s) written'));
    if (result.exit) setCliExitVerdict(result.exit);
    return;
  }
  if (sub === 'decline') {
    if (!stage) return usage('decline needs --stage latest or range.');
    const receipt = await history.declineHistory(engine, stage);
    out({ declined: stage, at: receipt.declined?.[stage] }, () => console.log('history import ' + stage + ': declined; setup will not ask again'));
    return;
  }
  if (sub === 'card') {
    const card = await history.historyCard(engine, { harness });
    const lines = history.renderHistoryCard(card, harness);
    out({ ...card, lines }, () => { for (const line of lines) console.log(line); });
    return;
  }
  return usage('unknown setup-import subcommand ' + sub + '.');
}
