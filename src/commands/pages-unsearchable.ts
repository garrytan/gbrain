/**
 * `gbrain pages unsearchable --source <id> [--state <state>] [--limit N] [--json]`
 * (#6696 B3): read-only listing of what search cannot fully see in one source,
 * one row per (page, embedding state) with its reason, chunk count, bytes and
 * the state's protocol fix. States and their exits: src/core/embedding-state.ts.
 * Without `--state` every state but `embedded` is listed. The listing is
 * bounded (`--limit`, default 50); `complete: false` means more rows exist.
 */
import type { BrainEngine } from '../core/engine.ts';
import { cliRenderContext, renderAction } from '../core/agent-output.ts';
import { opError } from '../core/ops/contract.ts';
import { resolveSourceId } from '../core/source-resolver.ts';
import { embeddingsDisabled } from '../core/embedding-disabled.ts';
import {
  DELETED_PAGE_PURGE_WINDOW_HOURS, EMBEDDING_STATE_DOCS, EMBEDDING_STATES, embeddingStateFix, readEmbeddingState,
  type EmbeddingState, type EmbeddingStateRow,
} from '../core/embedding-state.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

export const UNSEARCHABLE_USAGE = 'Usage: gbrain pages unsearchable --source <id> [--state <state>] [--limit N] [--json]';

export interface UnsearchableArgs { source: string | null; state: EmbeddingState | null; limit: number; json: boolean }

function flagValue(args: readonly string[], name: string): string | undefined {
  const i = args.findIndex(a => a === name || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  return args[i]!.startsWith(`${name}=`) ? args[i]!.slice(name.length + 1) : args[i + 1];
}

/** `--state` must name a state and `--limit` a whole number from 1 to 1000; anything else is `invalid_params`. */
export function parseUnsearchableArgs(args: readonly string[]): UnsearchableArgs {
  const state = flagValue(args, '--state');
  if (state !== undefined && !(EMBEDDING_STATES as readonly string[]).includes(state)) {
    throw opError('invalid_params', `Unknown --state "${state}". Valid states: ${EMBEDDING_STATES.join(', ')}.`,
      `Pass one of: ${EMBEDDING_STATES.join(', ')}.`, { docs: EMBEDDING_STATE_DOCS });
  }
  const limitRaw = flagValue(args, '--limit');
  const limit = limitRaw === undefined ? DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw opError('invalid_params', `--limit must be a whole number from 1 to ${MAX_LIMIT} (got "${limitRaw}").`, UNSEARCHABLE_USAGE);
  }
  const source = flagValue(args, '--source');
  if (source !== undefined && (source === '' || source.startsWith('--'))) throw opError('invalid_params', '--source needs a source id.', UNSEARCHABLE_USAGE);
  return { source: source ?? null, state: (state as EmbeddingState | undefined) ?? null, limit, json: args.includes('--json') };
}

function reasonFor(row: EmbeddingStateRow, embeddingsEnabled: boolean): string {
  switch (row.state) {
    case 'embedded': return 'vector_present';
    case 'pending': return embeddingsEnabled ? 'no_vector' : 'embeddings_disabled';
    case 'keyword_only': return row.embed_skip_reason ?? 'embed_skip';
    case 'quarantined': return row.quarantine_reason ?? 'quarantine';
    case 'empty': return 'empty_body';
    case 'deleted_page_chunks': return row.overdue ? 'past_purge_window' : 'within_purge_window';
    case 'chunkless_healable': return 'no_chunk_rows';
  }
}

export async function runPagesUnsearchable(engine: BrainEngine, args: string[]): Promise<void> {
  const parsed = parseUnsearchableArgs(args);
  const sourceId = await resolveSourceId(engine, parsed.source);
  const states = parsed.state ? [parsed.state] : EMBEDDING_STATES.filter(state => state !== 'embedded');
  const embeddingsEnabled = !(await embeddingsDisabled(engine));
  const found = await engine.listEmbeddingStateRows({ sourceIds: [sourceId], states, limit: parsed.limit + 1, purgeWindowHours: DELETED_PAGE_PURGE_WINDOW_HOURS });
  const render = cliRenderContext();
  const summary = await readEmbeddingState(engine, { mode: 'full', sourceIds: [sourceId] });
  const blockBytes = (summary.keyword_only as { threshold_bytes?: number } | undefined)?.threshold_bytes;
  const rows = found.slice(0, parsed.limit).map(row => {
    const fix = embeddingStateFix(row.state, { sourceId, slug: row.slug, markerBytes: row.marker_bytes, blockBytes, embeddingsEnabled });
    return {
      slug: row.slug, source_id: row.source_id, state: row.state, reason: reasonFor(row, embeddingsEnabled), chunks: row.chunks, bytes: row.bytes,
      ...(row.marker_bytes !== null ? { marker_bytes: row.marker_bytes } : {}),
      ...(row.deleted_at ? { deleted_at: row.deleted_at.toISOString() } : {}),
      fix: fix ? renderAction(fix, render) : null,
    };
  });
  const complete = found.length <= parsed.limit;
  if (parsed.json) {
    console.log(JSON.stringify({ source_id: sourceId, state: parsed.state, limit: parsed.limit, complete, active_column: summary.active_column,
      counts: summary.counts, unsearchable: summary.unsearchable, rows }, null, 2));
    return;
  }
  console.log(`Source ${sourceId} (active column '${summary.active_column}'): ${summary.unsearchable} unsearchable; ${EMBEDDING_STATES.map(s => `${s} ${summary.counts[s] ?? 0}`).join(', ')}.`);
  if (rows.length === 0) { console.log(parsed.state ? `No pages in state ${parsed.state}.` : 'Nothing unsearchable.'); return; }
  for (const row of rows) {
    console.log(`  ${row.state.padEnd(20)} ${row.slug}  chunks=${row.chunks} bytes=${row.bytes}  ${row.reason}`);
    if (row.fix?.command) console.log(`      fix (${row.fix.next.replace(/_/g, ' ')}): ${row.fix.command}`);
  }
  if (!complete) console.log(`(first ${parsed.limit} rows; raise --limit or filter with --state to see more)`);
}
