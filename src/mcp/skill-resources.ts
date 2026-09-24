import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { BrainEngine } from '../core/engine.ts';
import { operations } from '../core/operations.ts';
import { opAllowedForBoundClient } from '../core/ops/context.ts';
import { operationScopesAllowed } from '../core/scope.ts';
import { loadConfig } from '../core/config.ts';
import { disabledOpsForPublishGates } from './publish-gates.ts';
import { dispatchToolCall, type DispatchOpts } from './dispatch.ts';
import type { SharedSkillList, SharedSkillDetail } from '../core/shared-skills/model.ts';

export const SKILLS_RESOURCE_URI = 'gbrain://skills';

export interface SkillResources {
  list(): Promise<Array<{ uri: string; name: string; description: string; mimeType: string }>>;
  read(uri: string): Promise<{ contents: Array<{ uri: string; mimeType: string; text?: string; blob?: string }> }>;
}

export function sharedSkillResourceUri(qualifiedId: string, revision: string, path = 'SKILL.md'): string {
  return `${SKILLS_RESOURCE_URI}/${encodeURIComponent(qualifiedId)}/${encodeURIComponent(revision)}/${encodeURIComponent(path)}`;
}

export function createSkillResources(engine: BrainEngine, context: () => Promise<DispatchOpts>): SkillResources {
  async function permitted(name: string, opts: DispatchOpts): Promise<boolean> {
    const op = operations.find(candidate => candidate.name === name);
    if (!op || (opts.allowedOps && !opts.allowedOps.has(name))) return false;
    if (opts.remote === false) return true;
    if (op.localOnly || !opAllowedForBoundClient(opts.auth, op)) return false;
    if (opts.auth ? !operationScopesAllowed(opts.auth.scopes, op) : opts.transport !== 'stdio' || Boolean(op.requiredScopes?.length)) return false;
    return !(await disabledOpsForPublishGates(engine, opts.config ?? loadConfig())).has(name);
  }
  async function call<T>(name: string, params: Record<string, unknown>, opts: DispatchOpts): Promise<T> {
    if (!await permitted(name, opts)) throw new McpError(ErrorCode.InvalidParams, 'Unknown or unavailable skill resource');
    const result = await dispatchToolCall(engine, name, params, opts);
    const body = JSON.parse(result.content[0].text);
    if (result.isError) throw new McpError(ErrorCode.InternalError, 'Skill resource could not be read', { error: body.error });
    return body as T;
  }
  return {
    async list() {
      const opts = await context();
      return await permitted('list_skills', opts) ? [{ uri: SKILLS_RESOURCE_URI, name: 'Shared brain skills',
        description: 'Authorized, versioned skills and revision-bound resource links. Published content does not grant execution permissions.', mimeType: 'application/json' }] : [];
    },
    async read(uri) {
      if (typeof uri !== 'string' || uri.length > 8192) throw new McpError(ErrorCode.InvalidParams, 'Invalid skill resource');
      let url: URL;
      try { url = new URL(uri); } catch { throw new McpError(ErrorCode.InvalidParams, 'Invalid skill resource'); }
      if (url.protocol !== 'gbrain:' || url.hostname !== 'skills' || url.username || url.password || url.port || url.hash) {
        throw new McpError(ErrorCode.InvalidParams, 'Unknown skill resource');
      }
      const opts = await context();
      if (url.pathname === '' || url.pathname === '/') {
        if ([...url.searchParams.keys()].some(key => key !== 'cursor') || url.searchParams.getAll('cursor').length > 1) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid skill catalog query');
        }
        const catalog = await call<SharedSkillList>('list_skills', { schema_version: 2, ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}) }, opts);
        if (catalog.schema_version !== 2 || !Array.isArray(catalog.skills)) throw new McpError(ErrorCode.InternalError, 'Shared skill protocol is unavailable');
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ ...catalog,
          skills: catalog.skills.map((skill: { qualified_id: string; revision: string }) => ({ ...skill,
            uri: sharedSkillResourceUri(skill.qualified_id, skill.revision),
            manifest_uri: sharedSkillResourceUri(skill.qualified_id, skill.revision, '_manifest') })),
          ...(catalog.next_cursor ? { next_cursor_uri: `${SKILLS_RESOURCE_URI}?cursor=${encodeURIComponent(catalog.next_cursor)}` } : {}),
        }) }] };
      }
      if (url.search) throw new McpError(ErrorCode.InvalidParams, 'Invalid skill resource query');
      let parts: string[];
      try { parts = url.pathname.slice(1).split('/').map(decodeURIComponent); }
      catch { throw new McpError(ErrorCode.InvalidParams, 'Invalid skill resource path'); }
      if (parts.length !== 3 || parts.some(part => !part)) throw new McpError(ErrorCode.InvalidParams, 'Invalid skill resource path');
      const [qualified_id, revision, path] = parts;
      if (path === 'SKILL.md' || path === '_manifest') {
        const skill = await call<SharedSkillDetail>('get_skill', { schema_version: 2, qualified_id, revision }, opts);
        return { contents: [{ uri, mimeType: path === 'SKILL.md' ? 'text/markdown' : 'application/json',
          text: path === 'SKILL.md' ? skill.body : JSON.stringify({ ...skill, body: undefined,
            files: skill.files.map(file => ({ ...file, uri: sharedSkillResourceUri(qualified_id, revision, file.path) })) }) }] };
      }
      const asset = await call<{ media_type: string; content: string }>('get_skill_asset', { qualified_id, revision, path }, opts);
      return { contents: [{ uri, mimeType: asset.media_type, blob: asset.content }] };
    },
  };
}
