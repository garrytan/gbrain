/**
 * BrainEngine parity: the attendance lookup of frontmatter link extraction (`listAttendanceMatches`, SQL in
 * engine-sql/attendance-pages.ts), which src/core/link-extraction.ts `makeResolver().resolveAttendance` used to run
 * through `engine.executeRaw`. A meeting page's `attendees` frontmatter resolves through it when the page is saved.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: an attendee name resolves to the one live `person` page of the source whose slug is the name (or the
 *    name's slug form under the field's folder), whose title is the name under `lower()`, or whose frontmatter `aliases`
 *    holds the name under `lower()`. Two such pages leave the name unresolved, and so do a soft-deleted person, a page of
 *    another type, a person of another source and a non-array `aliases`. The meeting's extracted attendance edges and
 *    unresolved names are the same on every arm. Each case asserts the exact answer, so one arm alone also checks it.
 *  - Regression: an engine that refuses the lookup as raw SQL (the Rust engine did, so saving a meeting with attendees
 *    refused), compares case-sensitively, resolves an ambiguous name to one of its pages, or matches deleted, non-person
 *    or other-source pages, writes wrong attendance edges.
 *  - Why existing coverage misses it: test/attendance-*.test.ts run on PGLite only or stub the statement.
 *  - Order: ASCII names only, so `lower()` agrees on every database collation.
 *  - Seam: none. The real resolver and frontmatter extraction over the typed member.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import { extractPageLinks, makeResolver } from '../../src/core/link-extraction.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { createSource, parityArms } from './harness.ts';

const { parityTest } = parityArms(testBackends());

const page = (type: string, title: string, frontmatter: Record<string, unknown> = {}): PageInput =>
  ({ type: type as never, title, compiled_truth: `${title} notes`, timeline: '', frontmatter });

const ATTENDEES = [
  'people/alice-example', // the exact slug
  'Alice Example', // the slug form under the attendees folder
  'CAROL example', // a title under lower()
  'bobby', // an alias under lower()
  'Sam Example', // two person pages hold this title
  'Dana Example', // a soft-deleted person
  'Erin Example', // a note, not a person
  'Fay Example', // a person of another source
  'Gus Example', // aliases is not an array
];

describe('engine parity: attendance pages', () => {
  parityTest('a meeting\'s attendees resolve to one live person page by slug, lower(title) or a lower(alias), and an ambiguous name stays unresolved',
    { methods: ['putPage', 'softDeletePage', 'listAttendanceMatches'] },
    async (engine: BrainEngine, backend) => {
      await createSource(engine, backend, 'other');
      await engine.putPage('people/alice-example', page('person', 'Alice Example'));
      await engine.putPage('people/c-example-1', page('person', 'Carol Example'));
      await engine.putPage('people/bob-example', page('person', 'Robert Example', { aliases: ['Bob Example', 'Bobby'] }));
      await engine.putPage('people/sam-a-example', page('person', 'Sam Example'));
      await engine.putPage('people/sam-b-example', page('person', 'sam example'));
      await engine.putPage('people/dana-example', page('person', 'Dana Example'));
      await engine.softDeletePage('people/dana-example');
      await engine.putPage('notes/erin-example', page('note', 'Erin Example'));
      await engine.putPage('people/fay-example', page('person', 'Fay Example'), { sourceId: 'other' });
      await engine.putPage('people/g-example', page('person', 'Gustav Example', { aliases: 'Gus Example' }));

      const resolver = makeResolver(engine, { mode: 'live', sourceId: 'default' });
      const resolved: Record<string, string | null> = {};
      for (const name of ATTENDEES) resolved[name] = await resolver.resolveAttendance!(name, 'people');
      const extracted = await extractPageLinks('meetings/2026-01-02-sync', 'Weekly sync notes.', { attendees: ATTENDEES }, 'meeting' as never,
        makeResolver(engine, { mode: 'live', sourceId: 'default' }));
      const result = {
        resolved,
        edges: extracted.candidates.map(c => `${c.fromSlug ?? ''} ${c.linkType} ${c.targetSlug}`).sort(),
        unresolved: extracted.unresolved.map(u => (u as { name?: string }).name ?? JSON.stringify(u)).sort(),
        complete: extracted.attendanceComplete,
      };
      expect(result.resolved).toEqual({
        'people/alice-example': 'people/alice-example',
        'Alice Example': 'people/alice-example',
        'CAROL example': 'people/c-example-1',
        bobby: 'people/bob-example',
        'Sam Example': null,
        'Dana Example': null,
        'Erin Example': null,
        'Fay Example': null,
        'Gus Example': null,
      });
      expect({ edges: result.edges, unresolved: result.unresolved, complete: result.complete }).toEqual({
        edges: [
          'people/alice-example attended meetings/2026-01-02-sync',
          'people/bob-example attended meetings/2026-01-02-sync',
          'people/c-example-1 attended meetings/2026-01-02-sync',
        ],
        unresolved: ['Dana Example', 'Erin Example', 'Fay Example', 'Gus Example', 'Sam Example'],
        complete: false,
      });
      return result;
    });
});
