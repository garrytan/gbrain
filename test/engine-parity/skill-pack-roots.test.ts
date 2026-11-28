/**
 * Shared skill-pack roots and the knowledge guard's and ghost scan's pack reads on every engine (RUST_ENGINE.md ledger row
 * 67): the roots of an adopted pack with and without a claimed worktree, the guard's refusal of a reserved path and its
 * database-only exemptions (a non-member ghost retirement, a non-member tombstone's retention purge), and the ghost scan,
 * which lists a pack member's ghost apart from the rest.
 */
import { expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SharedSkillRevisionWrite } from '../../src/core/engine-sql/shared-skill-members.ts';
import type { RustEngine } from '../../src/core/rust-engine.ts';
import { hostIdFor } from '../../src/core/persistence/identity.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { assertKnowledgePublicationAllowed } from '../../src/core/shared-skills/knowledge-guard.ts';
import { scanGhostSource } from '../../src/core/ghost-pages.ts';
import { GHOST_RETIREMENT_INTENT } from '../../src/core/shared-skills/knowledge-guard.ts';

const { parityTest } = parityArms(testBackends());
const PACK_BODY = '---\nname: notes\ndescription: Take notes.\n---\nTake notes.\n';

/** One revision of skill `notes` in pack `pack` of `sourceId`; `deleted` makes its head a deleted one. */
function packRevision(sourceId: string, incarnation: string, revision: string, deleted: boolean): SharedSkillRevisionWrite {
  const file = { path: 'skills/notes/SKILL.md', file_class: 'prose', audience: ['readers'], media_type: 'text/markdown', size: Buffer.byteLength(PACK_BODY),
    sha256: createHash('sha256').update(PACK_BODY).digest('hex'), depends_on: [], content: Buffer.from(PACK_BODY).toString('base64') };
  return { sourceId, incarnation, packId: 'pack', name: 'notes', revision, deleted, policyEpoch: 'e0000000-0000-4000-8000-0000000000e1',
    requestId: 'e0000000-0000-4000-8000-0000000000e2',
    metadata: { description: 'Take notes.', triggers: [], requirements: [], private: false, audience: ['readers'], writes_pages: false, mutating: false,
      file_policy: [{ file_class: 'prose', audience: ['readers'] }], tools_declared: false },
    files: deleted ? [] : [file] };
}

/**
 * Fixture: store a pack row and its one head for `sourceId`'s current incarnation, as a publication leaves them (no
 * commit is recorded). The SQL arms write under replica role (the publication guard refuses without activation); the
 * Rust arm activates publication in its store (the pack write refuses without it) and writes the same records there.
 */
async function seedPack(engine: BrainEngine, backend: string, sourceId: string, revision: string, deleted = false): Promise<void> {
  const incarnation = (await engine.readSourceMembership(sourceId))!.incarnation;
  const write = packRevision(sourceId, incarnation, revision, deleted);
  const pack = { sourceId, incarnation, packId: 'pack', revision, manifest: { name: 'pack' }, manifestHash: 'h' };
  if (backend === 'rust') {
    const brain = (engine as unknown as RustEngine).openStore('seedPack').brain;
    await brain.activateSharedSkillPublication(false);
    await brain.writeSharedSkillRevision(write);
    await brain.writeSharedSkillPack(pack);
    return;
  }
  await engine.transaction(async (tx) => {
    await tx.executeRaw('SET LOCAL session_replication_role = replica');
    await tx.writeSharedSkillRevision(write);
    await tx.executeRaw('INSERT INTO shared_skill_packs(source_id,source_incarnation,pack_id,revision,manifest,manifest_hash) VALUES($1,$2::uuid,$3,$4::uuid,$5::text::jsonb,$6)',
      [pack.sourceId, pack.incarnation, pack.packId, pack.revision, JSON.stringify(pack.manifest), pack.manifestHash]);
  });
}


/** The guard's answer: `allowed`, or the refusal code. */
async function guard(engine: BrainEngine, row: Record<string, unknown>): Promise<string> {
  try { await assertKnowledgePublicationAllowed(engine as never, row as never); return 'allowed'; }
  catch (e) { return String((e as { code?: string }).code ?? (e as Error).message); }
}

const put = (engine: BrainEngine, slug: string, sourcePath: string) =>
  engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'b', source_path: sourcePath }, { sourceId: 'skill-pack' });

parityTest('an adopted skill pack names its roots, refuses knowledge writes to its reserved paths and parts its ghosts on every engine', {
  methods: ['sharedSkillPackTablePresent', 'listSharedSkillPackRoots', 'hasSharedSkillPack', 'isSharedSkillPackMember', 'readPageFileAliases',
    'getWorktreeBinding', 'readSourceState', 'readSourceMembership'],
  timeout: 240_000,
}, async (engine: BrainEngine, backend) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'skill-pack-roots-')));
  try {
    await createSource(engine, backend, 'skill-pack', {}, dir);
    await seedPack(engine, backend, 'skill-pack', 'e0000000-0000-4000-8000-0000000000a1');
    // Discriminators: a source with no pack, and a source whose pack's only head is deleted (a pack row, no member).
    await createSource(engine, backend, 'no-pack', {});
    await createSource(engine, backend, 'deleted-pack', {});
    await seedPack(engine, backend, 'deleted-pack', 'e0000000-0000-4000-8000-0000000000a2', true);
    const incarnation = (await engine.readSourceMembership('skill-pack'))!.incarnation;
    const deletedIncarnation = (await engine.readSourceMembership('deleted-pack'))!.incarnation;
    const host = hostIdFor(engine);
    const scrub = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(incarnation, '<inc>').replaceAll(deletedIncarnation, '<inc2>').replaceAll(host, '<host>').replaceAll(dir, '<dir>'));
    const byId = <T extends { source_id: string }>(rows: T[]) => [...rows].sort((a, b) => a.source_id.localeCompare(b.source_id));
    const rootsBefore = byId(await engine.listSharedSkillPackRoots(host));
    expect(scrub(rootsBefore)).toEqual([
      { source_id: 'deleted-pack', source_incarnation: '<inc2>', source_root: null, worktree_root: null, relative_path: null },
      { source_id: 'skill-pack', source_incarnation: '<inc>', source_root: '<dir>', worktree_root: null, relative_path: null },
    ]);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir });
    git('init', '-q'); writeFileSync(join(dir, 'keep.md'), 'x\n'); git('add', '-A'); git('commit', '-q', '-m', 'k');
    await put(engine, 'skills/notes/skill', 'skills/notes/SKILL.md');
    await put(engine, 'skills/other/skill', 'skills/other/SKILL.md');
    await claimWorktree(engine, 'skill-pack', dir);
    const rootsAfter = byId(await engine.listSharedSkillPackRoots(host)).filter(r => r.source_id === 'skill-pack');
    expect(scrub(rootsAfter)).toEqual([{ source_id: 'skill-pack', source_incarnation: '<inc>', source_root: '<dir>', worktree_root: '<dir>', relative_path: '' }]);
    const adoption = {
      packSource: await engine.hasSharedSkillPack('skill-pack', incarnation),
      deletedPack: await engine.hasSharedSkillPack('deleted-pack', deletedIncarnation),
      noPack: await engine.hasSharedSkillPack('no-pack', incarnation),
      staleIncarnation: await engine.hasSharedSkillPack('skill-pack', deletedIncarnation),
    };
    expect(adoption).toEqual({ packSource: true, deletedPack: true, noPack: false, staleIncarnation: false });
    const member = (paths: string[], source = 'skill-pack', inc = incarnation) => engine.isSharedSkillPackMember(source, inc, paths);
    const membership = {
      file: await member(['skills/notes/SKILL.md']),
      underSkill: await member(['skills/notes/extra.md']),
      otherSkill: await member(['skills/other/SKILL.md']),
      plain: await member(['notes/plain.md']),
      mixed: await member(['notes/plain.md', 'skills/notes/x.md']),
      deletedHead: await member(['skills/notes/SKILL.md'], 'deleted-pack', deletedIncarnation),
      noPack: await member(['skills/notes/SKILL.md'], 'no-pack', incarnation),
    };
    expect(membership).toEqual({ file: true, underSkill: true, otherSkill: false, plain: false, mixed: true, deletedHead: false, noPack: false });
    const target = { source_id: 'skill-pack', source_incarnation: incarnation, target_kind: 'page', operation: 'put_page' };
    const guards = {
      reserved: await guard(engine, { ...target, slug: 'skills/notes/extra' }),
      plain: await guard(engine, { ...target, slug: 'notes/plain' }),
      retireMemberGhost: await guard(engine, { ...target, slug: 'skills/notes/skill', operation: 'delete_page',
        intent: { kind: GHOST_RETIREMENT_INTENT, ghost: { path: 'skills/notes/SKILL.md' } } }),
      retireOtherGhost: await guard(engine, { ...target, slug: 'skills/other/skill', operation: 'delete_page',
        intent: { kind: GHOST_RETIREMENT_INTENT, ghost: { path: 'skills/other/SKILL.md' } } }),
    };
    expect(guards).toEqual({ reserved: 'skill_bundle_required', plain: 'allowed', retireMemberGhost: 'skill_bundle_required', retireOtherGhost: 'allowed' });
    const scan = await scanGhostSource(engine, 'skill-pack');
    const ghosts = { status: scan.status, ghosts: scan.ghosts.map(g => g.slug), skill_paths: scan.skill_paths.map(g => g.slug) };
    expect(ghosts).toEqual({ status: expect.any(String), ghosts: ['skills/other/skill'], skill_paths: ['skills/notes/skill'] });
    return scrub({ rootsBefore, rootsAfter, adoption, membership, guards, ghosts });
  } finally {
    await disposePersistenceConsumer(engine);
    rmSync(dir, { recursive: true, force: true });
  }
});

parityTest('a page\'s file aliases and tombstone read the same on every engine, and the guard lets a non-member tombstone\'s retention purge pass', {
  methods: ['readPageFileAliases', 'readPageTombstoneSourcePath', 'isSharedSkillPackMember', 'listSharedSkillPackRoots', 'softDeletePage', 'readSourceMembership'],
  timeout: 240_000,
}, async (engine: BrainEngine, backend) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'skill-pack-tomb-')));
  try {
    await createSource(engine, backend, 'skill-pack', {}, dir);
    await seedPack(engine, backend, 'skill-pack', 'e0000000-0000-4000-8000-0000000000a1');
    const incarnation = (await engine.readSourceMembership('skill-pack'))!.incarnation;
    await put(engine, 'skills/notes/skill', 'skills/notes/SKILL.md');
    await put(engine, 'skills/legacy/skill', 'skills/legacy/SKILL.md');
    await put(engine, 'notes/live', 'notes/live.md');
    await engine.softDeletePage('skills/notes/skill', { sourceId: 'skill-pack' });
    await engine.softDeletePage('skills/legacy/skill', { sourceId: 'skill-pack' });
    const reads = {} as Record<string, unknown>;
    for (const slug of ['skills/notes/skill', 'skills/legacy/skill', 'notes/live', 'notes/absent'])
      reads[slug] = { aliases: await engine.readPageFileAliases('skill-pack', slug), tombstone: await engine.readPageTombstoneSourcePath('skill-pack', slug) };
    expect(reads).toEqual({
      'skills/notes/skill': { aliases: [{ source_path: 'skills/notes/SKILL.md', source_uri: null }], tombstone: { source_path: 'skills/notes/SKILL.md' } },
      'skills/legacy/skill': { aliases: [{ source_path: 'skills/legacy/SKILL.md', source_uri: null }], tombstone: { source_path: 'skills/legacy/SKILL.md' } },
      'notes/live': { aliases: [{ source_path: 'notes/live.md', source_uri: null }], tombstone: null },
      'notes/absent': { aliases: [], tombstone: null },
    });
    const purge = (slug: string) => guard(engine, { source_id: 'skill-pack', source_incarnation: incarnation, target_kind: 'page', operation: 'delete_page', slug,
      intent: { purge: true, retention: true } });
    const purges = { member: await purge('skills/notes/skill'), nonMember: await purge('skills/legacy/skill'), plain: await purge('notes/live') };
    expect(purges).toEqual({ member: 'skill_bundle_required', nonMember: 'allowed', plain: 'allowed' });
    return { reads, purges };
  } finally {
    await disposePersistenceConsumer(engine);
    rmSync(dir, { recursive: true, force: true });
  }
});
