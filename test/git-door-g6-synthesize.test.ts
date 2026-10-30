/**
 * G6 (git-canonical memory): the dream synthesis writers on a strict source.
 *
 *   - synthesize_concepts (synthesize-concepts.ts runPhaseSynthesizeConcepts): on a managed brain it publishes each concept
 *     through publishManagedConcept (concept-publication.ts), private first and then world once the provenance edges land;
 *     a world concept whose banked edges already cover every member publishes once, at world (GBRA-60), so no private
 *     intermediate is committed. A new concept publishes database-only (`file: false`) under the derive-phase folder
 *     `concepts/`, a declared database-only class (DERIVE_PHASE_DB_ONLY_DEFAULTS); a concept that already has a file
 *     republishes it.
 *   - synthesize quote-verify repair: verifyAndRepairDreamPages (synthesize-verify.ts) is the unmanaged branch only; a
 *     managed brain's oneshot child verifies and stamps each page before it writes them as one put_pages batch
 *     (synthesize-child-verify.ts, GBRA-60), and postprocessManagedSynthesis (synthesize-postprocess.ts) then has nothing
 *     to publish. Driven here through the whole synthesize phase with a stubbed provider whose oneshot child writes three
 *     reflection pages, each carrying an invented quotation the repair must strip.
 *
 * Target for each batch (test/helpers/strict-door-audit.ts): every filed page at HEAD with the content its row holds, a
 * clean tree, no git-gap census gap, and at most one commit per publication group. Runs on PGLite, and on Postgres
 * through test/e2e/git-door-g6-synthesize-postgres.test.ts. Synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { runPhaseSynthesizeConcepts } from '../src/core/cycle/synthesize-concepts.ts';
import { runPhaseSynthesize } from '../src/core/cycle/synthesize.ts';
import { isNeverFiledDerivedPage } from '../src/core/persistence/git-declared.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { durableGitRepo, gitAsync } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { auditDoor, expectDoorTarget, headCommit, strictSource, summarizeAudit, type DoorAudit } from './helpers/strict-door-audit.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const put = (ctx: OperationContext, slug: string, content: string) => submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content } });
const NO_GAP = { database_ahead: 0, worktree_only: 0, undeclared_database_only: 0 };

/** What each batch commit put in Git for one probe per path: the intermediate states history keeps after the batch. */
const commitProbe = async <T>(root: string, audit: DoorAudit, probe: (blob: string) => T) =>
  Promise.all(audit.commits.flatMap(commit => commit.paths.map(async path => ({ sha: commit.sha.slice(0, 8), path, probe: probe(await gitAsync(root, 'show', `${commit.sha}:${path}`).catch(() => '')) }))));

/** Three concept groups: one T2 (five atoms, LLM narrative) and two T3 (two atoms each, deterministic narrative). */
const GROUPS: Record<string, number> = { 'flywheels-example': 5, 'moats-example': 2, 'network-effects-example': 2 };
const CONCEPTS = Object.keys(GROUPS).map(stem => `concepts/${stem}`);
const ATOMS = Object.entries(GROUPS).flatMap(([stem, n]) => Array.from({ length: n }, (_, i) => ({ stem, slug: `atoms/2026-10-01/${stem}-${i + 1}`, i })));
const atomPage = (stem: string, i: number) => `---\ntype: atom\ntitle: ${stem} ${i + 1}\nvisibility: world\nconcepts: [${stem}]\n---\n\nAtom ${i + 1} about ${stem.replace(/-/g, ' ')}, from source-a.\n`;

/** The synthesis model stub (as test/cycle/extract-atoms-synthesize-concepts.test.ts stubs `_chat`); records each prompt's first line. */
const conceptChat = () => {
  const calls: string[] = [];
  const chat = async (o: ChatOpts): Promise<ChatResult> => {
    calls.push(String(o.messages?.[0]?.content ?? '').split('\n')[0]!);
    const text = 'Flywheels compound when each turn makes the next one cheaper, as the member atoms from source-a describe.';
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
      usage: { input_tokens: 500, output_tokens: 200, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' };
  };
  return { calls, chat };
};

async function seedAtoms(ctx: OperationContext) {
  for (const atom of ATOMS) await put(ctx, atom.slug, atomPage(atom.stem, atom.i));
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`[${backend}] G6: synthesize_concepts on a strict source writes only through the door`, () => {
    test('three new concepts: declared database-only, clean, no census gap, no commit under concepts/', () => managedBrain(async ({ engine, ctx, root }) => {
      await strictSource(engine);
      await seedAtoms(ctx);
      await settleManagedGitEffects(engine);
      const baseline = await auditDoor(engine, root, { since: await headCommit(root), slugs: ATOMS.map(a => a.slug) });
      expect({ porcelain: baseline.porcelain, gaps: baseline.gaps }).toEqual({ porcelain: '', gaps: NO_GAP });
      expect(baseline.pages.map(page => [page.slug, page.row?.state])).toEqual(ATOMS.map(a => [a.slug, 'equal']));
      const since = await headCommit(root);
      const { calls, chat } = conceptChat();
      const result = await runPhaseSynthesizeConcepts(engine, { sourceId: 'default', brainDir: root, _chat: chat });
      expect(result.status).toBe('ok');
      expect(result.details?.concepts_written).toBe(3);
      expect(calls).toEqual(['Concept slug: flywheels-example']);
      for (const slug of CONCEPTS) {
        const page = await engine.getPage(slug, { sourceId: 'default' });
        expect({ slug, by: page?.frontmatter?.synthesized_by, visibility: page?.frontmatter?.visibility })
          .toEqual({ slug, by: 'synthesize_concepts-v0.41', visibility: 'world' });
      }
      await settleManagedGitEffects(engine);
      const audit = await auditDoor(engine, root, { since, slugs: CONCEPTS });
      console.log(summarizeAudit(`synthesize_concepts new ${backend}`, audit));
      // A never-filed concept is the declared derive-phase class (git-gap.ts declaredDatabaseOnly 'derive_folder'): no
      // file is its target, so the page half of expectDoorTarget does not apply; the tree, census and commits do.
      expect(audit.porcelain).toBe('');
      expect({ gaps: audit.gaps, sample: audit.gapSample }).toEqual({ gaps: NO_GAP, sample: [] });
      expect(audit.census.declared.derive_folder).toBeGreaterThanOrEqual(CONCEPTS.length);
      expect(audit.pages.map(page => ({ slug: page.slug, head: page.head, worktree: page.worktree }))).toEqual(CONCEPTS.map(slug => ({ slug, head: null, worktree: null })));
      expect(audit.commits.filter(commit => commit.paths.some(path => path.startsWith('concepts/')))).toEqual([]);
    }, { databaseUrl, setup }), 180_000);

    /**
     * Three file-backed world concepts a prior run wrote, republished. `banked`: the prior run's provenance edges cover
     * every member, so each concept publishes once, at world. Without them the #5525 private step comes first.
     */
    const republish = ({ banked }: { banked: boolean }) => managedBrain(async ({ engine, ctx, root }) => {
      await strictSource(engine);
      await seedAtoms(ctx);
      for (const slug of CONCEPTS) {
        await put(ctx, slug, `---\ntype: concept\ntitle: ${slug.split('/')[1]}\nsynthesized_by: synthesize_concepts-v0.41\nsynthesis_mode: llm\nmember_hash: stale-example\nvisibility: world\n---\n\nAn older narrative from source-a.\n`);
      }
      if (banked) {
        await engine.addLinksBatch(ATOMS.map(atom => ({ from_slug: `concepts/${atom.stem}`, to_slug: atom.slug, link_type: 'synthesized_from',
          link_source: 'concept-provenance', context: 'member atom', from_source_id: 'default', to_source_id: 'default' })));
      }
      await settleManagedGitEffects(engine);
      const seeded = [...ATOMS.map(a => a.slug), ...CONCEPTS];
      const baseline = await auditDoor(engine, root, { since: await headCommit(root), slugs: seeded });
      expect({ porcelain: baseline.porcelain, gaps: baseline.gaps }).toEqual({ porcelain: '', gaps: NO_GAP });
      expect(baseline.pages.map(page => [page.slug, page.row?.state])).toEqual(seeded.map(slug => [slug, 'equal']));
      const since = await headCommit(root);
      const { calls, chat } = conceptChat();
      const result = await runPhaseSynthesizeConcepts(engine, { sourceId: 'default', brainDir: root, _chat: chat });
      expect(result.status).toBe('ok');
      expect(result.details?.concepts_written).toBe(3);
      expect(calls).toEqual(['Concept slug: flywheels-example']);
      for (const slug of CONCEPTS) {
        const page = await engine.getPage(slug, { sourceId: 'default' });
        expect({ slug, stale: page?.frontmatter?.member_hash === 'stale-example', visibility: page?.frontmatter?.visibility, old: page?.compiled_truth.includes('An older narrative') })
          .toEqual({ slug, stale: false, visibility: 'world', old: false });
      }
      await settleManagedGitEffects(engine);
      const audit = await auditDoor(engine, root, { since, slugs: CONCEPTS });
      console.log(summarizeAudit(`synthesize_concepts republish ${backend}`, audit));
      const probes = await commitProbe(root, audit, blob => /^visibility: (\w+)/m.exec(blob)?.[1] ?? null);
      console.log(`[g6-measure] synthesize_concepts republish (${banked ? 'banked' : 'no'} edges) commits ${backend}: ${JSON.stringify(probes)}`);
      if (banked) {
        // GBRA-176: private content is never committed, so no commit in the batch holds a private concept.
        expect(probes.filter(probe => probe.probe !== 'world')).toEqual([]);
        expectDoorTarget(audit, engine.kind);
        return;
      }
      // GBRA-176 option (a): the #5525 private step is G7a's visibility transition, a door commit per publication group
      // that removes each file, so no commit holds the uncovered narrative. Once the edges are banked the world promotion
      // commits the file again at the path the transition recorded (GBRA-95), so Git ends up holding the world page.
      for (const path of CONCEPTS.map(slug => `${slug}.md`)) {
        expect({ path, history: probes.filter(probe => probe.path === path).map(probe => probe.probe) }).toEqual({ path, history: [null, 'world'] });
      }
      const patch = await gitAsync(root, 'log', '-p', `${since}..HEAD`, '--', 'concepts/');
      expect(patch.split('\n').filter(line => line.startsWith('+') && /visibility: (?!world)/.test(line))).toEqual([]);
      for (const page of audit.pages) {
        expect({ slug: page.slug, atHead: page.head !== null, worktree: page.worktree === page.head, row: page.row })
          .toEqual({ slug: page.slug, atHead: true, worktree: true, row: { state: 'equal' } });
        const [row] = await engine.executeRaw<{ source_path: string | null; source_uri: string | null }>(
          'SELECT source_path, source_uri FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', ['default', page.slug]);
        expect({ slug: page.slug, source_path: row?.source_path, never_filed: isNeverFiledDerivedPage(page.slug, row ?? {}) })
          .toEqual({ slug: page.slug, source_path: page.path, never_filed: false });
      }
      expect(audit.porcelain).toBe('');
      expect({ gaps: audit.gaps, sample: audit.gapSample }).toEqual({ gaps: NO_GAP, sample: [] });
      expect({ declared_database_only: audit.census.states.declared_database_only, derive_folder: audit.census.declared.derive_folder })
        .toEqual({ declared_database_only: 0, derive_folder: 0 });
      const batchPaths = new Set(audit.pages.map(page => page.path));
      expect(audit.commits.filter(commit => commit.paths.some(path => batchPaths.has(path))).length).toBe(engine.kind === 'postgres' ? 2 : 2 * CONCEPTS.length);
    }, { databaseUrl, setup });

    test('three file-backed concepts with banked provenance edges republished once at world: at HEAD, clean, no census gap, one commit per group',
      () => republish({ banked: true }), 180_000);

    // GBRA-60/GBRA-95/GBRA-176: a file-backed world concept whose edges do not yet cover its members takes the #5525 private
    // step, G7a's visibility transition (a door commit that removes the file and clears source_path/source_uri); its world
    // promotion restores the file at the path the transition recorded (pages.withheld_source_path, #7586).
    test('three file-backed concepts without provenance edges republished: the private step removes the file, the world promotion restores it',
      () => republish({ banked: false }), 180_000);
  });

  describe(`[${backend}] G6: synthesize postprocess (managed quote-verify repair) on a strict source writes only through the door`, () => {
    beforeAll(() => configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} }));
    afterAll(() => { __setChatTransportForTests(null); resetGateway(); });

    test('three child-written reflections repaired and stamped: at HEAD, clean, no census gap, one commit per group', () => managedBrain(async ({ engine, ctx, root }) => {
      await strictSource(engine);
      await put(ctx, 'people/example', '---\ntitle: Example\ntype: note\n---\nExample evidence.\n');
      await settleManagedGitEffects(engine);
      const inputs = join(root, '..', 'inputs'); mkdirSync(inputs);
      const inputFile = join(inputs, '2026-09-20-session.txt');
      const quote = 'we charge for durability because reliable memories should survive every tool';
      writeFileSync(inputFile, `User: ${quote}.\n${'Assistant: Discuss the long term roadmap.\n'.repeat(15)}`);
      for (const [key, value] of Object.entries({
        'dream.synthesize.enabled': 'true', 'dream.synthesize.cooldown_hours': '0',
        'dream.synthesize.min_chars': '100', 'dream.synthesize.link_manifest': 'false',
        'dream.synthesize.mode': 'oneshot', 'dream.synthesize.quote_verify': 'true',
        'models.dream.synthesize': 'anthropic:claude-sonnet-4-6', 'models.dream.triage': 'anthropic:claude-sonnet-4-6',
      })) await engine.setConfig(key, value);
      // The provider stub of test/helpers/managed-synthesis-fixture.ts: triage scores the transcript 0.9 and the oneshot
      // child writes three reflections, each with an invented quotation quote-verify must strip.
      let calls = 0;
      __setChatTransportForTests(async opts => {
        calls++;
        const hash = /hash suffix \(USE THIS in slugs\): ([a-z0-9-]+)/i.exec(String(opts.messages?.[0]?.content ?? ''))?.[1] ?? 'missing';
        const text = (opts.system ?? '').startsWith('You triage a conversation transcript')
          ? JSON.stringify({ score: 0.9, content_type: 'reflection', segments: [{ quote, note: 'evidence' }], entities: [], reasons: ['durable insight'] })
          : JSON.stringify({ pages: Array.from({ length: 3 }, (_, i) => ({
            slug: `wiki/personal/reflections/session${i ? `-${i}` : ''}-${hash}`, title: `Session ${i}`, type: 'note',
            body: `A memory strategy with [[people/example]]. Evidence item ${i}. Allegedly: "an entirely invented quotation that should lose its marks".`,
          })), skipped: false });
        return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
          usage: { input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: opts.model!, providerId: 'anthropic' };
      });
      const baseline = await auditDoor(engine, root, { since: await headCommit(root), slugs: ['people/example'] });
      expect({ porcelain: baseline.porcelain, gaps: baseline.gaps }).toEqual({ porcelain: '', gaps: NO_GAP });
      const since = await headCommit(root);
      const result = await withEnv({ ANTHROPIC_API_KEY: 'sk-test-synthesis' }, () =>
        runPhaseSynthesize(engine, { brainDir: root, sourceId: 'default', dryRun: false, inputFile, date: '2026-09-20' }));
      expect(result.status).toBe('ok');
      expect(calls).toBe(2);
      const outputs = (result.details.written_slugs as string[]).slice().sort();
      expect(outputs).toHaveLength(3);
      expect((result.details.synthesis as { quote_verify: { pages_repaired: number } }).quote_verify.pages_repaired).toBe(3);
      for (const slug of outputs) {
        const page = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.page;
        expect({ slug, stamped: page.frontmatter.dream_generated, invented: page.compiled_truth.includes('"an entirely invented') })
          .toEqual({ slug, stamped: true, invented: false });
      }
      await settleManagedGitEffects(engine);
      const audit = await auditDoor(engine, root, { since, slugs: outputs });
      console.log(summarizeAudit(`synthesize postprocess ${backend}`, audit));
      const probes = await commitProbe(root, audit, blob => ({ invented_quote_in_body: blob.slice(blob.indexOf('\n---\n', 3) + 5).includes('"an entirely invented'), dream_generated: /^dream_generated: true/m.test(blob) }));
      console.log(`[g6-measure] synthesize postprocess commits ${backend}: ${JSON.stringify(probes)}`);
      console.log(summarizeAudit(`synthesize summary ${backend}`, await auditDoor(engine, root, { since, slugs: [String(result.details.summary_slug)] })));
      // GBRA-60: the child verifies and stamps before its put_page, so each output is committed once, verified and
      // stamped, and the invented quotation never reaches Git history except as its `unverified_claims` review record.
      expect(audit.pages.map(page => ({ slug: page.slug, commits: page.commits }))).toEqual(outputs.map(slug => ({ slug, commits: 1 })));
      const outputPaths = new Set(audit.pages.map(page => page.path));
      expect(probes.filter(p => outputPaths.has(p.path) && (p.probe.invented_quote_in_body || !p.probe.dream_generated))).toEqual([]);
      for (const page of audit.pages) {
        const added = (await gitAsync(root, 'log', '-p', `${since}..HEAD`, '--', page.path)).split('\n')
          .filter(line => line.startsWith('+') && line.includes('"an entirely invented') && !/^\+\s+- text: /.test(line));
        expect({ path: page.path, added }).toEqual({ path: page.path, added: [] });
      }
      expectDoorTarget(audit, engine.kind);
    }, { databaseUrl, setup }), 180_000);
  });
}
