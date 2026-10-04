/**
 * C9 (agent operator wave): the consent table.
 *
 * Part 1 runs the real CLI, non-interactively (GBRAIN_NON_INTERACTIVE=1,
 * stdin </dev/null), against one keyless PGLite brain, once per consent-gated
 * command that can reach its gate there, without authorization. Every row
 * must exit 3 with a `confirmation_required` document and leave the brain's
 * pages, dates, config and sources exactly as they were. `today_non_tty`
 * records what the same invocation did before the wave, so every flip is
 * deliberate and listed in the behavior table.
 *
 * Part 2 pins the cap matrix against the real BudgetTracker (derived /
 * default / user cap × priced / unpriced model), the null-estimate default
 * cap, per-run preapproval, the `--non-interactive` mapping, and a library
 * path (brainstorm) proceeding unattended under its printed cap.
 *
 * Serial: spawns the CLI and writes GBRAIN_HOME.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { BudgetExhausted, BudgetTracker } from '../src/core/budget/budget-tracker.ts';
import { DEFAULT_PAID_CAP_USD, isConsentRefusal, requireConsent, type ConsentRequest } from '../src/core/consent.ts';
import { previewCostAndWait } from '../src/core/brainstorm/orchestrator.ts';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
let home: string;
let brainPath: string;
let notes: string;
let chapters: string;

async function cli(args: string[], extraEnv: Record<string, string> = {}) {
  const base = Object.fromEntries(Object.entries(process.env)
    .filter(([k]) => !k.startsWith('GBRAIN_') && !k.endsWith('_API_KEY') && k !== 'DATABASE_URL')) as Record<string, string>;
  const proc = Bun.spawn(['bun', 'run', `${REPO}/src/cli.ts`, ...args], {
    cwd: home,
    env: { ...base, HOME: home, GBRAIN_HOME: home, GBRAIN_NON_INTERACTIVE: '1', GBRAIN_NO_RETRY_CONNECT: '1', ...extraEnv },
    stdin: Bun.file('/dev/null'), stdout: 'pipe', stderr: 'pipe',
  });
  const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 90_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(killer);
  }
}

/** Pages, their stored dates, config rows and sources: what a refused run must not change. */
async function snapshot(): Promise<string> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: brainPath });
  try {
    const pages = await engine.executeRaw('SELECT source_id, slug, effective_date::text AS d, effective_date_source AS s, content_hash FROM pages ORDER BY 1, 2');
    const config = await engine.executeRaw("SELECT key, value FROM config WHERE key NOT LIKE 'last_%' AND key NOT LIKE '%heartbeat%' ORDER BY key");
    const sources = await engine.executeRaw('SELECT id FROM sources ORDER BY id');
    return JSON.stringify({ pages, config, sources });
  } finally {
    await engine.disconnect();
  }
}

/** The consent document a refused run prints on stdout under --json, or the human [AGENT] block. */
function refusal(stdout: string): { code?: string; effects?: string[] } {
  const start = stdout.indexOf('{\n  "status": "confirmation_required"');
  if (start < 0) return stdout.includes('[AGENT]') && stdout.includes('consent:') ? { code: 'confirmation_required' } : {};
  return JSON.parse(stdout.slice(start, stdout.indexOf('\n}\n', start) + 2));
}

interface Row {
  name: string;
  argv: () => string[];
  env?: Record<string, string>;
  effects: string[];
  /** What the same non-interactive, unauthorized invocation did before the wave. */
  today_non_tty: string;
}

const ROWS: Row[] = [
  { name: 'reindex-frontmatter --json', argv: () => ['reindex-frontmatter', '--force', '--json'], effects: ['destructive'],
    today_non_tty: 'ran: --json skipped the prompt and rewrote every page\'s effective_date (exit 0)' },
  { name: 'reindex-search-vector --json', argv: () => ['reindex-search-vector', '--json'], effects: ['destructive'],
    today_non_tty: 'refused: ConfirmationRequired envelope, exit 2' },
  { name: 'reinit-pglite', argv: () => ['reinit-pglite', '--embedding-model', 'openai:text-embedding-3-small', '--embedding-dimensions', '1536', '--json'],
    effects: ['destructive'], today_non_tty: 'refused: {status:error, reason:no_tty_no_yes}, exit 1' },
  { name: 'reinit-pglite --yes (bare, not bound to the plan)', argv: () => ['reinit-pglite', '--embedding-model', 'openai:text-embedding-3-small', '--embedding-dimensions', '1536', '--yes', '--json'],
    effects: ['destructive'], today_non_tty: 'ran: moved the brain to .bak and re-initialized it (exit 0)' },
  { name: 'pglite-repair', argv: () => ['pglite-repair', '--path', brainPath, '--json'], effects: ['destructive'],
    today_non_tty: 'refused: {status:error, code:no_tty_no_yes}, exit 1' },
  { name: 'enrich', argv: () => ['enrich', '--json'], env: { OPENAI_API_KEY: 'sk-test-not-used' }, effects: ['paid'],
    today_non_tty: 'refused: "Refusing to spend without a cap in a non-interactive context", exit 1' },
  { name: 'book-mirror', argv: () => ['book-mirror', '--chapters-dir', chapters, '--slug', 'a-book'], effects: ['paid'],
    today_non_tty: 'refused: "refusing to spend … Pass --yes", exit 0 (nothing submitted)' },
  { name: 'connect --install (opencode)', argv: () => ['connect', 'https://brain.example.invalid/mcp', '--token', 'gbrain_tok_example', '--agent', 'opencode', '--install', '--json'],
    effects: ['credentials', 'persistent_install'], today_non_tty: 'refused: "--install in a non-interactive shell requires --yes", exit 1' },
];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-consent-table-'));
  brainPath = join(home, '.gbrain', 'brain.pglite');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: brainPath, embedding_disabled: true }, null, 2));
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: brainPath });
  await engine.initSchema();
  await engine.disconnect();
  notes = join(home, 'notes');
  mkdirSync(join(notes, 'meetings'), { recursive: true });
  writeFileSync(join(notes, 'meetings', '2026-01-02-sync.md'), '---\ntitle: Sync\nevent_date: 2026-01-02\n---\n\nA meeting about the launch.\n');
  writeFileSync(join(notes, 'idea.md'), '---\ntitle: Idea\n---\n\nAn idea page.\n');
  const imported = await cli(['import', notes, '--no-embed']);
  expect(imported.exitCode).toBe(0);
  chapters = join(home, 'chapters');
  mkdirSync(chapters, { recursive: true });
  writeFileSync(join(chapters, '01.txt'), 'Chapter one text.');
  writeFileSync(join(chapters, '02.txt'), 'Chapter two text.');
}, 180_000);

afterAll(() => { rmSync(home, { recursive: true, force: true }); });

describe('C9 part 1: every consent-gated command, non-interactive without authorization, exits 3 and mutates nothing', () => {
  for (const row of ROWS) {
    test(`${row.name} (before the wave: ${row.today_non_tty})`, async () => {
      const before = await snapshot();
      const r = await cli(row.argv(), row.env);
      if (r.exitCode !== 3) console.error(`--- ${row.name} stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
      expect(r.exitCode).toBe(3);
      const doc = refusal(r.stdout);
      expect(doc.code).toBe('confirmation_required');
      if (doc.effects) expect(doc.effects).toEqual(row.effects);
      expect(await snapshot()).toBe(before);
    }, 120_000);
  }
});

const req = (effects: ConsentRequest['effects'], args: string[], extra: Partial<ConsentRequest> = {}): ConsentRequest => ({
  command: 'table-row', effects, actor: 'agent', what: 'Table row', why: 'why', risk: 'risk', user_message: 'ok?',
  argv: ['gbrain', 'table-row'], args, ...extra,
});
const quiet = { interactive: false, preapprovals: {}, note: () => {} };

describe('C9 part 2: caps against the real BudgetTracker', () => {
  test('--yes with an estimate → derived cap (x1.5, floor $0.25); a priced overrun stops the run', async () => {
    const auth = await requireConsent(req(['paid'], ['--yes'], { est_usd: 0.4 }), quiet);
    expect(auth).toMatchObject({ via: 'yes', cap_usd: 0.6, cap_source: 'derived' });
    const tracker = new BudgetTracker({ label: 'table', maxCostUsd: auth.cap_usd!, capSource: auth.cap_source! });
    expect(() => tracker.reserve({ modelId: 'anthropic:claude-sonnet-4-6', estimatedInputTokens: 2_000_000, maxOutputTokens: 0, kind: 'chat' }))
      .toThrow(BudgetExhausted);
  });

  test('derived cap × unpriced model warns and runs; user cap × unpriced model refuses (no_pricing)', async () => {
    const derived = new BudgetTracker({ label: 'table', maxCostUsd: 0.6, capSource: 'derived' });
    expect(() => derived.reserve({ modelId: 'example:unpriced-model-x', estimatedInputTokens: 1000, maxOutputTokens: 100, kind: 'chat' })).not.toThrow();
    const user = new BudgetTracker({ label: 'table', maxCostUsd: 0.6, capSource: 'user' });
    expect(() => user.reserve({ modelId: 'example:unpriced-model-x', estimatedInputTokens: 1000, maxOutputTokens: 100, kind: 'chat' })).toThrow(BudgetExhausted);
  });

  test('null estimate → the printed default cap; explicit --max-usd → user cap', async () => {
    const notes: string[] = [];
    const def = await requireConsent(req(['paid'], ['--yes'], { est_usd: null }), { ...quiet, note: l => notes.push(l) });
    expect(def).toMatchObject({ cap_usd: DEFAULT_PAID_CAP_USD, cap_source: 'default' });
    expect(notes.join('\n')).toContain('default');
    expect(await requireConsent(req(['paid'], ['--max-usd', '2'], { est_usd: 1 }), quiet)).toMatchObject({ via: 'max_usd', cap_usd: 2, cap_source: 'user' });
  });

  test('per-run preapproval authorizes paid work under its limit, never destructive work', async () => {
    const pre = { paid: { max_usd_per_run: 1 } };
    expect(await requireConsent(req(['paid'], [], { est_usd: 0.5 }), { ...quiet, preapprovals: pre })).toMatchObject({ via: 'preapproval', cap_usd: 1, cap_source: 'user' });
    const over = await requireConsent(req(['paid'], [], { est_usd: 2 }), { ...quiet, preapprovals: pre }).catch(e => e);
    expect(isConsentRefusal(over)).toBe(true);
    const destructive = await requireConsent(req(['destructive', 'paid'], [], { est_usd: 0.5 }), { ...quiet, preapprovals: pre }).catch(e => e);
    expect(isConsentRefusal(destructive)).toBe(true);
  });

  test('--non-interactive authorizes only what its command maps (apply-migrations: persistent_install)', async () => {
    expect(await requireConsent(req(['persistent_install'], ['--non-interactive'], { command: 'apply-migrations' }), quiet))
      .toMatchObject({ via: 'non_interactive_flag' });
    const paid = await requireConsent(req(['paid'], ['--non-interactive'], { command: 'apply-migrations' }), quiet).catch(e => e);
    expect(isConsentRefusal(paid)).toBe(true);
    const other = await requireConsent(req(['persistent_install'], ['--non-interactive'], { command: 'enrich' }), quiet).catch(e => e);
    expect(isConsentRefusal(other)).toBe(true);
  });

  test('library path: brainstorm proceeds unattended (no silent flip) and prints the cap it runs under', async () => {
    const lines: string[] = [];
    const r = await previewCostAndWait({
      profile: { label: 'brainstorm', k_close: 2, m_far: 2, ideas_per_cross: 3 } as never,
      model: 'anthropic:claude-sonnet-4-6', skip: false, stderrWrite: s => lines.push(s), interactive: false, capUsd: 5,
    });
    expect(r.aborted).toBe(false);
    expect(lines.join('')).toContain('hard-capped at $5.00');
    expect(lines.join('')).toContain('consent: paid');
  });
});
