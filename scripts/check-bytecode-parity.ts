#!/usr/bin/env bun
/**
 * Proves the release build's bytecode flags change nothing a user sees.
 *
 * The release job compiles with `--bytecode --format=esm` (.github/workflows/release.yml), which
 * stores the parsed bundle in the binary so a command no longer spends about 0.5 s parsing it.
 * This script reads that exact compile line, builds it twice on this host (once as written, once
 * with the two bytecode flags removed), and runs a fixed command set against each binary on a
 * fresh PGLite brain at the same path. stdout, stderr and the exit code of every command must be
 * byte-identical, and every command must succeed in both builds. Only text that changes between two
 * runs of one binary is masked (see NORMALIZE).
 *
 * The query step and the skill-resolver hook use a loopback OpenAI-compatible embeddings stub
 * (deterministic bag-of-words vectors, no network, no key), so the vector paths run too.
 *
 * Usage: bun scripts/check-bytecode-parity.ts [--keep]   (BYTECODE_PARITY_RAW=1 compares unmasked text)
 * Exit:  0 when every command matches; 1 on a difference or a failed build.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const BYTECODE_FLAGS = ['--bytecode', '--format=esm'] as const;
const ROOT = resolve(import.meta.dir, '..');
const DIMS = 1536;

/** The release workflow's compile argv for this host: no --target, our --outfile and commit. */
export function releaseCompileArgs(workflow: string, outfile: string, commit: string): string[] {
  const line = workflow.split('\n').find(l => /run: bun build --compile/.test(l));
  if (!line) throw new Error('release.yml has no `run: bun build --compile` line');
  const args = line.replace(/^\s*- run: bun /, '').replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, '@$1@').trim().split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--target=')) continue; // build for this host
    if (a === '--outfile') { out.push(a, outfile); i++; continue; }
    out.push(a === `GBRAIN_BUILD_COMMIT='"@github.sha@"'` ? `GBRAIN_BUILD_COMMIT="${commit}"` : a);
  }
  if (out.some(a => a.includes('@'))) throw new Error(`unparsed workflow expression in: ${line.trim()}`);
  return out;
}

/** Masks only text that differs between two runs of the SAME binary (clock, ids, ports, pids). */
export function NORMALIZE(text: string, port: number): string {
  if (process.env.BYTECODE_PARITY_RAW === '1') return text;
  return text
    .replaceAll(`127.0.0.1:${port}`, '127.0.0.1:<port>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '<time>')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<date>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/("(?:[a-z_]*_ms|duration[a-z_]*|elapsed[a-z_]*|took[a-z_]*|latency[a-z_]*|pid|inode|dev|ino|age_seconds|table_bytes)"\s*:\s*)-?\d+(\.\d+)?/gi, '$1<n>')
    .replace(/\b\d+(\.\d+)?\s?(ms|s)\b/g, '<dur>')
    // Recency-weighted scores move in the 7th decimal as the clock moves between runs.
    .replace(/(\d+\.\d{5})\d{2,}/g, '$1~');
}

function startEmbeddingStub(): Promise<{ port: number; close: () => void }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (!req.url?.endsWith('/embeddings')) { res.writeHead(404).end(); return; }
      const parsed = JSON.parse(body || '{}') as { input?: string | string[]; dimensions?: number; model?: string };
      const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input ?? ''];
      const dims = parsed.dimensions ?? DIMS;
      const data = inputs.map((text, index) => {
        // Bag of words: texts that share words get a high cosine, as real embeddings give texts that share
        // meaning, so a ranking or a no-skill gate on the cosine (the skill resolver's vectors) behaves as it would.
        const v = new Array<number>(dims).fill(0);
        for (const word of String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []) {
          let h = 0;
          for (let i = 0; i < word.length; i++) h = (h * 31 + word.charCodeAt(i)) >>> 0;
          v[h % dims] += 1;
        }
        const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
        return { object: 'embedding', index, embedding: v.map(x => x / norm) };
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        object: 'list', data, model: parsed.model ?? 'stub', usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
      }));
    });
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok({ port: (server.address() as { port: number }).port, close: () => server.close() })));
}

/**
 * `@BIN@` and `@HOME@` in args expand per run. Both builds must exit with `exit` (default 0) and print `shows`,
 * so a step that fails, hangs or breaks the same way in both builds cannot pass.
 */
interface Step { name: string; args: string[]; stdin?: string; env?: Record<string, string>; mcp?: boolean; shows?: string; exit?: number }

const PAGE_A = '---\ntitle: Alpha Example\ntype: note\n---\n# Alpha Example\n\nThe parity widget ships on Tuesdays. See [[notes/beta]].\n';
const PAGE_B = '---\ntitle: Beta Example\ntype: note\n---\n# Beta Example\n\nBeta covers the widget roadmap and its release cadence.\n';
const MCP_INPUT = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bytecode-parity', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
].map(m => JSON.stringify(m)).join('\n') + '\n';

export const STEPS: Step[] = [
  { name: 'version', args: ['--version'], shows: 'gbrain ' },
  { name: 'help', args: ['--help'], shows: 'USAGE' },
  { name: 'init', args: ['init', '--pglite', '--non-interactive', '--json', '--embedding-model', 'openai:text-embedding-3-small', '--embedding-dimensions', String(DIMS)], shows: '"live_ok":true' },
  { name: 'put-alpha', args: ['put', 'notes/alpha', '--content-origin', 'user_said'], stdin: PAGE_A, shows: 'notes/alpha' },
  { name: 'put-beta', args: ['put', 'notes/beta', '--content-origin', 'user_said'], stdin: PAGE_B, shows: 'notes/beta' },
  { name: 'get', args: ['get', 'notes/alpha'], shows: 'The parity widget ships on Tuesdays' },
  { name: 'list', args: ['list'], shows: 'notes/beta' },
  { name: 'search-keyword', args: ['search', 'widget', '--match', 'keyword'], shows: 'notes/alpha' },
  { name: 'embed', args: ['embed', '--stale', '--yes'], shows: 'Embedded' },
  { name: 'query', args: ['query', 'when does the widget ship', '--json'], shows: '"cosine"' },
  { name: 'doctor', args: ['doctor', '--json'], shows: '"checks"' },
  { name: 'mcp-tools-list', args: ['serve'], stdin: MCP_INPUT, mcp: true, shows: '"name":"get_page"' },
  // The hook lane runs in a worker thread started from the binary's second entrypoint.
  { name: 'setup-claude-code', args: ['setup', 'claude-code', '--instructions-only', '--skill-loading', 'resolve', '--gbrain-bin', '@BIN@'] },
  { name: 'hook-skill-lane', args: ['hook', 'user-prompt'], env: { GBRAIN_HOOK_LANE: 'skill-resolver', GBRAIN_TEST_SKILL_LANE_DEADLINE_MS: '10000' },
    stdin: JSON.stringify({ prompt: 'please deploy the widget to staging', session_id: 'parity-1', cwd: '@HOME@' }), shows: 'id: \\"deploy-widget\\"' },
];

export interface Outcome { stdout: string; stderr: string; status: number | null }

/** Why one step fails: a wrong or killed exit in either build, a missing marker, or a difference between the builds. */
export function stepProblems(step: Step, a: Outcome, b: Outcome, port: number): string[] {
  const want = step.exit ?? 0, problems: string[] = [];
  if (a.status !== want || b.status !== want) problems.push(`exit plain=${a.status} bytecode=${b.status}, expected ${want}`);
  if (step.shows !== undefined && !(a.stdout.includes(step.shows) && b.stdout.includes(step.shows))) problems.push(`stdout lacks ${step.shows} (the step did not run its path)`);
  for (const k of ['stdout', 'stderr'] as const) if (NORMALIZE(a[k], port) !== NORMALIZE(b[k], port)) problems.push(`${k} differs`);
  return problems;
}

/** One binary through every step, on a brain at `runDir` (wiped first, so both binaries see the same paths). */
async function runAll(built: string, runDir: string, port: number, saveDir: string): Promise<Map<string, Outcome>> {
  mkdirSync(saveDir, { recursive: true });
  rmSync(runDir, { recursive: true, force: true });
  const skill = join(runDir, '.claude', 'skills', 'deploy-widget');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: deploy-widget\ndescription: Deploy the widget service to staging or production.\n---\nSteps.\n');
  mkdirSync(join(runDir, 'bin'));
  const bin = join(runDir, 'bin', 'gbrain'); // one path for both builds, so printed paths match
  copyFileSync(built, bin);
  chmodSync(bin, 0o755);
  const expand = (t: string) => t.replaceAll('@BIN@', bin).replaceAll('@HOME@', runDir);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: runDir, GBRAIN_HOME: runDir, TZ: 'UTC', LANG: 'C.UTF-8',
    NO_COLOR: '1', TERM: 'dumb', CI: '1', GBRAIN_SKIP_STARTUP_HOOKS: '1',
    OPENAI_API_KEY: 'stub', OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
  };
  const out = new Map<string, Outcome>();
  for (const step of STEPS) {
    // Async spawn: the embeddings stub answers from this process's event loop.
    const s = { ...step, args: step.args.map(expand), stdin: step.stdin && expand(step.stdin) };
    const e = { ...env, ...step.env };
    const o = step.mcp ? await runMcp(bin, s, runDir, e) : await runOne(bin, s, runDir, e);
    out.set(step.name, o);
    writeFileSync(join(saveDir, `${step.name}.stdout`), o.stdout);
    writeFileSync(join(saveDir, `${step.name}.stderr`), `${o.stderr}\n[exit ${o.status}]\n`);
  }
  return out;
}

/** One command; its stdin is closed after the step's input. */
async function runOne(bin: string, step: Step, cwd: string, env: Record<string, string>): Promise<Outcome> {
  const child = Bun.spawn([bin, ...step.args], { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  child.stdin.write(step.stdin ?? '');
  child.stdin.end();
  const timer = setTimeout(() => child.kill(9), 120_000);
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  return { stdout, stderr, status };
}

/** stdio MCP: write the requests, close stdin once the tools/list reply arrives, and let the server exit. */
async function runMcp(bin: string, step: Step, cwd: string, env: Record<string, string>): Promise<Outcome> {
  const child = Bun.spawn([bin, ...step.args], { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  child.stdin.write(step.stdin!);
  child.stdin.flush();
  const timer = setTimeout(() => child.kill(9), 60_000);
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader(), dec = new TextDecoder();
  let stdout = '', closed = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    stdout += dec.decode(value, { stream: true });
    if (!closed && stdout.includes('"id":2')) { closed = true; child.stdin.end(); }
  }
  const status = await child.exited;
  clearTimeout(timer);
  return { stdout: stdout + dec.decode(), stderr: await stderr, status };
}

/**
 * The work directory by its real path. macOS temp folders live under /var, a symlink, and gbrain init
 * refuses a brain or content root below a symlink, so a symlinked spelling fails both builds the same way.
 */
export function makeWorkDir(base = tmpdir()): string {
  return realpathSync(mkdtempSync(join(base, 'gbrain-bytecode-parity-')));
}

async function main(): Promise<number> {
  const keep = process.argv.includes('--keep');
  const work = makeWorkDir();
  const stub = await startEmbeddingStub();
  let rc = 1;
  try {
    const workflow = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || 'unknown';
    const candidate = releaseCompileArgs(workflow, join(work, 'gbrain-bytecode'), commit);
    for (const f of BYTECODE_FLAGS) {
      if (!candidate.includes(f)) { console.error(`FAIL: the release compile line lacks ${f}`); return 1; }
    }
    const baseline = releaseCompileArgs(workflow, join(work, 'gbrain-plain'), commit).filter(a => !(BYTECODE_FLAGS as readonly string[]).includes(a));
    for (const args of [baseline, candidate]) {
      const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (r.status !== 0) { console.error(`FAIL: bun ${args.join(' ')}\n${r.stdout}${r.stderr}`); return 1; }
    }
    const runDir = join(work, 'brain');
    const plain = await runAll(join(work, 'gbrain-plain'), runDir, stub.port, join(work, 'out-plain'));
    const bytecode = await runAll(join(work, 'gbrain-bytecode'), runDir, stub.port, join(work, 'out-bytecode'));
    let failed = 0;
    for (const step of STEPS) {
      const a = plain.get(step.name)!, b = bytecode.get(step.name)!;
      const problems = stepProblems(step, a, b, stub.port);
      const size = `${a.stdout.length}+${a.stderr.length} bytes, exit ${a.status}`;
      if (problems.length === 0) { console.log(`ok   ${step.name} (${size})`); continue; }
      failed++;
      console.log(`FAIL ${step.name}: ${problems.join('; ')} (${size})`);
      console.log(`  outputs: ${join(work, 'out-plain', step.name)}.* ${join(work, 'out-bytecode', step.name)}.*`);
    }
    if (failed) { console.error(`FAIL: ${failed} of ${STEPS.length} commands failed or differ between the plain and the bytecode build`); return 1; }
    console.log(`PASS: ${STEPS.length} commands give the same stdout, stderr and exit code from the plain and the bytecode build (clock, ids and timings masked)`);
    return rc = 0;
  } finally {
    stub.close();
    if (!keep && rc === 0) rmSync(work, { recursive: true, force: true });
    else console.log(`kept ${work}`);
  }
}

if (import.meta.main) process.exit(await main());
