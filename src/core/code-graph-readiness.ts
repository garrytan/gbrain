import type { BrainEngine } from './engine.ts';
import type { PageReadScope } from './types.ts';
import { EDGE_EXTRACTOR_VERSION_TS } from './chunkers/symbol-resolver.ts';
import { codeReadFilter } from './code-intel/read-scope.ts';
import { pageReadFilter } from './search/read-policy-sql.ts';
import { resolveExcludePrivatePages } from './search/private-visibility.ts';
import { probeProjectionReadiness } from './search/projection-readiness.ts';

export type CodeGraphStatus = 'not_built' | 'no_symbols' | 'indexing' | 'ready' | 'out_of_scope' | 'projection_pending' | 'unknown';

export interface CodeGraphReadiness {
  status: CodeGraphStatus;
  ready: boolean;
  has_code: boolean;
  pending_edges: boolean;
  scoped_source_id?: string;
}

export interface ReadinessScope extends PageReadScope {
  allSources?: boolean;
}

export async function codeChunksExist(
  engine: BrainEngine,
  sourceId: string | undefined,
  policy: PageReadScope = {},
): Promise<boolean> {
  const params: unknown[] = [];
  const filter = pageReadFilter('p', { ...policy, sourceId }, params, true);
  const rows = await engine.executeRaw<{ e: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
       WHERE p.page_kind = 'code' AND ${filter}
         ${policy.sourceIds?.length === 0 ? 'AND FALSE' : ''}
     ) AS e`,
    params,
  );
  if (typeof rows[0]?.e !== 'boolean') throw new Error('Invalid code readiness result');
  return rows[0].e;
}

async function currentChunksExist(
  engine: BrainEngine,
  scope: ReadinessScope,
  predicate: string,
  params: unknown[] = [],
): Promise<boolean> {
  const filter = codeReadFilter(params, scope);
  const rows = await engine.executeRaw<{ e: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
       WHERE p.page_kind = 'code' AND ${filter} AND ${predicate}
     ) AS e`,
    params,
  );
  if (typeof rows[0]?.e !== 'boolean') throw new Error('Invalid code readiness result');
  return rows[0].e;
}

export async function resolveCodeReadiness(
  engine: BrainEngine,
  opts: { kind: 'symbol' | 'edge'; count: number; remote?: boolean } & ReadinessScope,
): Promise<CodeGraphReadiness> {
  const sourceId = opts.allSources && opts.sourceIds === undefined ? undefined : opts.sourceId;
  try {
    const scope = {
      ...opts, sourceId,
      excludePrivate: opts.excludePrivate ?? await resolveExcludePrivatePages(engine, opts.remote),
      requireSafeChunks: opts.requireSafeChunks ?? opts.remote !== false,
    };
    const projection = await probeProjectionReadiness(engine, { ...scope, pageKind: 'code' });
    if (!projection.ready) {
      return { status: projection.status, ready: false, has_code: opts.count > 0, pending_edges: false };
    }
    if (opts.count > 0) {
      return { status: 'ready', ready: true, has_code: true, pending_edges: false };
    }
    const hasCode = await currentChunksExist(engine, scope, 'TRUE');
    if (!hasCode) {
      if (sourceId !== undefined && opts.remote === false && opts.sourceIds === undefined
        && await currentChunksExist(engine, { ...scope, sourceId: undefined }, 'TRUE')) {
        return {
          status: 'out_of_scope', ready: false, has_code: false,
          pending_edges: false, scoped_source_id: sourceId,
        };
      }
      return { status: 'not_built', ready: false, has_code: false, pending_edges: false };
    }
    if (opts.kind === 'symbol') {
      const hasSymbols = await currentChunksExist(engine, scope, 'cc.symbol_name IS NOT NULL');
      return { status: hasSymbols ? 'ready' : 'no_symbols', ready: hasSymbols, has_code: true, pending_edges: false };
    }
    const pending = await currentChunksExist(engine, scope,
      '(cc.edges_backfilled_at IS NULL OR cc.edges_backfilled_at < $1::timestamptz)', [EDGE_EXTRACTOR_VERSION_TS]);
    return { status: pending ? 'indexing' : 'ready', ready: !pending, has_code: true, pending_edges: pending };
  } catch {
    return { status: 'unknown', ready: false, has_code: opts.count > 0, pending_edges: false };
  }
}

export function readinessHint(r: CodeGraphReadiness): string | null {
  switch (r.status) {
    case 'not_built':
      return 'Symbol graph not built (no current code indexed in scope). Run `gbrain doctor` locally to inspect indexing and recovery.';
    case 'out_of_scope':
      return `Code IS indexed in this brain, but none of it is inside your resolved source scope${
        r.scoped_source_id ? ` (source '${r.scoped_source_id}')` : ''
      }. This is a scope/grant problem, not an indexing one — do NOT re-run \`gbrain sync\`. ` +
        `Pass a source_id that holds code (or --all-sources locally); remote clients: check the client's federated_read grant.`;
    case 'no_symbols':
      return 'Code is indexed but carries no symbol metadata. Run `gbrain reindex-code --force --no-embed` to rebuild it without provider costs.';
    case 'indexing':
      return 'Symbol graph still building (edges pending resolution). Re-run after the next `gbrain dream` cycle / autopilot tick.';
    case 'projection_pending':
      return 'Current code text projections are pending in the visible scope; results may be incomplete. Run `gbrain reindex-code --force --no-embed` locally to rebuild through the datastore owner, then check `gbrain doctor`. This read does not repair or embed content.';
    case 'unknown':
      return 'Readiness check unavailable (DB error). Treat the results as best-effort, not proof of a complete index.';
    case 'ready':
      return null;
  }
}
