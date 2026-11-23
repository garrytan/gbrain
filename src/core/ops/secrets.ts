/**
 * GST-2988: `reveal_secret`, the MCP door to the secret store. The trusted local CLI reads an original with
 * `gbrain secrets reveal <id>`. A remote caller needs two things: a grant whose operation snapshot names
 * `reveal_secret` (an explicit approval: a grant with no snapshot, or a refresh of one, never reaches it; see
 * execution-prerequisites.ts), and a recorded place of the entry whose full marker it can see itself (GST-3065): the
 * marker appears in what that caller's own read of the place returns (get_page for the page's fields, takes_list,
 * get_timeline, recall, get_raw_data or get_links for a row, each counted only when the token may call it), so page visibility, source scope, member rules, fence
 * stripping, take holders, private facts and owner-only lineage all apply unchanged, and a place whose marker is gone no
 * longer counts. A commit place names a git file, not a page, and never counts. The remote reply lists only the places
 * that counted. Every reveal is written to the `secrets` audit log without the value.
 */
import { opError, type Operation, type OperationContext } from './contract.ts';
import type { Occurrence } from '../secret-store/store.ts';

/** The read that shows a place's field to this caller: the op and its params, by the field's store. */
function readOf(o: Occurrence & { slug: string }): [string, Record<string, unknown>] {
  const store = o.field.split('/')[0];
  const at = { source_id: o.source_id };
  if (store === 'takes') return ['takes_list', { page_slug: o.slug, limit: 500 }];
  if (store === 'timeline_entries') return ['get_timeline', { slug: o.slug, ...at, limit: 1000 }];
  if (store === 'facts') return ['recall', { entity: o.slug, ...at, include_expired: true, limit: 100 }];
  if (store === 'raw_data') return ['get_raw_data', { slug: o.slug, ...at }];
  if (store === 'links') return ['get_links', { slug: o.slug, ...at }];
  return ['get_page', { slug: o.slug, ...at }];
}

/** The rows of a reply: the reply itself when it is a list, else every list among its top-level values. */
function rowsOf(reply: unknown): unknown[] {
  if (Array.isArray(reply)) return reply;
  if (!reply || typeof reply !== 'object') return [];
  return Object.values(reply).flatMap(v => (Array.isArray(v) ? v : []));
}

/**
 * The places of an entry whose marker this caller's own read returns. A page field counts when the full marker is in
 * the get_page reply. A row counts when the caller's row read returns that row (its id) still carrying the marker;
 * row reads pass output redaction, which can rewrite the marker's id, so the row's marker is matched in the form the
 * same redaction gives the marker on its own, and the row id keeps the match to that one row.
 */
async function visiblePlaces(ctx: OperationContext, marker: string, places: Occurrence[]): Promise<Occurrence[]> {
  const { operationsByName } = await import('../operations.ts');
  const { redactRetrievalOutput } = await import('../search/output-redaction.ts');
  const forms = [marker, String(redactRetrievalOutput([marker], {}, { uncapped: true }).results[0])];
  const replies = new Map<string, Promise<unknown>>();
  const visible: Occurrence[] = [];
  for (const o of places) {
    if (!o.slug || o.commit_sha) continue;
    const [op, params] = readOf(o as Occurrence & { slug: string });
    if (!ctx.auth?.allowedOperations?.includes(op)) continue;
    const key = JSON.stringify([op, params]);
    if (!replies.has(key)) replies.set(key, Promise.resolve().then(() => operationsByName[op]!.handler(ctx, params))
      .then(out => (out && typeof out === 'object' && 'error' in out ? null : out), () => null));
    const reply = await replies.get(key);
    if (op === 'get_page') {
      if (JSON.stringify(reply ?? '').includes(marker)) visible.push(o);
      continue;
    }
    const rowId = o.field.split('/')[1];
    const row = rowsOf(reply).find(r => r && typeof r === 'object' && String((r as { id?: unknown }).id) === rowId);
    if (row && forms.some(m => JSON.stringify(row).includes(m))) visible.push(o);
  }
  return visible;
}

const reveal_secret: Operation = {
  name: 'reveal_secret',
  idempotent: true,
  outputRedaction: { exempt: 'returns the original value of a secret-store entry by design; gated by an explicit grant and page read access, and audited' },
  description: 'Return the original value behind a <REDACTED:rule:ss_...> marker. Needs a token whose operation list names reveal_secret and read access to a page holding the marker; every call is audited.',
  params: {
    id: { type: 'string', required: true, description: 'Entry id from the marker (ss_ followed by 12 hex).' },
  },
  scope: 'read',
  mutating: false,
  handler: async (ctx, p) => {
    const id = String(p.id ?? '');
    const { entryRow, markerOf, occurrencesOf, reveal } = await import('../secret-store/store.ts');
    let actor = 'local-cli';
    let places: Occurrence[] | null = null;
    if (ctx.remote !== false) {
      const allowed = ctx.auth?.allowedOperations;
      if (!Array.isArray(allowed) || !allowed.includes('reveal_secret')) {
        throw opError('secret_reveal_forbidden', 'This connection is not allowed to read originals from the secret store.',
          `The brain owner grants it to this token from the brain host: gbrain auth rescope --token ${ctx.auth?.clientName ?? 'TOKEN_NAME'} --refresh-operations --add reveal_secret (preview without --add first).`);
      }
      const row = await entryRow(ctx.engine, id);
      places = await visiblePlaces(ctx, markerOf(row.rule, id), (await occurrencesOf(ctx.engine, id)).filter(o => o.source_id === row.source_id));
      if (!places.length) {
        throw opError('secret_reveal_forbidden', 'None of the pages holding this marker is readable by this connection, so its original is not returned.',
          'Ask the brain owner; only a caller that can read a page holding the marker can reveal it.');
      }
      actor = ctx.auth?.clientName ?? ctx.auth?.clientId ?? 'remote';
    }
    const out = await reveal(ctx.engine, id, actor);
    return { id: out.id, rule: out.rule, source_id: out.source_id, status: out.status, value: out.value,
      occurrences: (places ?? out.occurrences).map(o => ({ slug: o.slug, field: o.field, origin: o.origin, commit: o.commit_sha, path: o.path, line: o.line, at: o.created_at })) };
  },
  area: 'secrets',
  cliHints: { name: 'reveal-secret', hidden: true },
};

export const secretsOperations: Operation[] = [reveal_secret];
