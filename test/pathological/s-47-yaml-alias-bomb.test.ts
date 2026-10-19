/**
 * S-47 (GBRA-133): a YAML alias bomb in frontmatter. js-yaml's `load` keeps an
 * alias as a reference to its anchor, so a few hundred bytes of nested
 * `&aN [*aN-1, ...]` anchors parse instantly and expand exponentially the
 * first time the value is serialized (stored as frontmatter JSON, hashed,
 * compared). Nine levels of nine references OOM-killed sync at 15.5 GB in
 * every arm.
 *
 * Protects: the frontmatter loader refuses an expansion past its bound right
 * after load, before anything walks the value. A remote (remote=true) put_page
 * or edit_page is refused invalid_frontmatter and stores nothing; classic and
 * managed sync hold the one file invalid_frontmatter and import its sibling.
 * A nine-level bomb is refused at parse time without being expanded.
 * Fails when: a load site that sees page content calls js-yaml's `load`
 * without the expansion bound (the six-level bomb below is stored as ~3.7 MB
 * of frontmatter JSON instead of refused).
 * Bomb sizes: six levels (~530k nodes) end to end, so a regression fails here
 * instead of OOMing the runner; nine levels only at parse time, which never
 * serializes the value. PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { classifyImportHold, isFrontmatterHoldMessage, parseMarkdown } from '../../src/core/markdown.ts';
import { operations } from '../../src/core/operations.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { performSync } from '../../src/commands/sync.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { readGitSourceHolds } from '../../src/core/persistence/sync-holds.ts';
import { cpuMs } from '../helpers/cpu-time.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, managedBrain, pathologicalArms, snapshotItems } from './harness.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

/** `levels` nested anchors, each a flow sequence of nine aliases to the one before: 9^levels leaves once expanded. */
function aliasBomb(levels: number): string {
  const lines = ['a0: &a0 [leaf]'];
  for (let i = 1; i <= levels; i++) lines.push(`a${i}: &a${i} [${Array(9).fill(`*a${i - 1}`).join(', ')}]`);
  return lines.join('\n');
}
const note = (title: string, extra = '') => `---\ntitle: ${title}\ntype: note\n${extra ? `${extra}\n` : ''}---\n# ${title}\n\nBody of ${title}.\n`;
const BOMB_6 = note('Bomb note', aliasBomb(6));

/** Largest stored frontmatter (characters of its JSON text) in a source: a regression stores megabytes here. */
async function largestFrontmatter(engine: BrainEngine, sourceId: string): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number | null }>('SELECT max(length(frontmatter::text))::int AS n FROM pages WHERE source_id=$1', [sourceId]);
  return row?.n ?? 0;
}

/** Whether a live page row exists, without loading (and printing) a frontmatter a regression made megabytes long. */
async function stored(engine: BrainEngine, sourceId: string, slug: string): Promise<boolean> {
  return (await engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug])).length > 0;
}

const holdsOf = async (engine: BrainEngine, sourceId: string) =>
  ((await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? []).map(h => ({ path: h.path, code: h.code, reason: h.meta.reason, message: h.message }));

function commitFixture(root: string): void {
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, 'notes', 'good.md'), note('Good'));
  writeFileSync(join(root, 'notes', 'bomb.md'), BOMB_6);
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'fixture');
}

async function expectBombHeld(engine: BrainEngine, sourceId: string): Promise<void> {
  expect(await stored(engine, sourceId, 'notes/good')).toBe(true);
  expect(await stored(engine, sourceId, 'notes/bomb')).toBe(false);
  const hold = (await holdsOf(engine, sourceId)).find(h => h.path === 'notes/bomb.md');
  expectItemFailure(hold && { key: hold.path, code: hold.code }, { key: 'notes/bomb.md', code: 'invalid_frontmatter' });
  expect(hold!.reason).toBe('yaml_parse');
  expect(hold!.message).toMatch(/alias/);
  expect(await largestFrontmatter(engine, sourceId)).toBeLessThan(10_000);
}

describe('S-47 alias bomb at parse time (no engine)', () => {
  test('S-47 guard: a nine-level bomb is refused invalid_frontmatter naming the alias bound, without being expanded', () => {
    const content = note('Bomb note', aliasBomb(9));
    expect(content.length).toBeLessThan(700);
    let parsed!: ReturnType<typeof parseMarkdown>;
    expect(cpuMs(() => { parsed = parseMarkdown(content, 'notes/bomb.md', { validate: true }); })).toBeLessThan(1000);
    const hold = classifyImportHold(parsed);
    expect({ code: hold?.code, reason: hold?.reason }).toEqual({ code: 'invalid_frontmatter', reason: 'yaml_parse' });
    expect(hold!.message).toMatch(/alias/);
    expect(isFrontmatterHoldMessage(hold!.message)).toBe(true);
  });

  test('S-47 guard: ordinary anchors and merge keys stay readable', () => {
    const parsed = parseMarkdown(note('Anchors note', 'defaults: &d\n  status: active\n  owner: team-example\nfirst: *d\nsecond:\n  <<: *d\n  status: done'), 'notes/anchors.md', { validate: true });
    expect(classifyImportHold(parsed)).toBeNull();
    expect(parsed.frontmatter.first).toEqual({ status: 'active', owner: 'team-example' });
    expect(parsed.frontmatter.second).toEqual({ status: 'done', owner: 'team-example' });
  });
});

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`S-47 alias bomb (${backend})`, () => {
    test('S-47 item: a remote put_page and edit_page carrying a six-level bomb are refused invalid_frontmatter and store nothing; a sibling lands', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await op('put_page').handler(ctx, { slug: 'notes/kept', content: note('Kept') });
        const remote = { remote: true as const, transport: 'http' as const, config: ctx.config, sourceId: 'default', logger: ctx.logger,
          auth: { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: 'default' } };
        const call = async (name: string, params: Record<string, unknown>) => {
          const response = await dispatchToolCall(engine, name, { request_id: randomUUID(), ...params }, remote);
          return { isError: response.isError === true, payload: JSON.parse((response.content[0] as { text: string }).text) as Record<string, any> };
        };
        const before = await snapshotItems(engine, 'default');
        const put = await call('put_page', { slug: 'notes/bomb', content: BOMB_6 });
        expect(put.isError).toBe(true);
        expectItemFailure({ key: 'notes/bomb', code: put.payload.code, fix: put.payload.fix }, { key: 'notes/bomb', code: 'invalid_frontmatter' });
        expect(put.payload).toMatchObject({ class: 'caller', reason: 'yaml_parse', retryable: false, message: expect.stringMatching(/alias/),
          suggestion: expect.any(String), fix: { next: expect.any(String), why: expect.any(String) } });
        expect(await stored(engine, 'default', 'notes/bomb')).toBe(false);

        const kept = (await engine.readPageSnapshot('notes/kept', { sourceId: 'default' }))!;
        const edit = await call('edit_page', { slug: 'notes/kept', expected_revision: kept.revision,
          edits: [{ old_text: 'type: note\n', new_text: `type: note\n${aliasBomb(6)}\n` }] });
        expect(edit.isError).toBe(true);
        expectItemFailure({ key: 'notes/kept', code: edit.payload.code }, { key: 'notes/kept', code: 'invalid_frontmatter' });
        expect(edit.payload.message).toMatch(/alias/);

        const sibling = await call('put_page', { slug: 'notes/sibling', content: note('Sibling') });
        expect({ isError: sibling.isError, state: sibling.payload.state }).toEqual({ isError: false, state: 'committed' });
        expectOthersUnchanged(before, await snapshotItems(engine, 'default'), { changed: ['notes/sibling'], expectProgress: ['notes/sibling'] });
        expect(await largestFrontmatter(engine, 'default')).toBeLessThan(10_000);
      }, { databaseUrl });
    }, 120_000);

    test('S-47 item: classic sync holds the bomb file invalid_frontmatter and imports its sibling', async () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-s47-'));
      const root = join(home, 'repo');
      try {
        await withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
          const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
          try {
            await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
            mkdirSync(root);
            commitFixture(root);
            const sourceId = `s47${randomUUID().replace(/-/g, '').slice(0, 12)}`;
            await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
            // concurrency 1: parallel import workers would connect to the configured database, not this isolated one.
            await expectUnitNotAborted(() => performSync(engine, { repoPath: root, sourceId, noPull: true, noEmbed: true, noExtract: true, concurrency: 1 }));
            await expectBombHeld(engine, sourceId);
          } finally { await close(); }
        });
      } finally { rmSync(home, { recursive: true, force: true }); }
    }, 120_000);

    test('S-47 item: managed sync holds the bomb file invalid_frontmatter and imports its sibling', async () => {
      await managedBrain(async ({ engine }) => {
        await expectUnitNotAborted(() => performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true }));
        await expectBombHeld(engine, 'default');
      }, { databaseUrl, setup: ({ root }) => commitFixture(root) });
    }, 120_000);
  });
}
