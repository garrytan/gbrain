/**
 * Doc test for docs/guides/repair.md "Fences" (#6188, D22, D33). It builds the
 * walkthrough's fixture with the real CLI on a throwaway PGLite brain: a Git
 * source synced once, then generator-written notes with malformed facts and
 * takes fences committed while `sync.holds=fail` (the pre-upgrade fail-closed
 * behavior) so the source is blocked. Then it runs every `$ ` command in the
 * section's console blocks, in order, and checks that each output line the
 * guide shows appears in the real output (hashes, ids, times, costs and the
 * checkout path normalized) and that every command exits 0. The model is a
 * local stand-in for the provider's Responses API (OPENAI_BASE_URL), so the
 * spawned CLI makes its genuine provider call and no network or key is used;
 * `models.fence_repair` is unset, so the repair uses the measured default for
 * an OpenAI key (openai:gpt-6.1-sol).
 *
 * Protects: the documented journey (post-upgrade notice, converting sync,
 * sources status, preview, apply, commit subjects, doctor ok) and its command
 * counts: one command to green (the sync), two to repaired (preview, apply).
 * Fails when: a message, command, flag or flow drifts from the guide.
 * Why new: the fences walkthrough is new in PR4.
 * Seams: none (a local provider stand-in behind the documented base-URL env).
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..');
const work = mkdtempSync(join(tmpdir(), 'gbrain-fence-walkthrough-'));
const checkout = join(work, 'notes');
const FB = '<!--- gbrain:facts:begin -->', FBE = '<!--- gbrain:facts:end -->';
const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
const NARROW = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |';
const SEP = '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|';
const T = '<!--- gbrain:takes:begin -->', TE = '<!--- gbrain:takes:end -->';
const TH = '| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|';
const ACME_ROW = '| 1 | acme-example raised a seed round | fact | 0.9 | private | high | 2026-03-01 |  | meeting notes |  |';
const usage = { input_tokens: 1200, output_tokens: 150 };

let requests = 0;
const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.endsWith('/responses')) return new Response(JSON.stringify({ data: [{ id: 'gpt-5.5' }] }), { headers: { 'Content-Type': 'application/json' } });
    requests++;
    return new Response(JSON.stringify({ id: 'resp_walkthrough', object: 'response', created_at: 1, model: 'gpt-6.1-sol', status: 'completed', error: null, incomplete_details: null,
      output: [{ type: 'message', id: 'msg_walkthrough', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: `${NARROW}\n${SEP}\n${ACME_ROW}`, annotations: [] }] }],
      usage: { ...usage, total_tokens: usage.input_tokens + usage.output_tokens } }), { headers: { 'Content-Type': 'application/json' } });
  },
});

const env: Record<string, string> = Object.fromEntries(Object.entries(process.env)
  .filter(([key, value]) => value !== undefined && !['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SOURCE', 'GBRAIN_BRAIN_ID', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'GEMINI_API_KEY'].includes(key))) as Record<string, string>;
env.GBRAIN_HOME = join(work, 'home');
env.OPENAI_API_KEY = 'sk-walkthrough-not-used';
env.OPENAI_BASE_URL = `http://127.0.0.1:${provider.port}/v1`;

afterAll(() => { provider.stop(true); rmSync(work, { recursive: true, force: true }); });

/** Async, so the provider stand-in in this process can answer while the CLI runs. */
async function run(argv: string[]): Promise<{ out: string; status: number | null }> {
  const cmd = argv[0] === 'gbrain' ? [process.execPath, '--no-env-file', join(REPO, 'src', 'cli.ts'), ...argv.slice(1)] : argv;
  const proc = Bun.spawn(cmd, { cwd: REPO, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const killer = setTimeout(() => proc.kill('SIGKILL'), 120_000);
  try {
    const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out: `${stdout}${stderr}`, status };
  } finally { clearTimeout(killer); }
}

async function ok(argv: string[]): Promise<string> {
  const result = await run(argv);
  if (result.status !== 0) throw new Error(`${argv.join(' ')} exited ${result.status}:\n${result.out}`);
  return result.out;
}

const write = (files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) { mkdirSync(join(checkout, path, '..'), { recursive: true }); writeFileSync(join(checkout, path), content); }
};
const commit = async (message: string) => { await ok(['git', '-C', checkout, 'add', '-A']); await ok(['git', '-C', checkout, 'commit', '-qm', message]); };

/** The guide's placeholders for values that differ per run. */
function normalize(text: string): string {
  return text.split(checkout).join('~/brain/notes')
    .replace(/\b[0-9a-f]{64}\b/g, '<hash>')
    .replace(/\b[0-9a-f]{7,40}\b(?= gbrain:)/g, '<commit>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<id>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?Z?)?/g, '<time>')
    .replace(/\b\d+ h old\b/g, '<n> h old');
}

function tokens(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]!);
}

interface Step { command: string; expected: string[] }

/** The normalized real output of every step, kept in .context/ (never committed) for updating the guide. */
function writeDump(dump: string[]): void {
  mkdirSync(join(REPO, '.context'), { recursive: true });
  writeFileSync(join(REPO, '.context', 'fence-walkthrough-output.txt'), dump.join('\n'));
}

function walkthrough(): Step[] {
  const guide = readFileSync(join(REPO, 'docs', 'guides', 'repair.md'), 'utf8');
  const start = guide.indexOf('<a id="fences"></a>');
  const section = guide.slice(start, guide.indexOf('\n## ', start));
  const steps: Step[] = [];
  for (const block of section.matchAll(/```console\n([\s\S]*?)```/g)) {
    for (const raw of block[1]!.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('$ ')) steps.push({ command: line.slice(2), expected: [] });
      else steps.at(-1)!.expected.push(line);
    }
  }
  return steps;
}

test('docs/guides/repair.md "Fences": every command runs and prints every line the guide shows; one command to green, two to repaired', async () => {
  const steps = walkthrough();
  expect(steps.length).toBeGreaterThanOrEqual(6);

  // A source synced once by the older gbrain.
  mkdirSync(checkout, { recursive: true });
  await ok(['git', 'init', '-q', checkout]);
  await ok(['git', '-C', checkout, 'config', 'user.name', 'Example']);
  await ok(['git', '-C', checkout, 'config', 'user.email', 'example@example.invalid']);
  write({ 'people/alice-example.md': '---\ntitle: Alice Example\n---\nAlice Example runs product at widget-co.\n' });
  await commit('init');
  await ok(['gbrain', 'init', '--pglite', '--no-embedding']);
  await ok(['gbrain', 'config', 'set', 'self_upgrade.mode', 'off']);
  await ok(['gbrain', 'sources', 'add', 'notes', '--path', checkout]);
  await ok(['gbrain', 'sync', '--source', 'notes', '--no-pull']);

  // The generator's notes block the source under the pre-upgrade behavior.
  await ok(['gbrain', 'config', 'set', 'sync.holds', 'fail']);
  write({
    'meetings/2026-04-03.md': `---\ntitle: Widget launch sync\n---\nNotes from the launch sync.\n\n${FB}\n${FH}\n| 1 | widget-co ships the launch build | milestone | 0.8 | private | medium | 2026-04-03 |  | meeting notes |  |\n`,
    'companies/acme-example.md': `---\ntitle: acme-example\n---\nA company we track.\n\n${FB}\n${ACME_ROW}\n${FBE}\n`,
    'projects/widget-launch.md': `---\ntitle: Widget launch\n---\nThe launch plan.\n\n${T}\n${TH}\n| 1 | The launch slips a week | bet | Alice Example | 0.6 | 2026-04 | standup |\n${TE}\n`,
  });
  await commit('notes from the generator');
  const blocked = await run(['gbrain', 'sync', '--source', 'notes', '--no-pull']);
  expect(blocked.status).not.toBe(0);
  await ok(['gbrain', 'config', 'unset', 'sync.holds']);

  const counts = { toGreen: 0, toRepaired: 0 };
  let synced = false;
  const dump: string[] = [];
  let lastHash: string | undefined;
  for (const step of steps) {
    const argv = tokens(step.command).map(token => token === '<hash>' ? lastHash ?? '<no preview hash yet>' : token.replace('~/brain/notes', checkout));
    const out = await ok(argv);
    if (argv[0] === 'gbrain' && argv[1] !== 'post-upgrade' && !synced) { counts.toGreen++; synced = argv[1] === 'sync'; }
    if (argv[1] === 'repair' && argv[2] === 'fences') counts.toRepaired++;
    lastHash = [...out.matchAll(/--expect ([0-9a-f]{64})/g)].at(-1)?.[1] ?? lastHash;
    const shown = normalize(out);
    dump.push(`$ ${step.command}\n${shown}`);
    for (const line of step.expected) {
      if (!shown.includes(line)) {
        writeDump(dump);
        throw new Error(`"$ ${step.command}" no longer prints the guide's line:\n  ${line}\nActual output:\n${shown}`);
      }
    }
  }
  writeDump(dump);
  expect(counts).toEqual({ toGreen: 1, toRepaired: 2 });
  expect(requests).toBe(1);
  expect((await run(['git', '-C', checkout, 'status', '--porcelain'])).out).toBe('');
}, 600_000);
