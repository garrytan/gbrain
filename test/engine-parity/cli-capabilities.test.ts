/**
 * BrainEngine parity — the source, config and tag members a Rust brain serves for the CLI and import.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: getSourceStrictness answers alone (the import-path case pairs it with readManagedModeRows), and the tag
 *    claims import relies on — addTag with tagSource 'frontmatter', an explicit addTag, removeTag and
 *    pruneFrontmatterTags — give the same tags on every engine arm.
 *  - Regression: an engine that lets a frontmatter claim take over an explicitly added tag (so an import prune deletes
 *    a tag the user added), keeps a stale claim after removeTag, or reads a non-string `canonical` as strict.
 *  - Why existing coverage misses it: import-writes covers addPageTagsById claims but not addTag's tagSource option or
 *    a remove-then-add; the strictness case stops wherever readManagedModeRows is not served.
 *  - Seam: none. Real engines, typed methods only; sources come from the harness createSource fixture.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const NOTE = { type: 'note' as const, title: 'Tags', compiled_truth: 'Body.', timeline: '' };

describe('engine parity: CLI source, config and tag members', () => {
  parityTest('getSourceStrictness is true only for a source whose canonical is the string git', { methods: ['getSourceStrictness'] }, async (engine, backend) => {
    await createSource(engine, backend, 'strict', { canonical: 'git' });
    await createSource(engine, backend, 'loose', { canonical: 'database' });
    await createSource(engine, backend, 'flag', { canonical: true });
    const strictness = {
      strict: await engine.getSourceStrictness('strict'),
      loose: await engine.getSourceStrictness('loose'),
      flag: await engine.getSourceStrictness('flag'),
      default: await engine.getSourceStrictness('default'),
      unknown: await engine.getSourceStrictness('no-such-source'),
    };
    expect(strictness).toEqual({ strict: true, loose: false, flag: false, default: false, unknown: false });
    return strictness;
  });

  parityTest(
    'addTag with tagSource frontmatter claims a new tag only; a prune keeps explicit and re-added tags',
    { methods: ['putPage', 'addTag', 'removeTag', 'pruneFrontmatterTags', 'getTags'] },
    async (engine) => {
      await engine.putPage('notes/claims', NOTE);
      await engine.addTag('notes/claims', 'explicit');
      await engine.addTag('notes/claims', 'explicit', { tagSource: 'frontmatter' });
      await engine.addTag('notes/claims', 'taken-over', { tagSource: 'frontmatter' });
      await engine.addTag('notes/claims', 'taken-over');
      await engine.addTag('notes/claims', 'owned', { tagSource: 'frontmatter' });
      await engine.addTag('notes/claims', 'kept', { tagSource: 'frontmatter' });
      await engine.addTag('notes/claims', 're-added', { tagSource: 'frontmatter' });
      await engine.removeTag('notes/claims', 're-added');
      await engine.addTag('notes/claims', 're-added');
      const before = await engine.getTags('notes/claims');
      await engine.pruneFrontmatterTags('notes/claims', ['kept']);
      const pruned = await engine.getTags('notes/claims');
      expect(pruned).toEqual(['explicit', 'kept', 're-added', 'taken-over']);
      await engine.pruneFrontmatterTags('notes/missing', []);
      return { before, pruned };
    },
  );
});
