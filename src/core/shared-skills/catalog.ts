import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { hostFix } from '../ops/op-fix.ts';
import { catalogFix, skillHeadFix } from './fixes.ts';
import { sourceScopeOpts } from '../ops/context.ts';
import { stableJson } from '../persistence/digest.ts';
import { approvedFiles, authorizeSkillRead, legacySharedSkillPolicy, normalizePolicy, publicationEnabled, readSharedSkillPolicy, skillPrincipal } from './policy.ts';
import { skillName, skillPath, skillToolsDeclared } from './manifest.ts';
import { SHARED_SKILL_LIMITS, type SharedSkillDetail, type SharedSkillKey, type SharedSkillList, type SharedSkillSelector,
  type SharedSkillSummary, type SharedSkillPolicy, type StoredSkillRevision } from './model.ts';

export function qualifiedSkillId(key: SharedSkillKey): string {
  return `skill:${[key.brain_id, key.source_id, key.source_incarnation, key.pack_id, key.name].map(encodeURIComponent).join(':')}`;
}
const QUALIFIED_ID_HINT = 'Pass qualified_id exactly as list_skills (schema_version 2) returned it; it is an opaque, URL-encoded key, never built by hand.';
export function parseQualifiedSkillId(value: string): SharedSkillKey {
  const parts = value.split(':');
  if (parts.length !== 6 || parts.shift() !== 'skill') throw opError('invalid_params', 'Invalid qualified skill key.', QUALIFIED_ID_HINT, { fix: catalogFix() });
  try {
    const [brain_id, source_id, source_incarnation, pack_id, name] = parts.map(decodeURIComponent);
    skillName(pack_id, 'pack_id'); skillName(name);
    return { brain_id, source_id, source_incarnation, pack_id, name };
  } catch { throw opError('invalid_params', 'Invalid qualified skill key.', QUALIFIED_ID_HINT, { fix: catalogFix() }); }
}
async function identity(ctx: OperationContext) {
  const [row] = await ctx.engine.executeRaw<{ brain_id: string; token_secret: string; serving_epoch: string }>(
    'SELECT b.brain_id,s.token_secret,s.serving_epoch FROM persistence_brain b CROSS JOIN shared_skill_state s WHERE b.singleton=1 AND s.singleton=1');
  if (!row) throw new OperationError('catalog_unavailable', 'Shared skill storage is not initialized.', 'Apply host migrations before retrying.');
  return row;
}
function opaque(secret: string, value: unknown): string { return createHmac('sha256', Buffer.from(secret, 'hex')).update(stableJson(value)).digest('base64url'); }
function encodeCursor(secret: string, value: unknown): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(secret, 'hex'), nonce, { authTagLength: 16 });
  const content = Buffer.concat([cipher.update(stableJson(value), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), content]).toString('base64url');
}
function decodeCursor(secret: string, value: string): { auth: string; view: string; offset: number; limit: number; expires: number } {
  try {
    if (value.length > 4096) throw new Error();
    const data = Buffer.from(value, 'base64url');
    if (data.length < 28) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(secret, 'hex'), data.subarray(0, 12), { authTagLength: 16 });
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString());
  } catch {
    throw opError('full_resync_required', 'The catalog cursor is invalid or expired.',
      'Restart enumeration: call list_skills with schema_version 2 and no cursor, and replace every page read so far with the new snapshot.', { fix: catalogFix() });
  }
}
async function readSnapshot(ctx: OperationContext, selector: SharedSkillSelector = {}) {
  const ids = sourceScopeOpts(ctx);
  const sourceIds = ids.sourceIds ?? (ids.sourceId ? [ids.sourceId] : null);
  const rows = await ctx.engine.executeRaw<Omit<StoredSkillRevision, 'files'> & { current_policy: SharedSkillPolicy | null; current_epoch: string | null }>(`SELECT h.*,p.policy AS current_policy,p.epoch AS current_epoch FROM shared_skill_heads h
    JOIN sources s ON s.id=h.source_id AND s.incarnation=h.source_incarnation
    LEFT JOIN shared_skill_policies p ON p.source_id=h.source_id AND p.source_incarnation=h.source_incarnation
    WHERE NOT h.deleted AND NOT s.archived AND ($1::text[] IS NULL OR h.source_id=ANY($1::text[]))
    AND ($3::text IS NULL OR h.source_id=$3) AND ($4::text IS NULL OR h.source_incarnation::text=$4)
    AND ($5::text IS NULL OR h.pack_id=$5) AND ($6::text IS NULL OR h.name=$6)
    AND ($7::boolean=false OR COALESCE((h.metadata->>'private')::boolean,false)=false)
    ORDER BY h.source_id,h.source_incarnation,h.pack_id,h.name LIMIT $2`,
  [sourceIds, SHARED_SKILL_LIMITS.catalogSkills + 1, selector.source_id ?? null, selector.source_incarnation ?? null, selector.pack_id ?? null, selector.name ?? null, ctx.remote !== false]);
  if (rows.length > SHARED_SKILL_LIMITS.catalogSkills) {
    throw opError('catalog_unavailable', 'The authorized catalog exceeds its bounded snapshot limit.',
      `More than ${SHARED_SKILL_LIMITS.catalogSkills} skills match; narrow the request to one source with source_id (and pack_id or name where known).`);
  }
  const brain = await identity(ctx);
  const enabled = await publicationEnabled(ctx);
  if (ctx.remote !== false && !enabled) {
    throw opError('permission_denied', 'Shared skills are not published by this brain.',
      'The brain owner has not enabled mcp.publish_skills, so connections like this one see no shared skills. Ask the user whether the owner wants to publish them; only the brain host can turn it on.',
      { fix: hostFix(ctx, ['gbrain', 'config', 'set', 'mcp.publish_skills', 'true'], 'Publishes the owner-approved shared skills to authenticated MCP connections; each source\'s publication policy still limits what they see.', { consent: ['egress'] }) });
  }
  const principal = skillPrincipal(ctx);
  const { sharedSkillToolAccess } = await import('./tool-access.ts');
  const availableTools = new Set(await sharedSkillToolAccess(ctx));
  const skills: SharedSkillSummary[] = [];
  for (const row of rows) {
    const policy = row.current_policy ? { epoch: row.current_epoch!, policy: normalizePolicy(row.current_policy) } : legacySharedSkillPolicy(enabled);
    if (!policy.policy.enabled || ctx.remote !== false && row.metadata.private ||
      !row.metadata.audience.some(a => (a === 'readers' || a === principal) && policy!.policy.audiences.includes(a))) continue;
    const skillKey = { brain_id: brain.brain_id, source_id: row.source_id, source_incarnation: row.source_incarnation, pack_id: row.pack_id, name: row.name };
    const { file_policy, tools_declared: _toolsDeclared, ...metadata } = row.metadata;
    const inherits = !skillToolsDeclared(row.metadata, null);
    const complete = file_policy.every(f => policy!.policy.classes.includes(f.file_class) && f.audience.some(a => (a === 'readers' || a === principal) && policy!.policy.audiences.includes(a)));
    const tools = metadata.requirements.filter(r => r.startsWith('tool:')).map(r => r.slice(5));
    const unavailable = metadata.requirements.filter(r => !r.startsWith('tool:') || !availableTools.has(r.slice(5)) ||
      row.current_policy !== null && !policy.policy.requirements.includes(r));
    skills.push({ ...skillKey, ...metadata, audience: metadata.audience.filter(a => a === 'readers' || a === principal), qualified_id: qualifiedSkillId(skillKey), revision: row.revision,
      policy_epoch: policy.epoch, allow_follow: policy.policy.allow_follow,
      delivery: complete ? 'complete' : 'prose_only', usable: complete && unavailable.length === 0,
      usable_tools: inherits ? [...availableTools] : tools.filter(t => availableTools.has(t)), unavailable_tools: inherits ? [] : tools.filter(t => !availableTools.has(t)), unavailable_requirements: unavailable });
  }
  const auth = opaque(brain.token_secret, { principal, sources: sourceIds, scopes: ctx.auth?.scopes,
    operations: ctx.auth?.allowedOperations, surface: ctx.auth?.effectiveSurface, grant_revision: ctx.auth?.grantRevision, serving_epoch: brain.serving_epoch });
  const view = opaque(brain.token_secret, { auth, skills });
  return { brain, auth, view, skills, enabled, principal };
}
async function catalogRead<T>(ctx: OperationContext, operation: string, run: (ctx: OperationContext) => Promise<T>): Promise<T> {
  try {
    return await ctx.engine.transaction(async tx => run(await authorizeSkillRead({ ...ctx, engine: tx }, operation)));
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw new OperationError('catalog_unavailable', 'The authoritative catalog could not be read.', 'Retry without advancing a cursor or deleting installed files.');
  }
}
export async function listSharedSkills(ctx: OperationContext, params: { limit?: number; cursor?: string; source_id?: string } = {}): Promise<SharedSkillList> {
  return catalogRead(ctx, 'list_skills', async active => {
    const snapshot = await readSnapshot(active, { source_id: params.source_id });
    const limit = params.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > SHARED_SKILL_LIMITS.pageSize) {
      throw opError('invalid_params', 'Catalog limit must be 1-100.', `Pass limit as a whole number from 1 to ${SHARED_SKILL_LIMITS.pageSize}, or omit it for 50.`);
    }
    const skills = params.source_id ? snapshot.skills.filter(s => s.source_id === params.source_id) : snapshot.skills;
    const view = opaque(snapshot.brain.token_secret, { view: snapshot.view, source: params.source_id ?? null });
    let offset = 0;
    if (params.cursor) {
      const cursor = decodeCursor(snapshot.brain.token_secret, params.cursor);
      if (cursor.auth !== snapshot.auth || cursor.view !== view || cursor.limit !== limit || cursor.expires < Date.now() || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) {
        throw opError('full_resync_required', 'The authorized catalog changed; restart enumeration.',
          'The catalog or this connection\'s grant changed since the cursor was issued (or it expired after 15 minutes). Restart with list_skills schema_version 2, the same limit and no cursor, and replace every page read so far.',
          { fix: catalogFix(params.source_id) });
      }
      offset = cursor.offset;
    }
    return { schema_version: 2, brain_id: snapshot.brain.brain_id, view_token: view, skills: skills.slice(offset, offset + limit),
      ...(offset + limit < skills.length ? { next_cursor: encodeCursor(snapshot.brain.token_secret,
        { auth: snapshot.auth, view, offset: offset + limit, limit, expires: Date.now() + 15 * 60_000 }) } : {}) };
  });
}
function selectSkill(skills: SharedSkillSummary[], params: SharedSkillSelector): SharedSkillSummary {
  const supplied: SharedSkillSelector = params.qualified_id ? parseQualifiedSkillId(params.qualified_id) : params;
  if (!supplied.name) {
    throw opError('invalid_params', 'name or qualified_id is required.',
      'Pass the qualified_id list_skills (schema_version 2) returned, or name with pack_id and source_id.', { fix: catalogFix(params.source_id) });
  }
  skillName(supplied.name);
  if (params.qualified_id && Object.entries(supplied).some(([key, value]) => params[key as keyof SharedSkillSelector] !== undefined && params[key as keyof SharedSkillSelector] !== value)) {
    throw opError('invalid_params', 'Qualified key disagrees with selector fields.',
      'Pass qualified_id alone, or selector fields (source_id, source_incarnation, pack_id, name) that match it; drop the conflicting fields.');
  }
  const matches = skills.filter(skill => ['brain_id', 'source_id', 'source_incarnation', 'pack_id', 'name'].every(key =>
    supplied[key as keyof SharedSkillSelector] === undefined || supplied[key as keyof SharedSkillSelector] === skill[key as keyof SharedSkillSummary]));
  if (!matches.length) {
    throw opError('skill_not_found', 'No authorized published skill matches this key.',
      'No published skill this connection may read matches the selector. List the catalog for the exact name, pack_id and source_id.', { fix: catalogFix(supplied.source_id) });
  }
  if (matches.length > 1) throw new OperationError('ambiguous_skill', 'This name belongs to multiple authorized sources.', 'Use a qualified_id from list_skills schema_version=2.');
  return matches[0];
}
async function detail(active: OperationContext, params: SharedSkillSelector) {
  const selector = params.qualified_id ? parseQualifiedSkillId(params.qualified_id) : params;
  const snapshot = await readSnapshot(active, selector);
  const selected = selectSkill(snapshot.skills, params);
  const revision = params.revision ?? selected.revision;
  if (typeof revision !== 'string' || !/^[0-9a-f-]{36}$/i.test(revision)) {
    throw opError('invalid_params', 'Invalid skill revision.', 'Pass revision as the UUID list_skills or get_skill returned, or omit it for the current head.',
      { fix: skillHeadFix(selected.source_id, selected.pack_id, selected.name) });
  }
  const [row] = await active.engine.executeRaw<StoredSkillRevision>(`SELECT * FROM shared_skill_revisions
    WHERE source_id=$1 AND source_incarnation=$2::uuid AND pack_id=$3 AND name=$4 AND revision=$5::uuid AND NOT deleted`,
  [selected.source_id, selected.source_incarnation, selected.pack_id, selected.name, revision]);
  if (!row || active.remote !== false && row.metadata.private) {
    throw opError('revision_unavailable', 'The exact authorized revision is unavailable.',
      `That revision of ${selected.pack_id}/${selected.name} was deleted, pruned or is private. Read the current head instead (omit revision).`,
      { fix: skillHeadFix(selected.source_id, selected.pack_id, selected.name) });
  }
  const { epoch, policy } = await readSharedSkillPolicy(active.engine, selected.source_id, selected.source_incarnation, snapshot.enabled);
  const files = approvedFiles(row.files, policy, snapshot.principal);
  const main = files.find(f => f.path === `skills/${selected.name}/SKILL.md`);
  if (!main) {
    throw opError('skill_not_found', 'This skill is not published to the current audience.',
      `${selected.pack_id}/${selected.name}'s SKILL.md is not approved for this connection's audience under source ${selected.source_id}'s policy; only the publisher can change that.`,
      { fix: catalogFix(selected.source_id) });
  }
  const visible = new Set(files.map(f => f.path));
  const complete = files.length === row.files.length && files.every(f => f.depends_on.every(d => visible.has(d)));
  const { file_policy: _filePolicy, tools_declared: _toolsDeclared, ...metadata } = row.metadata;
  const { sharedSkillToolAccess } = await import('./tool-access.ts');
  const access = await sharedSkillToolAccess(active);
  const tools = new Set(access);
  const body = Buffer.from(main.content, 'base64').toString('utf8');
  const inherits = !skillToolsDeclared(row.metadata, body);
  const declaredTools = metadata.requirements.filter(r => r.startsWith('tool:')).map(r => r.slice(5));
  const unavailable = metadata.requirements.filter(r => !r.startsWith('tool:') || !tools.has(r.slice(5)) ||
    !['legacy-prose', 'consent-required'].includes(epoch) && !policy.requirements.includes(r));
  const result: SharedSkillDetail = { ...selected, ...metadata, audience: metadata.audience.filter(a => a === 'readers' || a === snapshot.principal), revision: row.revision, schema_version: 2,
    delivery: complete ? 'complete' : 'prose_only', body,
    usable_tools: inherits ? access : declaredTools.filter(t => tools.has(t)), unavailable_tools: inherits ? [] : declaredTools.filter(t => !tools.has(t)),
    unavailable_requirements: unavailable, usable: complete && unavailable.length === 0,
    files: files.map(({ content: _content, ...file }) => ({ ...file, audience: file.audience.filter(a => a === 'readers' || a === snapshot.principal), depends_on: file.depends_on.filter(d => visible.has(d)) })) };
  return { result, files };
}
export async function getSharedSkill(ctx: OperationContext, params: SharedSkillSelector): Promise<SharedSkillDetail> {
  return catalogRead(ctx, 'get_skill', async active => (await detail(active, params)).result);
}
export async function getSharedSkillAsset(ctx: OperationContext, params: SharedSkillSelector & { path: string }) {
  return catalogRead(ctx, 'get_skill_asset', async active => {
    if (!params.revision) {
      throw opError('invalid_params', 'Asset reads require the exact approved revision.',
        'Pass revision from get_skill (schema_version 2) for this skill; asset reads never follow the moving head.',
        params.source_id && params.pack_id && params.name ? { fix: skillHeadFix(params.source_id, params.pack_id, params.name) } : {});
    }
    skillPath(params.path);
    const { result, files } = await detail(active, params);
    const file = files.find(f => f.path === params.path);
    if (!file) {
      throw opError('skill_asset_not_found', 'The requested file is not in the approved revision manifest.',
        `Request one of the paths in the files list get_skill returns for revision ${result.revision} of ${result.pack_id}/${result.name}; other paths are not approved for this connection.`,
        { fix: skillHeadFix(result.source_id, result.pack_id, result.name, result.revision) });
    }
    return { schema_version: 2 as const, brain_id: result.brain_id, source_id: result.source_id, source_incarnation: result.source_incarnation,
      pack_id: result.pack_id, name: result.name, revision: result.revision, path: file.path,
      encoding: 'base64' as const, content: file.content, sha256: file.sha256, size: file.size, media_type: file.media_type };
  });
}
export { submitSharedSkillMutation, adoptSharedSkillpack, importSharedSkillProposal } from './publication.ts';
