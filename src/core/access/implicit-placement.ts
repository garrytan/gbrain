/**
 * GBRA-585: where a trusted local `gbrain put` that named no source put its page, on a brain that serves several
 * people. Source routing is unchanged; the result gains a `placement` object naming the source, the rule that
 * picked it, who may read the page and how to choose otherwise, so a page never lands in a source its writer did
 * not pick without a word. A one-person brain, a remote caller and a put that named its source get nothing.
 */
import type { BrainEngine } from '../engine.ts';
import { brainServes } from './serves.ts';
import { parseSourceConfig } from '../sources-load.ts';
import { resolveImplicitDefaultSourceId } from '../source-resolver.ts';

export type PlacementRule = 'local_path' | 'brain_default' | 'sole_non_default' | 'seed_default';

export interface Placement {
  source_id: string;
  picked_by: PlacementRule;
  readers: string[] | 'every_source_reader';
  note: string;
}

const WHY: Record<PlacementRule, (id: string) => string> = {
  local_path: id => `the current folder is inside the folder of source '${id}'`,
  brain_default: () => 'config sources.default names it',
  sole_non_default: id => `'${id}' is the only source besides 'default' with a folder and 'default' held no pages; once 'default' holds a page, a put that names no source goes to 'default'`,
  seed_default: () => "it is the brain's default source",
};

async function pickedBy(engine: BrainEngine, sourceId: string): Promise<PlacementRule> {
  const [configured, implicit] = await Promise.all([engine.getConfig('sources.default'), resolveImplicitDefaultSourceId(engine)]);
  if (sourceId === implicit) return implicit === configured ? 'brain_default' : 'sole_non_default';
  return implicit === null && sourceId === 'default' ? 'seed_default' : 'local_path';
}

/** The placement of a page a local put wrote with no source named, or null on a brain that serves one person. */
export async function implicitPlacement(engine: BrainEngine, sourceId: string, slug: string): Promise<Placement | null> {
  if ((await brainServes(engine)).serves !== 'several') return null;
  const { whoCanRead } = await import('../../commands/access.ts');
  const [entry] = await whoCanRead(engine, slug, sourceId);
  if (!entry) return null;
  const picked = await pickedBy(engine, sourceId);
  const [row] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id = $1', [sourceId]);
  const noGrantReads = sourceId === 'default' || parseSourceConfig(row?.config).federated === true;
  const who = entry.members !== 'every_source_reader'
    ? `Members who may read it: ${entry.members.join(', ') || 'none'}.`
    : entry.private
      ? `It names no readers, but it is private: a member key reads it only with private_pages: granted_sources on source '${sourceId}', so a key with no source grant does not.`
      : noGrantReads
        ? `It names no readers, so every member whose key reads source '${sourceId}' reads it, and a member key with no source grant does.`
        : `It names no readers. A member key with no source grant does not read source '${sourceId}' until it is federated (gbrain sources federate ${sourceId}); from then on every member does.`;
  const qualifications = entry.note.split(/(?<=\.) (?=[A-Z])/)
    .filter(s => s.startsWith('Labelled-only members') || (entry.members !== 'every_source_reader' && s.startsWith('visibility: private')));
  return {
    source_id: sourceId,
    picked_by: picked,
    readers: entry.members,
    note: `No source was named, so ${slug} went to source '${sourceId}': ${WHY[picked](sourceId)}. ${[who, ...qualifications].join(' ')} `
      + 'To choose the source, pass --source <id> (gbrain sources current shows how one is picked); '
      + 'to keep the page to some members, give it readable_by: [<member>, ...] in its frontmatter.',
  };
}

/** put_page's result with `placement` added for the trusted local CLI's unscoped put on a brain that serves several people. */
export async function withImplicitPlacement<R>(ctx: { engine: BrainEngine; remote?: boolean; localSourceImplicit?: boolean },
  sourceId: string, params: Record<string, unknown>, result: R): Promise<R> {
  if (ctx.remote !== false || ctx.localSourceImplicit !== true || params.source_id !== undefined) return result;
  const written = (result ?? {}) as Record<string, unknown>;
  if (written.status !== 'created_or_updated' && written.status !== 'skipped') return result;
  try {
    const slug = typeof written.slug === 'string' ? written.slug : String(params.slug);
    const placement = await implicitPlacement(ctx.engine, sourceId, slug);
    return placement ? { ...written, placement } as R : result;
  } catch {
    return result;
  }
}
