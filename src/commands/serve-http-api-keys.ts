/**
 * Owner-dashboard legacy API keys for `gbrain serve --http`
 * (`/admin/api/api-keys`): list, mint and revoke.
 *
 * Mint goes through `mintLegacyToken` (the same grant shape as
 * `gbrain auth create`): scopes default to `read,write` and `admin` is minted
 * only when requested; sources are checked against active source ids; takes
 * holders against the holder grammar. The response reports the effective
 * grant and which defaults applied. The plaintext token appears only in the
 * mint response body: nothing here logs it or broadcasts it over SSE.
 * Revoke is by row id (names are not unique).
 */
import express, { type Express, type Request, type RequestHandler, type Response } from 'express';
import type { BrainEngine } from '../core/engine.ts';
import { cliRenderContext, toAgentError, type Action } from '../core/agent-output.ts';
import { grantFromTokenRow } from '../core/grants/model.ts';
import { opError } from '../core/ops/contract.ts';
import { sqlQueryForEngine } from '../core/sql-query.ts';
import { ALLOWED_SCOPES_LIST, isScope, localCliOnlyScopeViolation } from '../core/scope.ts';
import { isValidSourceId } from '../core/source-id.ts';
import { isValidHolder } from '../core/takes-fence.ts';
import { mintLegacyToken, revokeLegacyTokenById, TOKEN_ID_RE } from '../core/token-mint.ts';

export const API_KEY_NAME_MAX = 128;
export const API_KEY_DEFAULT_SCOPES: readonly string[] = ['read', 'write'];
export const API_KEY_DEFAULT_TAKES_HOLDERS: readonly string[] = ['world'];
const DOCS = 'docs/mcp/ADMIN.md#dashboard-api-keys';

export interface ApiKeyMintRequest {
  name: string;
  scopes: string[];
  /** undefined = no source grant (the `gbrain auth create` default). */
  sources?: string[];
  takesHolders: string[];
  defaultsApplied: Array<'scopes' | 'sources' | 'takes_holders'>;
}

function listParam(value: unknown): string[] | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return [...new Set(value.split(/[\s,]+/).filter(Boolean))];
  if (Array.isArray(value) && value.every(v => typeof v === 'string')) return [...new Set(value.map(v => v.trim()).filter(Boolean))];
  return null;
}

const listAction = (why: string): Action => ({ argv: ['gbrain', 'auth', 'list'], consent: [], actor: 'host_admin', why, requires_exclusive: false, docs: DOCS });

function invalid(message: string, suggestion: string, why: string, fix: Action) {
  return opError('invalid_params', message, suggestion, { why, fix, docs: DOCS, reason: 'api_key_request_invalid' });
}

/** Validate a dashboard mint request and apply the `gbrain auth create` defaults; throws `invalid_params`. */
export async function parseApiKeyMintRequest(engine: BrainEngine, body: unknown): Promise<ApiKeyMintRequest> {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const createFix = (args: string[], why: string): Action => ({
    argv: ['gbrain', 'auth', 'create', name || 'api-key', ...args], consent: ['credentials'], actor: 'host_admin', why,
    verify: { argv: ['gbrain', 'auth', 'list'] }, requires_exclusive: false, docs: DOCS,
  });
  if (!name || name.length > API_KEY_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
    throw invalid(`API key name must be 1-${API_KEY_NAME_MAX} printable characters.`,
      `Resubmit with a short printable name (at most ${API_KEY_NAME_MAX} characters).`,
      'The name labels the key in the dashboard, request logs and gbrain auth list.',
      listAction('Lists existing key names so the new one can be told apart.'));
  }
  const defaultsApplied: ApiKeyMintRequest['defaultsApplied'] = [];
  const scopesParam = listParam(raw.scopes);
  const valid = ALLOWED_SCOPES_LIST.join(', ');
  if (scopesParam === null || (scopesParam !== undefined && scopesParam.length === 0)) {
    throw invalid(`scopes must be a non-empty list of: ${valid}.`, `Resubmit with scopes from: ${valid} (omit scopes for read,write).`,
      'An empty or non-list scope grant would mint a key that can do nothing.', createFix(['--scopes', 'read,write'], 'Mints the same key with the default read,write scopes.'));
  }
  const unknown = (scopesParam ?? []).filter(s => !isScope(s));
  if (unknown.length) {
    throw invalid(`Unknown scope ${unknown.map(s => JSON.stringify(s)).join(', ')}. Valid scopes: ${valid}.`,
      `Resubmit with scopes from: ${valid}.`, 'A misspelled scope is refused at mint time so it never mints a key with a different grant than asked.',
      createFix(['--scopes', 'read,write'], 'Mints the same key with the default read,write scopes.'));
  }
  const localOnly = localCliOnlyScopeViolation(scopesParam ?? []);
  if (localOnly) {
    throw invalid(localOnly, 'Resubmit without memory_confirm, or ask the user to mint the key on the brain host with gbrain auth create.',
      'Confirming memory as the owner is granted only by the local CLI, never by the admin API.',
      { ...createFix(['--scopes', 'read,write,memory_confirm'], 'Mints the key with memory_confirm from the local CLI on the brain host.'), actor: 'user' });
  }
  const scopes = scopesParam ?? (defaultsApplied.push('scopes'), [...API_KEY_DEFAULT_SCOPES]);

  const sourcesParam = listParam(raw.sources);
  if (sourcesParam === null || (sourcesParam !== undefined && (sourcesParam.length === 0 || sourcesParam.some(id => !isValidSourceId(id))))) {
    throw invalid('sources must be a non-empty list of source ids (omit it for the default grant).',
      'Resubmit with source ids from gbrain sources list, or omit sources.', 'Each source id names a repository in this brain; the first one is the write source.',
      { argv: ['gbrain', 'sources', 'list'], consent: [], actor: 'host_admin', why: 'Lists the source ids this brain serves.', requires_exclusive: false, docs: DOCS });
  }
  if (sourcesParam) {
    const rows = await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE id = ANY($1::text[]) AND archived IS NOT TRUE', [sourcesParam]);
    const active = new Set(rows.map(r => r.id));
    const missing = sourcesParam.filter(id => !active.has(id));
    if (missing.length) {
      throw invalid(`Unknown or archived source: ${missing.join(', ')}.`, 'Resubmit with active source ids from gbrain sources list.',
        'A key can only be granted sources this brain serves.',
        { argv: ['gbrain', 'sources', 'list'], consent: [], actor: 'host_admin', why: 'Lists the active source ids.', requires_exclusive: false, docs: DOCS });
    }
  } else defaultsApplied.push('sources');

  const holdersParam = listParam(raw.takes_holders);
  if (holdersParam === null || (holdersParam !== undefined && (holdersParam.length === 0 || holdersParam.some(h => !isValidHolder(h))))) {
    throw invalid('takes_holders must be a non-empty list of holders: world, brain, people/<slug>, companies/<slug> or a bare slug.',
      'Resubmit with valid takes holders, or omit takes_holders for the default world.', 'Takes holders decide whose private takes the key can read.',
      createFix(['--takes-holders', 'world'], 'Mints the same key with the default world takes holder.'));
  }
  const takesHolders = holdersParam ?? (defaultsApplied.push('takes_holders'), [...API_KEY_DEFAULT_TAKES_HOLDERS]);
  return { name, scopes, ...(sourcesParam ? { sources: sourcesParam } : {}), takesHolders, defaultsApplied };
}

function grantView(row: Record<string, unknown>) {
  const grant = grantFromTokenRow(row);
  const s = grant.sources;
  return {
    scopes: grant.scopes,
    scopes_grandfathered: row.scopes == null,
    sources: s.kind === 'default' ? 'default' : s.kind === 'none' ? [] : s.kind === 'scalar' ? [s.writeSource] : [...s.readSources],
    takes_holders: grant.takesHolders ?? ['world'],
  };
}

const sendError = (res: Response, status: number, e: unknown) =>
  res.status(status).json(toAgentError(e, { transport: 'http', command: 'admin api-keys', render: cliRenderContext({ transport: 'http' }) }));

export function mountAdminApiKeys(app: Express, requireAdmin: RequestHandler, engine: BrainEngine): void {
  app.get('/admin/api/api-keys', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const rows = await engine.executeRaw<Record<string, unknown>>('SELECT * FROM access_tokens ORDER BY created_at DESC, id');
      res.json(rows.map(row => ({
        id: String(row.id), name: row.name, created_at: row.created_at, last_used_at: row.last_used_at,
        status: row.revoked_at != null ? 'revoked' : 'active', ...grantView(row),
      })));
    } catch {
      res.status(503).json({ error: 'service_unavailable' });
    }
  });

  app.post('/admin/api/api-keys', requireAdmin, express.json(), async (req: Request, res: Response) => {
    let request: ApiKeyMintRequest;
    try {
      request = await parseApiKeyMintRequest(engine, req.body);
    } catch (e) {
      sendError(res, 400, e);
      return;
    }
    try {
      const minted = await mintLegacyToken(engine, { name: request.name, scopes: request.scopes, takesHolders: request.takesHolders, ...(request.sources ? { sourceGrant: request.sources } : {}) });
      res.json({
        id: minted.id, name: minted.name, token: minted.token,
        scopes_applied: request.scopes,
        sources_applied: request.sources ?? 'default',
        takes_holders_applied: request.takesHolders,
        defaults_applied: request.defaultsApplied,
      });
    } catch {
      res.status(500).json({ error: 'api_key_mint_failed', message: 'API key creation failed. Inspect the key list before retrying.' });
    }
  });

  app.post('/admin/api/api-keys/revoke', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const id = typeof req.body?.id === 'string' ? req.body.id : '';
    if (!TOKEN_ID_RE.test(id)) {
      sendError(res, 400, invalid('Revoke takes the key id (a UUID from the key list), not its name.', 'Resubmit with the id field from GET /admin/api/api-keys.',
        'Key names are not unique; revoking by name could cut off other keys that share it.', listAction('Lists every key with its id.')));
      return;
    }
    try {
      res.json({ id, revoked: await revokeLegacyTokenById(sqlQueryForEngine(engine), id) });
    } catch {
      res.status(500).json({ error: 'api_key_revoke_failed', message: 'Revoke failed. Refresh the key list before retrying.' });
    }
  });
}
