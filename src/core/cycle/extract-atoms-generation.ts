/**
 * GBRA-161: how extract_atoms maps its items onto atom generations (generations/adapters/atoms.ts): each item's key and
 * adapter context, the unmanaged one-transaction publication, and the transcript keys (root label plus root-relative
 * path, with the rename map) and slugs. Peeled out of extract-atoms.ts (module-size ratchet).
 */
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { BrainEngine, LinkBatchInput } from '../engine.ts';
import { isAvailable } from '../ai/gateway.ts';
import { ATOM_KIND, atomGenerationAdapter, atomOwnerKey, atomPagePin, TRANSCRIPT_KEY_PREFIX, type AtomGenerationContext } from '../generations/adapters/atoms.ts';
import { markdownItem } from '../generations/adapters/page.ts';
import type { GenerationKey } from '../generations/contract.ts';
import { publishGeneration } from '../generations/publish.ts';
import type { ExtractAtomsItem } from './extract-atoms-input.ts';

/**
 * GBRA-161: one unmanaged item's atoms, their provenance edges (#3961, #4733), the completion flip (source_hash, #4148)
 * and the versioned retirement of the atoms this extraction no longer produced (C-14) publish as one generation in one
 * transaction (#5575 I2/B3: gated and stamped at the origin's taint inside the adapter). #6503: a cut item publishes
 * additively, stays provisional (`pending:<hash>`) and retires nothing. A held result changes nothing and is logged.
 */
export async function publishUnmanagedAtoms(engine: BrainEngine, sourceId: string, item: ExtractAtomsItem, atoms: ReadonlyArray<{ slug: string; content: string }>,
  links: LinkBatchInput[], opts: { partial: boolean; runId: string; originLabel: string }) {
  const { key, context, locator } = atomGenerationOrigin(sourceId, item);
  context.links = links;
  context.embed = isAvailable('embedding');
  const outcome = await publishGeneration(engine, atomGenerationAdapter, { key, items: atoms.map(atom => markdownItem(atom.slug, atom.content)),
    input: { pin: atomInputPin(item), size: Buffer.byteLength(item.content) }, partial: opts.partial, context, runId: opts.runId, locator });
  for (const complete of context.postCommit ?? []) {
    await complete().catch(error => console.error(`[extract_atoms] ${opts.originLabel}: post-commit embedding failed (the embedding backfill retries it): ${error instanceof Error ? error.message : String(error)}`));
  }
  if (outcome.state === 'held') console.error(heldLine(opts.originLabel, key, outcome.reason));
  return outcome;
}

/** GBRA-161: the input pin an unmanaged item was read at (a page's is bound to its row and revision, see atomPagePin). */
export function atomInputPin(item: ExtractAtomsItem): string {
  return item.kind === 'page' ? atomPagePin(item.contentHash, item.identity) : item.contentHash;
}

/**
 * GBRA-161: the generation key of one item and the context its adapter reads (a transcript's input is not in the
 * database). A transcript's key is its root label and root-relative path (resolveTranscriptKeys), or its path when the
 * caller named no root.
 */
export function atomGenerationOrigin(sourceId: string, item: ExtractAtomsItem): { key: GenerationKey; context: AtomGenerationContext; locator?: string } {
  if (item.kind === 'page') return { key: { kind: ATOM_KIND, sourceId, ownerKey: atomOwnerKey({ kind: 'page', slug: item.slug }) }, context: { postCommit: [] } };
  return { key: { kind: ATOM_KIND, sourceId, ownerKey: atomOwnerKey({ kind: 'transcript', transcriptKey: item.transcriptKey ?? item.filePath }) }, locator: item.filePath,
    context: { postCommit: [], locator: item.filePath, transcriptInput: { pin: item.contentHash, size: Buffer.byteLength(item.content) } } };
}

export const heldLine = (originLabel: string, key: GenerationKey, reason: string) =>
  `[extract_atoms] ${originLabel}: result held (${reason}); the previous atoms stay live. Preview: gbrain repair generations --kind ${ATOM_KIND} --mode release-held --key ${key.ownerKey} --source ${key.sourceId}`;

/** GBRA-161 PR 1b: the corpus root a discovered transcript lies under, with the label its key carries. */
export function transcriptRoot(filePath: string, corpusDir: string, meetingDir: string | undefined): { path: string; label: string } {
  const inside = (dir: string) => { const rel = relative(resolve(dir), resolve(filePath)); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel); };
  return meetingDir && inside(meetingDir) && !(inside(corpusDir) && resolve(corpusDir).length > resolve(meetingDir).length)
    ? { path: meetingDir, label: 'meetings' } : { path: corpusDir, label: 'corpus' };
}

/**
 * GBRA-161 PR 1b (Eng r3 F1): each transcript's generation key: its root label and path relative to that root, never its
 * basename or content hash, so two files of one name in two folders never share a key. A file a live generation names as
 * its locator keeps that generation's key (the rename map). A file whose key has no live generation but whose content
 * equals the input of a live transcript generation whose file is gone was moved: it keeps that key, and the generation's
 * locator follows it (recorded even when the unchanged file is not extracted again). `kind`: the ledger kind whose live
 * generations hold the rename map (atoms by default; synthesis keys its outputs the same way, GBRA-161 PR 4).
 */
export async function resolveTranscriptKeys(engine: BrainEngine, sourceId: string, transcripts: ReadonlyArray<{ filePath: string; contentHash: string; root?: { path: string; label: string } }>,
  dryRun: boolean, kind: string = ATOM_KIND): Promise<Map<string, string>> {
  const own = new Map(transcripts.map(t => [t.filePath, t.root ? `${t.root.label}/${relative(resolve(t.root.path), resolve(t.filePath)).split(sep).join('/')}` : t.filePath]));
  if (!transcripts.length) return own;
  const live = await engine.executeRaw<{ id: number; owner_key: string; locator: string | null; input_pin: string | null }>(
    `SELECT id, owner_key, locator, input_pin FROM derived_generations WHERE source_id=$1 AND kind=$2 AND state='live' AND owner_key LIKE $3`,
    [sourceId, kind, `${TRANSCRIPT_KEY_PREFIX}%`]);
  const located = new Set<string>();
  for (const t of transcripts) {
    const at = live.find(row => row.locator === t.filePath);
    if (at) { own.set(t.filePath, at.owner_key.slice(TRANSCRIPT_KEY_PREFIX.length)); located.add(t.filePath); }
  }
  const claimed = new Set([...own.values()].map(key => `${TRANSCRIPT_KEY_PREFIX}${key}`).filter(key => live.some(row => row.owner_key === key)));
  for (const t of transcripts) {
    if (located.has(t.filePath) || claimed.has(`${TRANSCRIPT_KEY_PREFIX}${own.get(t.filePath)}`)) continue;
    const moved = live.find(row => !claimed.has(row.owner_key) && row.input_pin === t.contentHash && row.locator && row.locator !== t.filePath && !existsSync(row.locator));
    if (!moved) continue;
    claimed.add(moved.owner_key);
    own.set(t.filePath, moved.owner_key.slice(TRANSCRIPT_KEY_PREFIX.length));
    if (!dryRun) await engine.executeRaw('UPDATE derived_generations SET locator=$2, updated_at=now() WHERE id=$1', [moved.id, t.filePath]);
  }
  return own;
}

/**
 * GBRA-161 PR 1b: a transcript atom's slug. The title-and-date slug, unless a live atom of another transcript already
 * holds it (two files of one name in two folders extract the same title): then the slug folds in the transcript's key.
 */
export async function resolveTranscriptAtomSlug(engine: BrainEngine, sourceId: string, title: string, item: { filePath: string; transcriptKey?: string },
  undatedDate: string, atomSlug: (title: string, srcRef: string, sourcePageSlug: string | undefined, undatedDate: string) => string): Promise<string> {
  const legacy = atomSlug(title, item.filePath, undefined, undatedDate);
  const [held] = await engine.executeRaw<{ source_path: string | null }>(
    `SELECT frontmatter->>'source_path' AS source_path FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL`, [sourceId, legacy]);
  if (!held || held.source_path === item.filePath || !held.source_path) return legacy;
  const [mine] = await engine.executeRaw<{ locator: string | null }>(
    `SELECT locator FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='live'`,
    [sourceId, ATOM_KIND, atomOwnerKey({ kind: 'transcript', transcriptKey: item.transcriptKey ?? item.filePath })]);
  return mine?.locator === held.source_path ? legacy : atomSlug(title, item.filePath, item.transcriptKey ?? item.filePath, undatedDate);
}
