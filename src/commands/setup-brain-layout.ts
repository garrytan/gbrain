/**
 * GBRA-529 (GST-2731), PR 1: `gbrain setup <harness> --shape personal [--notes <dir>]`.
 *
 * The personal branch of the branching install. After setup has wired the
 * harness, it gives the brain a shape:
 *
 *   - three starter pages, written create-only through `gbrain put` (the one
 *     writer door: on a brain with a working tree the file is written and
 *     queued for commit before the database sees it; on a repo-less brain the
 *     database is the record). Each is an empty form marked `status: stub`;
 *     nothing about the person is invented;
 *   - a one-shot import of a notes folder the person picked (`gbrain import
 *     <dir> --no-embed`), read only, never written. Over IMPORT_INLINE_MAX
 *     markdown files setup hands the agent the import command instead;
 *   - a managed layout block beside the brain-first block, telling the agent
 *     to read those pages and to quote facts about the person only from
 *     me/facts. `--shape none` removes the block and keeps the pages;
 *   - a keyless check that search finds an imported note, and one question
 *     to ask in a new session.
 *
 * Setup stays engine-free: every brain read and write is a child of the
 * absolute launcher. Nothing here reads stdin unless isInteractive() is true
 * (two TTYs, no agent marker, not CI); an agent-driven run gets the
 * `brain_shape` decision in the first-run bundle instead, and no starter
 * page is written until it is answered.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Decision, Notice } from '../core/agent-output.ts';
import { probeBlock, removeBlock, spliceBlock, type BlockMarkers } from '../core/managed-block.ts';
import { writeUnlessChanged } from '../core/setup/brain-first.ts';
import { bunSpawnSync } from '../core/spawn.ts';
import { readLine } from '../core/interaction.ts';

export type BrainShape = 'personal' | 'none';

export interface LayoutFlags {
  brain?: BrainShape;
  /** An absolute notes folder; null for an explicit `--notes none`. */
  notes?: string | null;
  dryRun: boolean;
}

export const IMPORT_INLINE_MAX = 500;
export const LAYOUT_VERSION = 1;
export const LAYOUT_BEGIN = '<!-- gbrain:brain-layout:begin -->';
export const LAYOUT_END = '<!-- gbrain:brain-layout:end -->';

const markers = (harness: string): BlockMarkers => ({ begin: LAYOUT_BEGIN, end: LAYOUT_END, label: 'brain-layout', rerun: `gbrain setup ${harness} --shape personal` });

export interface StarterPage { slug: string; title: string; body: string }

/** The personal starter pages: empty forms with one marked example line each. */
export const PERSONAL_PAGES: readonly StarterPage[] = [
  {
    slug: 'me/facts',
    title: 'Facts about me',
    body: 'True things about me that agents may say. One dated line per fact, with where it came from. '
      + 'Never overwrite a line: when something changes, add a new dated line.\n\n'
      + '- Example (delete me): 2026-01-01: I live in example-city. Source: I said so.',
  },
  {
    slug: 'me/voice',
    title: 'My voice',
    body: 'How I write, so drafts sound like me.\n\n'
      + '## Words I never use\n\n- Example (delete me): "synergy"\n\n'
      + '## Writing I like (links)\n\n- Example (delete me): https://example.com/a-post-i-like\n\n'
      + '## Writing I dislike (links)\n\n- Example (delete me): https://example.com/a-post-i-dislike',
  },
  {
    slug: 'me/how-i-decide',
    title: 'How I decide',
    body: 'The rules of thumb I use, so agents can apply them. One line each, dated.\n\n'
      + '- Example (delete me): 2026-01-01: I say no to a meeting without an agenda.',
  },
];

export function renderStarterPage(p: StarterPage): string {
  return `---\ntitle: ${p.title}\nstatus: stub\n---\n# ${p.title}\n\n${p.body}\n\n`
    + '_This page is an empty form (status: stub). It holds no facts until you add your own lines; then remove the stub line from the frontmatter._\n';
}

export function renderLayoutBlock(harness: string): string {
  return [
    `<!-- gbrain brain-layout v${LAYOUT_VERSION}: managed by gbrain setup and replaced on upgrade; edit outside these markers. Remove: gbrain setup ${harness} --shape none -->`,
    '## My brain layout (gbrain)',
    '- Before a task that needs my context, read the gbrain pages me/facts, me/voice and me/how-i-decide.',
    '- State facts about me only from me/facts, and say they came from there.',
    '- Never overwrite a page: add a new dated line. Save facts I tell you with remember, naming where they came from.',
    '- A page whose frontmatter says status: stub is an empty form: it holds no facts yet.',
  ].join('\n');
}

/** Markdown files under `dir` (dot folders skipped), counted up to `cap` + 1, with the first one found. */
export function countNotes(dir: string, cap = IMPORT_INLINE_MAX): { count: number; first: string | null } {
  let count = 0;
  let first: string | null = null;
  const walk = (d: string): void => {
    let names: string[];
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const name of names) {
      if (count > cap) return;
      if (name.startsWith('.')) continue;
      const p = join(d, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (/\.(md|markdown)$/i.test(name)) { count++; first ??= p; }
    }
  };
  walk(dir);
  return { count, first };
}

/** The title search should find for a note: its first heading, else its file name. */
export function noteTitle(path: string): string {
  try {
    const text = readFileSync(path, 'utf8');
    const fm = /^---\n[\s\S]*?\ntitle:\s*["']?([^"'\n]+)["']?\s*\n[\s\S]*?---/.exec(text)?.[1]?.trim();
    if (fm) return fm;
    const h = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
    if (h) return h;
  } catch { /* fall through */ }
  return basename(path).replace(/\.(md|markdown)$/i, '');
}

/** Notes folders a person commonly has, for the agent to offer; never imported unless picked. */
export function candidateNoteFolders(home: string = homedir()): string[] {
  const fixed = ['notes', 'Notes', 'Documents/notes', 'Documents/Notes', 'Obsidian', 'Documents/Obsidian'].map(p => join(home, p));
  const vaults: string[] = [];
  for (const base of [home, join(home, 'Documents'), join(home, 'Library/Mobile Documents/iCloud~md~obsidian/Documents')]) {
    let names: string[] = [];
    try { names = readdirSync(base); } catch { continue; }
    for (const n of names) if (!n.startsWith('.') && existsSync(join(base, n, '.obsidian'))) vaults.push(join(base, n));
  }
  return [...new Set([...vaults, ...fixed])].filter(p => { try { return statSync(p).isDirectory(); } catch { return false; } });
}

/** --shape / --notes validation; a string is the refusal (nothing written). */
export function parseLayoutFlags(value: (flag: string) => string | undefined, has: (flag: string) => boolean, harness: string | undefined): { brain?: BrainShape; notes?: string | null } | string {
  const brain = value('--shape');
  if (brain === 'company' || brain === 'both') {
    return `--shape ${brain} arrives in a later gbrain release; nothing was written. Today: gbrain setup ${harness ?? '<harness>'} --shape personal, and gbrain sources demo company-brain to see a company brain answer questions`;
  }
  if (brain !== undefined && brain !== 'personal' && brain !== 'none') return `unknown --shape '${brain}'; pass personal or none`;
  const raw = value('--notes');
  if (raw === undefined) return { ...(brain ? { brain } : {}) };
  if (brain !== 'personal') return '--notes names the notes folder of --shape personal';
  if (raw === 'none') return { brain, notes: null };
  const abs = raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
  if (!abs.startsWith('/')) return '--notes needs an absolute path (or ~/...)';
  try { if (!statSync(abs).isDirectory()) return `--notes ${raw} is not a folder`; } catch { return `--notes ${raw} does not exist`; }
  if (has('--remove')) return '--notes and --remove do not go together';
  return { brain, notes: resolve(abs) };
}

export interface LayoutOutcome {
  shape: BrainShape;
  pages: Array<{ slug: string; action: 'write' | 'keep' | 'failed'; detail?: string }>;
  notes: { dir: string; files: number; action: 'imported' | 'deferred' | 'failed'; argv: string[]; detail?: string } | null;
  block: { path: string; action: 'write' | 'keep' | 'remove' | 'skip' | 'preserve'; detail: string } | null;
  check: { ok: boolean; query: string | null; detail: string };
  next_question: string | null;
}

type Run = (argv: string[]) => { code: number; stdout: string; stderr: string };
const run: Run = (argv) => {
  const child = bunSpawnSync(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env });
  return { code: child.exitCode ?? 1, stdout: child.stdout?.toString() ?? '', stderr: child.stderr?.toString() ?? '' };
};

function syncLayoutBlock(path: string | null, harness: string, shape: BrainShape, dryRun: boolean): LayoutOutcome['block'] {
  if (!path) return null;
  const m = markers(harness);
  const exists = existsSync(path);
  const text = exists ? readFileSync(path, 'utf8') : '';
  const probe = probeBlock(m, text);
  if (probe.state === 'damaged') return { path, action: 'preserve', detail: `the brain-layout markers in ${path} were hand-edited; fix or delete them, then re-run` };
  if (shape === 'none') {
    if (probe.state === 'absent') return { path, action: 'skip', detail: `no brain-layout block in ${path}` };
    if (!dryRun) writeUnlessChanged(path, text, false, removeBlock(m, text).text);
    return { path, action: 'remove', detail: `brain-layout block removed from ${path}; the pages stay` };
  }
  const body = renderLayoutBlock(harness);
  if (probe.state === 'present' && probe.interior?.trim() === body.trim()) return { path, action: 'keep', detail: `brain-layout block in ${path} is current` };
  if (!dryRun) writeUnlessChanged(path, text, !exists, spliceBlock(m, text, body));
  return { path, action: 'write', detail: `brain-layout block ${probe.state === 'present' ? 'upgraded in' : 'appended to'} ${path}` };
}

/**
 * The personal layout for this run. `instructionsPath` is the file the brain-first block lives in (null when the
 * person declined instructions or the harness has none); the layout block goes there too.
 */
export function applyBrainLayout(opts: { harness: string; launcher: string; flags: LayoutFlags; instructionsPath: string | null; run?: Run }): LayoutOutcome | null {
  const { flags, launcher, harness } = opts;
  if (!flags.brain) return null;
  const exec = opts.run ?? run;
  const block = syncLayoutBlock(opts.instructionsPath, harness, flags.brain, flags.dryRun);
  const outcome: LayoutOutcome = { shape: flags.brain, pages: [], notes: null, block, check: { ok: true, query: null, detail: 'nothing to check' }, next_question: null };
  if (flags.brain === 'none') return outcome;

  for (const page of PERSONAL_PAGES) {
    if (flags.dryRun) { outcome.pages.push({ slug: page.slug, action: 'write', detail: 'would write if missing' }); continue; }
    const got = exec([launcher, 'get', page.slug, '--json']);
    if (got.code === 0) { outcome.pages.push({ slug: page.slug, action: 'keep' }); continue; }
    const put = bunSpawnSync([launcher, 'put', page.slug, '--json'], { stdin: new TextEncoder().encode(renderStarterPage(page)), stdout: 'pipe', stderr: 'pipe', env: process.env });
    outcome.pages.push(put.exitCode === 0 ? { slug: page.slug, action: 'write' }
      : { slug: page.slug, action: 'failed', detail: lastLine(put.stderr?.toString() ?? '') });
  }

  if (flags.notes) {
    const { count, first } = countNotes(flags.notes);
    const argv = ['gbrain', 'import', flags.notes, '--no-embed'];
    if (count > IMPORT_INLINE_MAX) {
      outcome.notes = { dir: flags.notes, files: count, action: 'deferred', argv, detail: `more than ${IMPORT_INLINE_MAX} markdown files; run the import as its own step` };
    } else if (flags.dryRun) {
      outcome.notes = { dir: flags.notes, files: count, action: 'imported', argv, detail: 'would import (read only)' };
    } else {
      const imp = exec([launcher, 'import', flags.notes, '--no-embed', '--json']);
      outcome.notes = imp.code === 0 ? { dir: flags.notes, files: count, action: 'imported', argv }
        : { dir: flags.notes, files: count, action: 'failed', argv, detail: lastLine(imp.stderr) };
    }
    if (outcome.notes.action === 'imported' && first && !flags.dryRun) {
      const title = noteTitle(first);
      const hits = exec([launcher, 'search', title, '--json']);
      let found = false;
      try { found = (JSON.parse(hits.stdout) as Array<{ title?: string }>).slice(0, 5).some(h => (h.title ?? '').trim().toLowerCase() === title.toLowerCase()); } catch { /* unreadable: not found */ }
      outcome.check = found
        ? { ok: true, query: title, detail: `keyless search found "${title}" from your notes` }
        : { ok: false, query: title, detail: `keyless search did not find "${title}" in its top 5; run gbrain search "${title}" to see what it returns` };
      if (found) outcome.next_question = `In a new session, ask: "what do my notes say about ${title}?"`;
    }
  }
  if (!outcome.next_question && !flags.dryRun) {
    const facts = exec([launcher, 'get', 'me/facts', '--json']);
    outcome.check = facts.code === 0 ? { ...outcome.check, ok: outcome.check.ok, detail: outcome.check.query ? outcome.check.detail : 'me/facts is readable' }
      : { ok: false, query: null, detail: 'me/facts could not be read back' };
    outcome.next_question = 'Add one dated line to me/facts, then in a new session ask: "what does my brain say about me?"';
  }
  return outcome;
}

function lastLine(text: string): string {
  return text.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 300) ?? 'no output';
}

/** Lines for the human report. */
export function describeLayout(o: LayoutOutcome, dryRun: boolean): string[] {
  const would = dryRun ? 'would ' : '';
  const lines = [`Brain layout: ${o.shape}`];
  if (o.block) lines.push(`  instructions  ${o.block.detail}`);
  for (const p of o.pages) lines.push(`  page     ${p.action.padEnd(7)} ${p.slug}${p.detail ? ` (${p.detail})` : ''}`);
  if (o.notes) lines.push(`  notes    ${o.notes.action === 'imported' ? `${would}import ${o.notes.files} file(s) from ${o.notes.dir} (read only)` : `${o.notes.action}: ${o.notes.detail ?? ''} (${o.notes.argv.join(' ')})`}`);
  if (!dryRun && o.shape === 'personal') lines.push(`  check    ${o.check.ok ? 'ok' : 'not verified'}: ${o.check.detail}`);
  if (o.next_question) lines.push(`Next question: ${o.next_question}`);
  return lines;
}

/** Notices for what the agent still has to do: a deferred or failed import, a failed page. */
export function layoutNotices(o: LayoutOutcome | null, harness: string): Notice[] {
  if (!o) return [];
  const out: Notice[] = [];
  if (o.notes && o.notes.action !== 'imported') {
    out.push({
      code: 'brain_layout_import_pending', kind: 'coaching',
      why: o.notes.action === 'deferred' ? `${o.notes.dir} holds more than ${IMPORT_INLINE_MAX} markdown files, so setup did not import it inline.`
        : `The import of ${o.notes.dir} did not finish (${o.notes.detail ?? 'unknown error'}); nothing else changed.`,
      fix: { argv: o.notes.argv, consent: [], actor: 'agent', requires_exclusive: true, why: 'Imports the notes folder (read only) into the brain; run it as its own step.' },
    });
  }
  const failed = o.pages.filter(p => p.action === 'failed');
  if (failed.length) {
    out.push({
      code: 'brain_layout_pages_pending', kind: 'coaching',
      why: `Setup could not write ${failed.map(p => p.slug).join(', ')} (${failed[0]!.detail}); the rest of the install finished.`,
      fix: { argv: ['gbrain', 'setup', harness, '--shape', 'personal'], consent: [], actor: 'agent', requires_exclusive: true, why: 'Rerun once the brain is free; existing pages are kept.' },
    });
  }
  return out;
}

/**
 * The `brain_shape` decision for a brand-new brain set up without --shape. Nothing is written until it is
 * answered (default none); each option is the exact command that applies it.
 */
export function brainShapeDecision(harness: string, folders: string[] = candidateNoteFolders()): Decision {
  const base = ['gbrain', 'setup', harness, '--shape', 'personal'];
  return {
    id: 'brain_shape',
    question: 'Make this a personal brain? Setup adds three empty starter pages (facts about you, your voice, how you decide), '
      + 'tells the agent to read them, and imports a notes folder you pick, read only. Nothing about you is invented.',
    options: [
      ...folders.slice(0, 3).map((f, i) => ({ id: `personal_notes_${i + 1}`, label: `Personal brain, importing ${f}`, argv: [...base, '--notes', f] })),
      { id: 'personal', label: 'Personal brain, no notes folder yet', argv: base },
      { id: 'none', label: 'No starter pages (memory works as it is)' },
    ],
    default: 'none',
    default_reason: 'Nothing is written until the user picks; memory already works without it.',
  };
}

/** The inline brain_shape question; readLine answers eof (decline) unless isInteractive(). */
export async function askBrainShape(folders: string[] = candidateNoteFolders()): Promise<{ brain?: BrainShape; notes?: string | null }> {
  const line = async (prompt: string): Promise<string | null> => { const r = await readLine({ prompt }); return r.kind === 'line' ? r.text : null; };
  const yes = (await line('Make this a personal brain? Three empty starter pages (facts about you, your voice, how you decide); nothing about you is invented. [y/N] '))?.toLowerCase();
  if (yes !== 'y' && yes !== 'yes') return {};
  const hint = folders[0] ? ` [${folders[0]}]` : '';
  const raw = (await line(`Notes folder to import, read only (Enter ${hint ? 'for the one shown' : 'to skip'}, "none" to skip)${hint}: `)) ?? 'none';
  const picked = raw === 'none' ? null : raw || folders[0] || null;
  if (!picked) return { brain: 'personal', notes: null };
  const abs = resolve(picked.startsWith('~/') ? join(homedir(), picked.slice(2)) : picked);
  try { if (statSync(abs).isDirectory()) return { brain: 'personal', notes: abs }; } catch { /* below */ }
  process.stderr.write(`${picked} is not a folder; skipping the import (run gbrain import <dir> --no-embed later)\n`);
  return { brain: 'personal', notes: null };
}

/** Add brain_shape to setup's first-run bundle (one bundle, never a second notice). */
export function withBrainShape(notices: Notice[], decision: Decision): Notice[] {
  const i = notices.findIndex(n => n.code === 'first_run_decisions');
  const line = ' Want a personal brain? I can add starter pages for facts about you, your voice and how you decide, and import a notes folder you pick.';
  if (i < 0) {
    return [{ code: 'first_run_decisions', kind: 'ask', why: 'Setup is complete and memory works now. One optional choice remains; nothing is written until the user answers.',
      user_message: `gbrain is set up, so memory works now.${line}`, decisions: [decision] }, ...notices];
  }
  const n = notices[i]!;
  const next = [...notices];
  next[i] = { ...n, user_message: `${n.user_message ?? ''}${line}`, decisions: [...(n.decisions ?? []), decision] };
  return next;
}
