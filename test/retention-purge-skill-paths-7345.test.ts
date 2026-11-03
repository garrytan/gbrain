/**
 * #7345: the retention purge (`gbrain pages purge-deleted`, the dream/cycle purge phase) on a source with an adopted shared
 * skillpack.
 *
 * Before the fix the knowledge guard refused the hard delete of every soft-deleted page under `skills/`
 * (`skill_bundle_required`, `class: caller`), so such a tombstone parked forever even when no pack skill owned its path.
 * #6910 exempted only the ghost retirement. Protects: an expired tombstone under `skills/` that is not a pack member and
 * has no file is removed database-only like any other tombstone, with no pack file change; a tombstone on a pack member's
 * path stays refused; a non-member tombstone whose file is still on disk (the purge would remove a file under the pack
 * root) stays refused; and the retention exemption needs a soft-deleted page and the retention purge itself. Every case
 * drives a real PGLite brain with a claimed canonical worktree and a really adopted pack.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { adoptSharedSkillpack } from '../src/core/shared-skills/publication.ts';
import { setSharedSkillPolicy } from '../src/core/shared-skills/policy.ts';
import { assertKnowledgePublicationAllowed } from '../src/core/shared-skills/knowledge-guard.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';

const logger = { info() {}, warn() {}, error() {} };
const SOURCE = 'default';
/** A legacy knowledge page under skills/ that no live pack skill owns; soft-deleted and its file gone. */
const LEGACY = 'skills/legacy-skill/notes';
/** A knowledge page under the live pack skill alpha's directory: a pack member path. */
const MEMBER = 'skills/alpha/references/old';
/** A legacy non-member page under skills/ whose file is still in the checkout after the soft delete. */
const ON_DISK = 'skills/legacy-skill/kept-file';
/** A live (never deleted) non-member page under skills/. */
const LIVE = 'skills/legacy-skill/live';
const ORDINARY = 'notes/a';
const SKILL_FILE = 'skills/alpha/SKILL.md';
const SKILL_TEXT = '---\nname: alpha\ndescription: A synthetic shared skill\n---\n\nApproved instructions.\n';

interface Fixture { engine: BrainEngine; root: string; incarnation: string }

/**
 * Four file-backed pages (two non-member pages under skills/, one under the pack skill's directory, one ordinary page) are
 * soft-deleted and one more non-member page under skills/ stays live; then the shared skillpack is adopted on the source (pack root = source root). Every deleted page's file is
 * gone except ON_DISK's.
 */
async function fixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'gbrain-retention-skills-'));
  try {
    await withEnv({ GBRAIN_HOME: join(scratch, 'home'), DATABASE_URL: undefined }, async () => {
      const isolated = await isolatedSharedSkillsEngine();
      const engine = isolated.engine;
      try {
        const root = join(scratch, 'brain'); mkdirSync(root);
        execFileSync('git', ['init', '-q'], { cwd: root });
        writeFileSync(join(root, 'skillpack.json'), JSON.stringify({ api_version: 'gbrain-skillpack-v1', name: 'example-pack', version: '1.0.0',
          description: 'Synthetic fixture', author: 'Example Maintainer', license: 'MIT', homepage: 'https://example.com/skills',
          gbrain_min_version: '0.51.0', brain_resident: true, skills: ['skills/alpha'] }));
        await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, SOURCE]);
        for (const slug of [LEGACY, MEMBER, ON_DISK, ORDINARY]) {
          await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body.` }, { sourceId: SOURCE });
          await engine.executeRaw('UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2', [SOURCE, slug, `${slug}.md`]);
          await engine.softDeletePage(slug, { sourceId: SOURCE });
        }
        await engine.putPage(LIVE, { type: 'note', title: LIVE, compiled_truth: 'Live body.' }, { sourceId: SOURCE });
        const kept = (await engine.readPageSnapshot(ON_DISK, { sourceId: SOURCE, includeDeleted: true }))!;
        mkdirSync(dirname(join(root, `${ON_DISK}.md`)), { recursive: true });
        writeFileSync(join(root, `${ON_DISK}.md`), serializePageToMarkdown(kept.page, kept.tags));
        await claimWorktree(engine, SOURCE, root);
        await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
        const ctx: OperationContext = { engine, config: { engine: engine.kind }, remote: false, sourceId: SOURCE, dryRun: false, logger };
        await engine.setConfig('mcp.publish_skills', 'true');
        await setSharedSkillPolicy(ctx, SOURCE, { version: 1, enabled: true, classes: ['prose'], audiences: ['readers'], requirements: [], allow_follow: true }, null);
        const adopted = await adoptSharedSkillpack(ctx, SOURCE, { request_id: randomUUID(), pack_id: 'example-pack', skills: [
          { pack_id: 'example-pack', name: 'alpha', expected_revision: null, files: [
            { path: SKILL_FILE, content: SKILL_TEXT, file_class: 'prose' },
          ] },
        ] });
        expect(adopted.receipts[0].state).toBe('committed');
        const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [SOURCE]);
        await run({ engine, root, incarnation: source!.incarnation });
      } finally { await disposePersistenceConsumer(engine); await isolated.close(); }
    });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

const present = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ n: number }>(
  'SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, slug]))[0]!.n === 1;

describe('#7345 retention purge of tombstones under the shared skillpack', () => {
  test('an expired non-member tombstone under skills/ is purged database-only; a pack member or a tombstone with a file on disk stays refused', () => fixture(async f => {
    const result = await purgeDeletedPagesCoordinated(f.engine, 0);
    expect([...result.slugs].sort()).toEqual([ORDINARY, LEGACY].sort());
    expect(result.blocked.map(b => [b.slug, b.code]).sort()).toEqual([[MEMBER, 'skill_bundle_required'], [ON_DISK, 'skill_bundle_required']]);
    expect(await present(f.engine, LEGACY)).toBe(false);
    expect(await present(f.engine, ORDINARY)).toBe(false);
    expect(await present(f.engine, MEMBER)).toBe(true);
    expect(await present(f.engine, ON_DISK)).toBe(true);
    expect(readFileSync(join(f.root, SKILL_FILE), 'utf8')).toBe(SKILL_TEXT);
    expect(existsSync(join(f.root, `${ON_DISK}.md`))).toBe(true);
    expect(existsSync(join(f.root, `${LEGACY}.md`))).toBe(false);

    const parked = await purgeDeletedPagesCoordinated(f.engine, 0, { retryParked: true });
    expect(parked.slugs).toEqual([]);
    expect(await present(f.engine, MEMBER)).toBe(true);
  }), 120_000);

  test('the knowledge guard admits only the retention purge of a soft-deleted non-member page that expects no bytes', () => fixture(async f => {
    const row = (slug: string, extra: Record<string, unknown> = {}) => ({ source_id: SOURCE, source_incarnation: f.incarnation, slug, target_kind: 'page' as const,
      operation: 'delete_page', intent: { slug, purge: true, retention: true }, ...extra });
    await expect(assertKnowledgePublicationAllowed(f.engine, row(LEGACY))).resolves.toBeUndefined();
    await expect(assertKnowledgePublicationAllowed(f.engine, row(LEGACY), { root: f.root, path: join(f.root, `${LEGACY}.md`), expectedBeforeHash: null })).resolves.toBeUndefined();
    await expect(assertKnowledgePublicationAllowed(f.engine, row(LEGACY), { root: f.root, path: join(f.root, `${LEGACY}.md`), expectedBeforeHash: 'a'.repeat(64) }))
      .rejects.toMatchObject({ code: 'skill_bundle_required' });
    await expect(assertKnowledgePublicationAllowed(f.engine, row(MEMBER))).rejects.toMatchObject({ code: 'skill_bundle_required' });
    await expect(assertKnowledgePublicationAllowed(f.engine, row(LEGACY, { intent: { slug: LEGACY, purge: true } }))).rejects.toMatchObject({ code: 'skill_bundle_required' });
    await expect(assertKnowledgePublicationAllowed(f.engine, row(LEGACY, { operation: 'put_page' }))).rejects.toMatchObject({ code: 'skill_bundle_required' });
    await expect(assertKnowledgePublicationAllowed(f.engine, row(LEGACY, { operation: undefined }))).rejects.toMatchObject({ code: 'skill_bundle_required' });
    await expect(assertKnowledgePublicationAllowed(f.engine, row(LIVE))).rejects.toMatchObject({ code: 'skill_bundle_required' });
  }), 120_000);
});
