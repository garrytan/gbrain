/**
 * Recent-transcripts operation cluster — pure move from operations.ts
 * (v0.46.x tranche 3). Op const stays module-private; `transcriptsOperations`
 * below is spliced into the canonical `operations` array in ../operations.ts
 * at the cluster's original position (right after the salience spread). Never
 * import from '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';
import { hostOnlyError } from './op-fix.ts';
import { GET_RECENT_TRANSCRIPTS_DESCRIPTION } from '../operations-descriptions.ts';

const get_recent_transcripts: Operation = {
  name: 'get_recent_transcripts',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: GET_RECENT_TRANSCRIPTS_DESCRIPTION,
  scope: 'read',
  // Local-only: rejects HTTP-borne MCP traffic at tool-list time
  // (serve-http.ts filters on `localOnly`) AND at runtime via the in-handler
  // ctx.remote check. Defense in depth: hidden + rejected.
  localOnly: true, cliOnly: { argv: ['gbrain', 'transcripts', 'recent'] },
  params: {
    days: { type: 'number', description: 'Window in days. Default 7.' },
    summary: {
      type: 'boolean',
      description: 'When true (default), return first ~300 chars per transcript. When false, full content (capped at 100 KB per file).',
    },
    limit: { type: 'number', description: 'Max transcripts (default 50).' },
  },
  handler: async (ctx, p) => {
    // Trust gate (eng review D2 + codex C3): MCP / HTTP callers (`remote=true`)
    // are blocked. Local CLI callers (`remote=false`) and the trusted-workspace
    // dream cycle pass through. This op is intentionally NOT in the subagent
    // allow-list (subagents always run with remote=true; they would always be
    // rejected, which is a footgun if the op is visible).
    if (ctx.remote === true) {
      const n = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? String(v) : undefined);
      const days = n(p.days);
      const limit = n(p.limit);
      throw hostOnlyError(ctx, 'permission_denied', 'get_recent_transcripts is local-only — call via the gbrain CLI.',
        ['gbrain', 'transcripts', 'recent', ...(days ? ['--days', days] : []), ...(limit ? ['--limit', limit] : []),
          ...(p.summary === false ? ['--full'] : []), '--json'],
        'Raw transcripts are private host files; only the trusted local CLI reads them.');
    }
    const { listRecentTranscripts } = await import('../transcripts.ts');
    return listRecentTranscripts(ctx.engine, {
      days: typeof p.days === 'number' ? p.days : undefined,
      summary: typeof p.summary === 'boolean' ? p.summary : undefined,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
    });
  },
  cliHints: { name: 'transcripts', hidden: true },
};

export const transcriptsOperations: Operation[] = [get_recent_transcripts];
