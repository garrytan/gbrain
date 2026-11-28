/**
 * setup-history.ts: gbrain setup's side of the history import it offers on a new personal install (onboarding roadmap
 * PR 1). Setup is engine-free, so every brain read and write here is a 'gbrain transcripts archive setup-import' child
 * (src/commands/transcripts-archive-setup-import.ts; core in src/core/onboard/setup-history.ts) under one 20 s work budget;
 * time spent waiting for a person's answer does not count against it. Each child runs with --brain host, the brain setup
 * itself reads and creates, so a mounted project's routing never sends the receipt or the sessions elsewhere.
 *
 * Flags: --history none|decline|latest|<1-30>, --history-dir DIR, --history-decision ID, --no-extract. With none of
 * them, a run that created the brain offers the newest session first: at a terminal Q1 [Y/n] (Enter is yes; end of
 * input or 60 s of silence is no), then the rest of the last 30 days with Q2 [y/N], which only an explicit y
 * authorizes. With --notes the newest-session question is skipped and only the range is offered. Off a terminal, and
 * with --json, the offer is a setup_history decision whose accept command is 'gbrain setup <h> --history-decision <id>'.
 */
import { shellQuote, type Decision, type Notice } from '../core/agent-output.ts';
import { isInteractive, readLine, type LineRead } from '../core/interaction.ts';
import { bunSpawnSync } from '../core/spawn.ts';

export type HistoryChoice = 'none' | 'decline' | 'latest' | number;
export interface HistoryFlags { history?: HistoryChoice; historyDir?: string; historyDecision?: string; noExtract?: boolean }
export const HISTORY_VALUE_FLAGS = ['--history', '--history-dir', '--history-decision'];
export const HISTORY_BUDGET_MS = 20_000;
const CHILD_GRACE_MS = 10_000;
const ANSWER_MS = 60_000;
const LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', openclaw: 'OpenClaw' };

export type HistoryStatus = 'imported' | 'partial' | 'accepted' | 'nothing_found' | 'consumed' | 'offered' | 'declined' | 'skipped' | 'not_offered' | 'deferred' | 'failed';
export interface HistoryStageSummary { stage: 'latest' | 'range'; status: string; sessions_imported: number; days_written: number; from: string; to: string; links: unknown; held: unknown[]; receipts: string[]; resume?: unknown }
export interface HistoryOutcome {
  version: 1; status: HistoryStatus; reason?: string; stages: HistoryStageSummary[]; sessions_found: number | null; sessions_imported: number; no_history: boolean;
  decision: { id: string; stage: 'latest' | 'range'; sessions: number; expires_at: string; accept_argv: string[]; decline_argv: string[] } | null;
  card: unknown; error?: { code: string; message: string }; exit: 0 | 1 | 10; lines: string[];
}

/** Parses the history flags; a string is the exit-2 refusal, returned before anything is written. */
export function parseHistoryFlags(args: string[], value: (flag: string) => string | undefined, harness: string | undefined, stdioMember?: string): HistoryFlags | string {
  const raw = value('--history');
  const dir = value('--history-dir');
  const decision = value('--history-decision');
  const noExtract = args.includes('--no-extract');
  if (raw === undefined && dir === undefined && decision === undefined && !noExtract) return {};
  let history: HistoryChoice | undefined;
  if (raw === 'none' || raw === 'decline' || raw === 'latest') history = raw;
  else if (raw !== undefined && /^[0-9]{1,2}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 30) history = Number(raw);
  else if (raw !== undefined) return "unknown --history '" + raw + "'; pass none, decline, latest or a number of days from 1 to 30; nothing was written";
  if (decision !== undefined && raw !== undefined) return '--history-decision answers the offer an earlier setup run made; pass it without --history; nothing was written';
  if (decision !== undefined && !/^[A-Za-z0-9-]{6,64}$/.test(decision)) return "invalid --history-decision '" + decision + "'; pass the id setup printed; nothing was written";
  if ((history === 'none' || history === 'decline') && (dir !== undefined || noExtract)) return '--history ' + history + ' imports nothing, so --history-dir and --no-extract do not apply; nothing was written';
  if (dir !== undefined && !dir.startsWith('/')) return '--history-dir needs an absolute path; nothing was written';
  const blocker = harness !== 'claude-code' && harness !== 'codex' ? 'gbrain setup ' + (harness ?? '') + ' (only claude-code and codex)'
    : args.includes('--remove') ? '--remove' : args.includes('--instructions-only') ? '--instructions-only' : value('--serves') === 'several' || args.includes('--members') || args.includes('--members-file') ? '--serves several or --members'
    : stdioMember !== undefined ? '--stdio-member' : args.includes('--team') ? '--team' : null;
  if (blocker) return 'the history import runs in gbrain setup claude-code or codex for a personal brain one person uses, so ' + blocker + ' does not take the history flags; nothing was written';
  return { ...(history !== undefined ? { history } : {}), ...(dir !== undefined ? { historyDir: dir } : {}), ...(decision !== undefined ? { historyDecision: decision } : {}), ...(noExtract ? { noExtract } : {}) };
}

/** What a terminal answer means: Q1 defaults to yes on Enter; Q2 needs an explicit y. End of input and silence never say yes. */
export function historyAnswer(read: LineRead, defaultYes: boolean): 'yes' | 'no' | 'unanswered' {
  if (read.kind !== 'line') return 'unanswered';
  const t = read.text.trim().toLowerCase();
  if (t === 'y' || t === 'yes' || (t === '' && defaultYes)) return 'yes';
  if (t === 'n' || t === 'no') return 'no';
  return 'unanswered';
}

type Child = { ok: true; doc: Record<string, any> } | { ok: false; code: string; message: string };

function child(launcher: string, sub: string, args: string[], deadline: number): Child {
  const argv = [launcher, '--brain', 'host', 'transcripts', 'archive', 'setup-import', sub, ...args, '--deadline-ms', String(deadline), '--json'];
  const run = bunSpawnSync(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env, timeout: Math.max(0, deadline - Date.now()) + CHILD_GRACE_MS });
  const text = run.stdout?.toString() ?? '';
  let doc: Record<string, any> | null = null;
  try { doc = JSON.parse(text); } catch { doc = null; }
  if (run.exitCode === 0 || run.exitCode === 10) return doc ? { ok: true, doc } : { ok: false, code: 'setup_history_failed', message: 'setup-import ' + sub + ' printed no JSON' };
  if (run.exitCode === null) return { ok: false, code: 'setup_history_failed', message: 'setup-import ' + sub + ' passed its time budget and was stopped' };
  return { ok: false, code: String(doc?.code ?? doc?.error ?? 'setup_history_failed'), message: String(doc?.message ?? (run.stderr?.toString() ?? '').trim().split('\n').at(-1) ?? 'setup-import ' + sub + ' failed') };
}

/** Writes the install receipt right after setup's own gbrain init; a pinned, team or member-bound setup is recorded as not eligible. */
export function recordHistoryReceipt(launcher: string, harness: string, flags: { source?: string; team?: boolean; stdioMember?: string; serves?: string }): Child {
  const blocker = flags.source || process.env.GBRAIN_SOURCE ? 'pinned_source' : flags.team ? 'team_brain' : flags.stdioMember || flags.serves === 'several' ? 'member_bound' : null;
  return child(launcher, 'receipt', ['--harness', harness, '--created-by-setup', ...(blocker ? ['--blocker', blocker] : [])], Date.now() + HISTORY_BUDGET_MS);
}

const summary = (d: Record<string, any>): HistoryStageSummary => ({ stage: d.stage, status: d.status, sessions_imported: d.sessions_imported, days_written: d.days_written, from: d.from, to: d.to, links: d.links, held: d.held ?? [], receipts: d.receipts ?? [], ...(d.resume ? { resume: d.resume } : {}) });

function previewLine(p: Record<string, any>): string {
  const harnesses = (p.harnesses as Array<{ harness: string; sessions: number }>).filter(h => h.sessions).map(h => LABEL[h.harness] ?? h.harness).join(' and ');
  const newest = p.latest ? ' The newest is from ' + (LABEL[p.latest.harness] ?? p.latest.harness) + (p.latest.project ? ', project ' + p.latest.project : '') + ', ' + p.latest.day + '.' : '';
  return 'Setup found ' + p.found.sessions + ' session' + (p.found.sessions === 1 ? '' : 's') + ' from ' + harnesses + ' since ' + p.from + '.' + newest
    + ' Importing copies a redacted transcript into ' + p.destination + '; no model sees it.';
}

/**
 * The history step of one setup run, after the brain's layout. Returns null when there is nothing to say (an existing
 * brain and no history flag, or a dry run).
 */
export async function historyFor(ctx: { harness: string; launcher: string; flags: HistoryFlags & { notes?: string | null; dryRun?: boolean }; brainCreate: boolean; json: boolean; liveServe: boolean; setupArgv: string[]; choices?: string[]; read?: typeof readLine; interactive?: boolean; budgetMs?: number }): Promise<HistoryOutcome | null> {
  const { flags, harness } = ctx;
  const choices = ctx.choices ?? [];
  const explicit = flags.history !== undefined || flags.historyDecision !== undefined;
  if (flags.dryRun || (!explicit && !ctx.brainCreate)) return null;
  const o: HistoryOutcome = { version: 1, status: 'skipped', stages: [], sessions_found: null, sessions_imported: 0, no_history: false, decision: null, card: null, exit: 0, lines: [] };
  if (flags.history === 'none') return { ...o, reason: 'history_none', lines: ['History import: skipped (--history none).'] };
  if (ctx.liveServe) {
    const resume = [...ctx.setupArgv, ...(flags.historyDecision ? ['--history-decision', flags.historyDecision] : ['--history', String(flags.history ?? 'latest')]),
      ...(flags.historyDir ? ['--history-dir', flags.historyDir] : []), ...(flags.noExtract ? ['--no-extract'] : []), ...choices];
    return { ...o, status: 'deferred', reason: 'live_serve', lines: ['History import: deferred, because a running gbrain server holds this brain. Once it stops, run ' + shellQuote(resume)] };
  }
  let deadline = Date.now() + (ctx.budgetMs ?? HISTORY_BUDGET_MS);
  const interactive = ctx.interactive ?? (!ctx.json && isInteractive());
  const dirArgs = flags.historyDir ? ['--dir', flags.historyDir] : [];
  const fail = (c: { code: string; message: string }): HistoryOutcome => ({ ...o, status: 'failed', error: { code: c.code, message: c.message }, exit: explicit ? 1 : 0, lines: [...o.lines, 'History import failed (' + c.code + '): ' + c.message] });
  if (flags.history === 'decline') {
    for (const stage of ['latest', 'range']) { const r = child(ctx.launcher, 'decline', ['--stage', stage], deadline); if (!r.ok) return fail(r); }
    return { ...o, status: 'declined', lines: ['History import: declined; setup will not offer it again.'] };
  }
  const run = (args: string[]): Child => {
    const r = child(ctx.launcher, 'run', [...args, ...dirArgs, '--harness', harness, ...(flags.noExtract ? ['--no-extract'] : [])], deadline);
    if (!r.ok) return r;
    if (r.doc.resume) r.doc.resume.argv = [...ctx.setupArgv, ...r.doc.resume.argv.slice(3), ...choices];
    o.stages.push(summary(r.doc));
    o.sessions_imported += r.doc.sessions_imported ?? 0;
    o.status = r.doc.status;
    if (r.doc.exit === 10) o.exit = 10;
    if (r.doc.status === 'partial' && r.doc.resume) o.lines.push('History import stopped at its time budget; the rest waits: ' + shellQuote(r.doc.resume.argv));
    if (r.doc.status === 'accepted') o.lines.push('History import accepted; the brain publishes it shortly (receipts: ' + r.doc.receipts.join(', ') + ').');
    return r;
  };
  const offer = (stage: 'latest' | 'range'): Child => child(ctx.launcher, 'preview', ['--stage', stage, '--offer', ...dirArgs], deadline);
  const decide = (p: Record<string, any>) => {
    const d = p.decision;
    o.decision = { id: d.id, stage: d.stage, sessions: p.sessions, expires_at: d.expires_at, accept_argv: [...ctx.setupArgv, '--history-decision', d.id, ...(flags.historyDir ? ['--history-dir', flags.historyDir] : []), ...(flags.noExtract ? ['--no-extract'] : []), ...choices], decline_argv: [...ctx.setupArgv, '--history', 'decline', ...choices] };
    o.lines.push((d.stage === 'latest' ? 'To import the newest session' : 'To import ' + p.sessions + ' session(s) since ' + p.from) + ': ' + shellQuote(o.decision.accept_argv));
  };
  const ask = async (p: Record<string, any>, stage: 'latest' | 'range'): Promise<'yes' | 'no' | 'unanswered'> => {
    const prompt = stage === 'latest' ? 'Import that newest session now? [Y/n] ' : 'Import ' + (o.stages.length ? 'the rest of ' : '') + 'the ' + p.sessions + ' session(s) since ' + p.from + ' too? [y/N] ';
    const asked = Date.now();
    const answer = historyAnswer(await (ctx.read ?? readLine)({ prompt, timeoutMs: ANSWER_MS }), stage === 'latest');
    deadline += Date.now() - asked;
    if (answer === 'no') { const r = child(ctx.launcher, 'decline', ['--stage', stage], deadline); if (!r.ok) return 'unanswered'; }
    return answer;
  };

  if (flags.historyDecision) { const r = run(['--decision', flags.historyDecision]); if (!r.ok) return fail(r); }
  else if (flags.history === 'latest') { const r = run(['--stage', 'latest']); if (!r.ok) return fail(r); }
  else if (typeof flags.history === 'number') { const r = run(['--stage', 'range', '--days', String(flags.history)]); if (!r.ok) return fail(r); }
  else {
    const first: 'latest' | 'range' = typeof flags.notes === 'string' ? 'range' : 'latest';
    const p = offer(first);
    if (!p.ok) return p.code === 'setup_history_ineligible' ? { ...o, status: 'not_offered', reason: p.message } : fail(p);
    o.sessions_found = p.doc.found.sessions;
    if (p.doc.answered?.includes(first)) return { ...o, status: 'not_offered', reason: 'answered' };
    if (!p.doc.found.sessions) o.status = 'nothing_found';
    else if (!interactive) { o.status = 'offered'; decide(p.doc); }
    else {
      process.stdout.write(previewLine(p.doc) + '\n');
      const answer = await ask(p.doc, first);
      if (answer === 'yes') { const r = run(['--decision', p.doc.decision.id]); if (!r.ok) return fail(r); }
      else { o.status = answer === 'no' ? 'declined' : 'offered'; if (answer === 'unanswered') decide(p.doc); }
    }
  }
  const latestDone = o.stages.length === 1 && o.stages[0]!.stage === 'latest' && o.stages[0]!.status !== 'partial';
  if (latestDone) {
    const p = offer('range');
    if (p.ok && p.doc.sessions > 1 && !p.doc.answered?.includes('range')) {
      if (interactive) {
        const answer = await ask(p.doc, 'range');
        if (answer === 'yes') { const r = run(['--decision', p.doc.decision.id]); if (!r.ok) return fail(r); }
        else if (answer === 'unanswered') decide(p.doc);
      } else decide(p.doc);
    }
  }
  if (o.sessions_imported > 0 || o.status === 'nothing_found') {
    const card = child(ctx.launcher, 'card', ['--harness', harness], deadline);
    if (card.ok) { o.card = card.doc; o.no_history = card.doc.no_history === true; o.lines.unshift(...(card.doc.lines as string[] ?? [])); }
  }
  return o;
}

/** Adds the offer to the first-run decisions bundle, after brain_shape; nothing is imported until the user answers. */
export function withHistoryDecision(notices: Notice[], o: HistoryOutcome | null): Notice[] {
  if (!o?.decision) return notices;
  const d = o.decision;
  const decision: Decision = {
    id: 'setup_history',
    question: (d.stage === 'latest' ? 'Import the newest coding-agent session found on this machine' : 'Import the ' + d.sessions + ' coding-agent sessions from the last 30 days')
      + ' into this brain, so a new session can recall it? Setup copies a redacted transcript into the private conversations source on this machine; no model sees it.',
    options: [{ id: 'import', label: 'Import it', argv: d.accept_argv }, { id: 'decline', label: 'Do not import (setup will not ask again)', argv: d.decline_argv }, { id: 'later', label: 'Not now' }],
    default: 'later', default_reason: 'Nothing is imported until the user says yes.',
  };
  const line = ' Your recent coding sessions can be imported so the brain remembers them; want that?';
  const i = notices.findIndex(n => n.code === 'first_run_decisions');
  if (i < 0) return [...notices, { code: 'first_run_decisions', kind: 'ask', why: 'Setup is complete and memory works now. One optional choice remains; nothing is written until the user answers.', user_message: 'gbrain is set up, so memory works now.' + line, decisions: [decision] }];
  const next = [...notices];
  next[i] = { ...next[i]!, user_message: (next[i]!.user_message ?? '') + line, decisions: [...(next[i]!.decisions ?? []), decision] };
  return next;
}
