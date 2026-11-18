/**
 * GST-2988: `reveal_secret`, the MCP door to the secret store. The trusted local CLI reads an original with
 * `gbrain secrets reveal <id>`. A remote caller needs two things: a grant whose operation snapshot names
 * `reveal_secret` (an explicit approval: a grant with no snapshot, or a refresh of one, never reaches it; see
 * execution-prerequisites.ts), and read access to a page that holds a recorded occurrence of the entry, checked through
 * get_page with the caller's own context, so page visibility, source scope and member rules apply unchanged. Every
 * reveal is written to the `secrets` audit log without the value.
 */
import { opError, type Operation, type OperationContext } from './contract.ts';

/** True when get_page, run with the caller's own context, returns one of these pages (body not read). */
async function callerCanRead(ctx: OperationContext, sourceId: string, slugs: string[]): Promise<boolean> {
  const { operationsByName } = await import('../operations.ts');
  for (const slug of slugs) {
    try {
      const page = await operationsByName.get_page!.handler(ctx, { slug, source_id: sourceId, body: 'none' }) as Record<string, unknown> | null;
      if (page && typeof page === 'object' && !('error' in page)) return true;
    } catch { /* not found or not visible to this caller */ }
  }
  return false;
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
    const { entryRow, occurrencesOf, reveal } = await import('../secret-store/store.ts');
    let actor = 'local-cli';
    if (ctx.remote !== false) {
      const allowed = ctx.auth?.allowedOperations;
      if (!Array.isArray(allowed) || !allowed.includes('reveal_secret')) {
        throw opError('secret_reveal_forbidden', 'This connection is not allowed to read originals from the secret store.',
          `The brain owner grants it to this token from the brain host: gbrain auth rescope --token ${ctx.auth?.clientName ?? 'TOKEN_NAME'} --refresh-operations --add reveal_secret (preview without --add first).`);
      }
      const row = await entryRow(ctx.engine, id);
      const slugs = [...new Set((await occurrencesOf(ctx.engine, id)).filter(o => o.slug && o.source_id === row.source_id).map(o => o.slug!))];
      if (!slugs.length || !(await callerCanRead(ctx, row.source_id, slugs))) {
        throw opError('secret_reveal_forbidden', 'None of the pages holding this marker is readable by this connection, so its original is not returned.',
          'Ask the brain owner; only a caller that can read a page holding the marker can reveal it.');
      }
      actor = ctx.auth?.clientName ?? ctx.auth?.clientId ?? 'remote';
    }
    const out = await reveal(ctx.engine, id, actor);
    return { id: out.id, rule: out.rule, source_id: out.source_id, status: out.status, value: out.value,
      occurrences: out.occurrences.map(o => ({ slug: o.slug, field: o.field, origin: o.origin, commit: o.commit_sha, path: o.path, line: o.line, at: o.created_at })) };
  },
  area: 'secrets',
  cliHints: { name: 'reveal-secret', hidden: true },
};

export const secretsOperations: Operation[] = [reveal_secret];
