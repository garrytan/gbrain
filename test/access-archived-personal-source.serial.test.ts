/**
 * Sync 17 privacy proof, CLI half (test/access-archived-personal-source.test.ts is the key half): after another member's
 * personal source is archived, `gbrain <read> --as <member>` shows none of its pages through get (named and unnamed),
 * search, query, find and --source __all__, while the member's own personal source still reads.
 * Fails when: any of those previews prints the archived source's canary or slug, or the member's own source stops reading.
 * Seam: src/cli.ts subprocesses on a keyless repo-less PGLite brain set up with the documented commands.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OWNER_MEMBER, PERSONAL_KEYS, PERSONAL_PAGES, personalCliReads, personalPageText, readNames, type PersonalKey } from './helpers/personal-sources-fixture.ts';

const CLI = join(resolve(import.meta.dir, '..'), 'src', 'cli.ts');
const MEMBERS = ['owner-example', 'pat-example', 'quin-example'] as const;
let root: string, home: string;

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_BRAIN_ID', 'GBRAIN_SOURCE', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'GBRAIN_ENFORCED_MEMBER']) delete out[key];
  return { ...out, HOME: home, GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0' };
}

async function cli(args: string[], stdin?: string) {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd: root, env: env(), stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

async function must(args: string[], stdin?: string) {
  const r = await cli(args, stdin);
  if (r.exitCode !== 0) throw new Error(`gbrain ${args.join(' ')} failed (${r.exitCode}):\n${r.stdout}\n${r.stderr}`);
  return r;
}


async function previewSeenBy(member: string): Promise<Record<string, PersonalKey[]>> {
  const out: Record<string, PersonalKey[]> = {};
  for (const key of PERSONAL_KEYS) {
    for (const [label, args] of personalCliReads(key)) {
      const r = await cli([...args, '--as', member]);
      (out[label] ??= []);
      if (readNames(label, r.stdout, key)) out[label]!.push(key);
    }
  }
  return out;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gb-personal-sources-'));
  home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  await must(['init', '--pglite', '--no-embedding', '--non-interactive']);
  for (const key of PERSONAL_KEYS) await must(['sources', 'add', PERSONAL_PAGES[key].source]);
  for (const member of MEMBERS) await must(['access', 'member', 'add', member]);
  await must(['access', 'owner', 'set', OWNER_MEMBER]);
  for (const key of PERSONAL_KEYS) {
    const p = PERSONAL_PAGES[key];
    if (p.member) await must(['access', 'member', 'source', 'add', p.member, p.source]);
    await must(['put', p.slug, '--source-id', p.source], personalPageText(key));
  }
}, 300_000);
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('--as previews with a personal source archived (repo-less PGLite)', () => {
  test('--as quin shows no page of pat\'s archived personal source and still shows quin\'s own', async () => {
    const before = await previewSeenBy('quin-example');
    expect(before['get_page named']).toEqual(['quin', 'team']);
    await must(['sources', 'archive', PERSONAL_PAGES.pat.source]);
    const after = await previewSeenBy('quin-example');
    for (const [label, seen] of Object.entries(after)) {
      expect({ label, pat: seen.includes('pat') }).toEqual({ label, pat: false });
    }
    expect(after['search']).toContain('quin');
    const named = await cli(['get', PERSONAL_PAGES.pat.slug, '--source', PERSONAL_PAGES.pat.source, '--as', 'quin-example']);
    expect(named.stdout).not.toContain(PERSONAL_PAGES.pat.canary);
  }, 300_000);
});
