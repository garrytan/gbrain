/**
 * Shared fixture for the fact-read parity cases that run under a caller's reader identity and private-readable grant
 * (`withCallerAccess`). The pages hold every reader rule the fact policy reads for such a caller: a provenance page and
 * an entity page each open, private, readable by the caller, readable by the caller's group and readable by someone
 * else, plus the caller's own member page and another member's page. Entity slugs hold a '/', so no keyed-slug entity
 * rule applies.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';

export const CALLER_PROVENANCE: Array<[string, Record<string, unknown>]> = [
  ['notes/open', {}],
  ['notes/private', { visibility: 'private' }],
  ['notes/readers', { readable_by: ['alice-example'] }],
  ['notes/team', { readable_by: 'group:team-a' }],
  ['notes/bob-only', { readable_by: ['bob-example'] }],
  ['memory/members/alice-example', { readable_by: ['alice-example'] }],
  ['memory/members/bob-example', { readable_by: ['bob-example'] }],
];

export const CALLER_ENTITIES: Array<[string, Record<string, unknown>]> = [
  ['people/open-example', {}],
  ['people/private-example', { visibility: 'private' }],
  ['people/readers-example', { readable_by: ['alice-example'] }],
  ['people/team-example', { readable_by: 'group:team-a' }],
  ['people/bob-only-example', { readable_by: ['bob-example'] }],
];

/** The open entity every provenance fact is about, and the open page every entity fact comes from. */
export const OPEN_ENTITY = 'people/open-example';
export const OPEN_PAGE = 'notes/open';

/** Write the provenance and entity pages. */
export async function putCallerPages(engine: BrainEngine, sourceId = 'default'): Promise<void> {
  for (const [slug, frontmatter] of [...CALLER_PROVENANCE, ...CALLER_ENTITIES]) {
    const type = slug.startsWith('people/') ? 'person' : 'note';
    await engine.putPage(slug, { type: type as never, title: slug, compiled_truth: `About ${slug}.`, timeline: '', frontmatter }, { sourceId });
  }
}

/** One fence row per provenance page (`prov:<slug>`, about the open entity) and per entity page (`entity:<slug>`). */
export function callerFactRows(): Array<{ fact: string; entity_slug: string; source_markdown_slug: string; row_num: number }> {
  return [
    ...CALLER_PROVENANCE.map(([slug], i) => ({ fact: `prov:${slug}`, entity_slug: OPEN_ENTITY, source_markdown_slug: slug, row_num: i + 1 })),
    ...CALLER_ENTITIES.map(([slug], i) => ({ fact: `entity:${slug}`, entity_slug: slug, source_markdown_slug: OPEN_PAGE, row_num: 101 + i })),
  ];
}

/** The callers each case reads as: none, a member with a group, a member with a grant on the source, and a stranger. */
export const CALLERS = {
  member: { identity: ['member:alice-example', 'group:team-a'], hidePrivate: true },
  granted: { identity: ['member:alice-example'], privateReadableSources: ['default'], hidePrivate: true },
  stranger: { identity: ['member:carol-example'], hidePrivate: true },
} as const satisfies Record<string, Parameters<typeof withCallerAccess>[0]>;

/** Run `read` with no caller and as each caller in `CALLERS`. */
export async function readAsCallers<T>(read: () => Promise<T>): Promise<Record<'none' | keyof typeof CALLERS, T>> {
  const out = { none: await read() } as Record<'none' | keyof typeof CALLERS, T>;
  for (const [name, access] of Object.entries(CALLERS) as Array<[keyof typeof CALLERS, Parameters<typeof withCallerAccess>[0]]>) {
    out[name] = await withCallerAccess({ ...access, identity: [...(access.identity ?? [])], privateReadableSources: [...(access.privateReadableSources ?? [])] }, read);
  }
  return out;
}
