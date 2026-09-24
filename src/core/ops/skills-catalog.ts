/**
 * Skill catalog + advisor + status-snapshot operation cluster — pure move
 * from operations.ts (v0.46.x tranche 2). Op consts stay module-private;
 * `skillsCatalogOperations` below lists them in EXACTLY the order they
 * appear in the canonical `operations` array in ../operations.ts. Never
 * import from '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';
import { OperationError } from './contract.ts';
import {
  LIST_SKILLS_DESCRIPTION,
  GET_SKILL_DESCRIPTION,
} from '../operations-descriptions.ts';

// --- PR1: skill catalog over MCP (host-repo skills for thin clients) ---
// Both ops dynamically import ./skill-catalog.ts to avoid an import cycle
// (skill-catalog statically imports the `operations` array for D7 tool honesty).
// Read-scope, non-localOnly: a thin client (Codex/Perplexity/Cowork) reaches
// these over HTTP. The host-filesystem read is gated by mcp.publish_skills +
// path confinement — see the trust-boundary memo in skill-catalog.ts.

const list_skills: Operation = {
  name: 'list_skills',
  description: LIST_SKILLS_DESCRIPTION,
  publishGateKey: 'mcp.publish_skills',
  params: {
    schema_version: { type: 'number', description: 'Request 2 for the canonical source-qualified sealed catalog; omitted preserves version 1.' },
    limit: { type: 'number', description: 'Version 2 page size, 1-100.' },
    cursor: { type: 'string', description: 'Version 2 opaque snapshot cursor.' },
    source_id: { type: 'string', description: 'Narrow version 2 enumeration to one permitted source.' },
    section: {
      type: 'string',
      description: 'Optional: only skills whose routing section matches this exactly.',
    },
  },
  handler: async (ctx, p) => {
    if (p.schema_version === 2) return (await import('../shared-skills/catalog.ts')).listSharedSkills(ctx, p);
    if (p.schema_version !== undefined && p.schema_version !== 1) throw new OperationError('invalid_params', 'Supported skill catalog schema versions are 1 and 2.');
    const compatibility = await import('../shared-skills/compatibility.ts');
    if (await compatibility.sharedCatalogActive(ctx)) return compatibility.listLegacySharedSkills(ctx, typeof p.section === 'string' ? p.section : undefined);
    const sc = await import('../skill-catalog.ts');
    const publish = await sc.readMcpPublishSkills(ctx);
    sc.assertPublishEnabled(ctx, publish);
    const override = await sc.readMcpSkillsDir(ctx);
    const { dir, source } = sc.resolveSkillsDir(ctx, override);
    const section = typeof p.section === 'string' ? p.section : undefined;
    return sc.buildSkillCatalog(ctx, dir, source, { section });
  },
  scope: 'read',
  cliHints: { name: 'skills', positional: [] },
};

const get_skill: Operation = {
  name: 'get_skill',
  description: GET_SKILL_DESCRIPTION,
  publishGateKey: 'mcp.publish_skills',
  params: {
    schema_version: { type: 'number', description: 'Request 2 for an immutable canonical revision.' },
    qualified_id: { type: 'string', description: 'Exact version 2 qualified skill identity.' },
    expected_brain_id: { type: 'string', description: 'Assert the connected persistent brain identity from version 2 discovery. This never routes to another brain.' },
    source_incarnation: { type: 'string', description: 'Source incarnation from version 2 discovery.' },
    pack_id: { type: 'string', description: 'Canonical pack identifier.' },
    revision: { type: 'string', description: 'Exact immutable revision, or omit for the current head.' },
    name: {
      type: 'string',
      description: 'Skill name exactly as returned by list_skills (or the brain-pack skill slug when source_id is set).',
    },
    source_id: {
      type: 'string',
      description:
        'Optional: fetch a brain-resident pack skill from this source instead of the host catalog. ' +
        'Disambiguates a slug that exists on more than one source (see list_brain_skillpack).',
    },
  },
  handler: async (ctx, p) => {
    if (p.schema_version === 2) return (await import('../shared-skills/catalog.ts')).getSharedSkill(ctx, sharedSkillReadSelector(p));
    if (p.expected_brain_id !== undefined) throw new OperationError('invalid_params', 'expected_brain_id requires schema_version 2; it asserts identity and never selects a brain connection.');
    if (p.schema_version !== undefined && p.schema_version !== 1) throw new OperationError('invalid_params', 'Supported skill catalog schema versions are 1 and 2.');
    const compatibility = await import('../shared-skills/compatibility.ts');
    if (await compatibility.sharedCatalogActive(ctx)) return compatibility.getLegacySharedSkill(ctx, p.name, typeof p.source_id === 'string' ? p.source_id : undefined);
    const sc = await import('../skill-catalog.ts');
    const publish = await sc.readMcpPublishSkills(ctx);
    sc.assertPublishEnabled(ctx, publish);
    // Brain-resident path: when source_id is supplied, fetch the per-source pack
    // skill (confined to that source's pack root) rather than the host catalog.
    if (typeof p.source_id === 'string' && p.source_id.length > 0) {
      const brl = await import('../skillpack/brain-resident-locate.ts');
      const slug = typeof p.name === 'string' ? p.name : '';
      return brl.getResidentSkillDetail(ctx, p.source_id, slug);
    }
    const override = await sc.readMcpSkillsDir(ctx);
    const { dir } = sc.resolveSkillsDir(ctx, override);
    const name = typeof p.name === 'string' ? p.name : '';
    return sc.getSkillDetail(ctx, dir, name);
  },
  scope: 'read',
  cliHints: { name: 'skill', positional: ['name'] },
};

const sharedSkillKeyParams: Operation['params'] = {
  source_id: { type: 'string', description: 'Exactly one granted source.' },
  source_incarnation: { type: 'string', description: 'Expected source incarnation from the qualified catalog.' },
  pack_id: { type: 'string', required: true, description: 'Canonical pack identifier.' },
  name: { type: 'string', required: true, description: 'Canonical skill name.' },
};
function sharedSkillReadSelector(p: Record<string, unknown>) {
  return { name: p.name as string | undefined, qualified_id: p.qualified_id as string | undefined,
    brain_id: p.expected_brain_id as string | undefined, source_id: p.source_id as string | undefined,
    source_incarnation: p.source_incarnation as string | undefined, pack_id: p.pack_id as string | undefined,
    revision: p.revision as string | undefined };
}
const sharedSkillMutationParams: Operation['params'] = {
  ...sharedSkillKeyParams,
  request_id: { type: 'string', required: true, description: 'Durable idempotency UUID; reuse only with identical intent.' },
  expected_revision: { type: 'string', description: 'Current revision UUID; JSON null for creation.' },
};
const get_skill_asset: Operation = {
  name: 'get_skill_asset', description: 'Read a bounded, owner-approved file from an exact sealed skill revision. Does not execute downloaded bytes.',
  scope: 'read', publishGateKey: 'mcp.publish_skills',
  cliHints: { name: 'skill-asset', positional: [] },
  params: { source_id: sharedSkillKeyParams.source_id, source_incarnation: sharedSkillKeyParams.source_incarnation,
    name: { type: 'string', description: 'Skill name when not selecting by qualified_id.' },
    pack_id: { type: 'string', description: 'Pack identifier when not selecting by qualified_id.' },
    qualified_id: { type: 'string', description: 'Qualified skill key from version 2 discovery.' },
    expected_brain_id: { type: 'string', description: 'Assert this connected persistent brain identity without routing to another brain.' },
    revision: { type: 'string', required: true, description: 'Immutable revision from get_skill.' },
    path: { type: 'string', required: true, description: 'Exact path in the approved revision file manifest.' } },
  handler: async (ctx, p) => (await import('../shared-skills/catalog.ts')).getSharedSkillAsset(ctx, { ...sharedSkillReadSelector(p), path: String(p.path ?? '') }),
};
const put_skill: Operation = {
  name: 'put_skill', description: 'Publish a complete file-canonical skill revision with CAS and a durable receipt. Requires explicit skill editor authority; cannot expand publication policy.',
  scope: 'write', requiredScopes: ['skill_editor'], mutating: true,
  cliHints: { name: 'put-skill', positional: [] },
  params: { ...sharedSkillMutationParams, description: { type: 'string', description: 'Compact routing description.' },
    triggers: { type: 'array', items: { type: 'string' }, description: 'Routing phrases.' },
    requirements: { type: 'array', items: { type: 'string' }, description: 'Approved runtime and tool requirement tokens.' },
    private: { type: 'boolean', description: 'Exclude this skill from remote publication.' },
    files: { type: 'array', items: { type: 'object' }, required: true, description: 'Complete closure: path, content, encoding (utf8/base64), file_class, audience, media_type, depends_on.' } },
  handler: async (ctx, p) => (await import('../shared-skills/catalog.ts')).submitSharedSkillMutation(ctx, 'put_skill', p),
};
const delete_skill: Operation = {
  name: 'delete_skill', description: 'CAS-delete a canonical shared skill and revoke future managed activation. Previously downloaded bytes are not recalled.',
  scope: 'write', requiredScopes: ['skill_editor'], mutating: true, params: sharedSkillMutationParams,
  cliHints: { name: 'delete-skill', positional: [] },
  handler: async (ctx, p) => (await import('../shared-skills/catalog.ts')).submitSharedSkillMutation(ctx, 'delete_skill', p),
};
const import_skill_proposal: Operation = {
  name: 'import_skill_proposal', description: 'Publish explicitly reviewed human-edited canonical skill files through the durable coordinator. Requires exact current file hashes and skill revision; trusted local operator only.',
  scope: 'admin', localOnly: true, mutating: true,
  params: { ...put_skill.params, expected_hashes: { type: 'object', required: true, description: 'Reviewed current SHA-256 hashes for every affected file and skillpack.json; null denotes an absent file.' } },
  handler: async (ctx, p) => (await import('../shared-skills/publication.ts')).importSharedSkillProposal(ctx, p),
};
const set_skill_policy: Operation = {
  name: 'set_skill_policy', description: 'Explicitly approve a versioned shared-skill disclosure and follow policy. Separate publisher authority is required; editing a skill never grants this permission.',
  scope: 'admin', requiredScopes: ['skill_publisher'], mutating: true,
  cliHints: { name: 'set-skill-policy', positional: [] },
  params: { source_id: { type: 'string', required: true, description: 'Source whose publication policy is approved.' },
    expected_policy_epoch: { type: 'string', description: 'Previously reviewed policy epoch; null for initial policy.' },
    policy: { type: 'object', required: true, description: 'version:1, enabled, classes, audiences, requirements, allow_follow.' } },
  handler: async (ctx, p) => (await import('../shared-skills/policy.ts')).setSharedSkillPolicy(ctx, String(p.source_id),
    p.policy as import('../shared-skills/model.ts').SharedSkillPolicy, p.expected_policy_epoch as string | null | undefined),
};
const get_skill_policy: Operation = {
  name: 'get_skill_policy', description: 'Read the owner publication policy and CAS epoch, including when sharing is disabled. Does not approve or change disclosure.',
  scope: 'admin', requiredScopes: ['skill_publisher'],
  cliHints: { name: 'skill-policy', positional: [] },
  params: { source_id: { type: 'string', required: true, description: 'Source whose publication policy is reviewed.' } },
  handler: async (ctx, p) => (await import('../shared-skills/policy.ts')).getSharedSkillPolicy(ctx, String(p.source_id)),
};
const get_skill_retention: Operation = {
  name: 'get_skill_retention', description: 'Inspect retained shared-skill revision counts, protected leases and source storage capacity. Trusted host operator only.',
  scope: 'admin', localOnly: true,
  cliHints: { name: 'skill-retention', positional: [] },
  params: { source_id: { type: 'string', description: 'Canonical source to inspect.' } },
  handler: async (ctx, p) => (await import('../shared-skills/retention.ts')).getSharedSkillRetention(ctx, typeof p.source_id === 'string' ? p.source_id : ctx.sourceId),
};
const prune_skill_revisions: Operation = {
  name: 'prune_skill_revisions', description: 'Prune one bounded batch of expired shared-skill history. Preserves heads, tombstones, pending publication refs, delivery leases, pins and permanent write receipts.',
  scope: 'admin', localOnly: true, mutating: true,
  cliHints: { name: 'prune-skill-revisions', positional: [] },
  params: { source_id: { type: 'string', description: 'Canonical source to prune.' } },
  handler: async (ctx, p) => (await import('../shared-skills/retention.ts')).pruneSharedSkillRevisions(ctx, typeof p.source_id === 'string' ? p.source_id : ctx.sourceId),
};
const retain_skill_revision: Operation = {
  name: 'retain_skill_revision', description: 'Pin an exact shared-skill revision for up to 24 hours under a bounded operator quota. Does not grant read or execution permission.',
  scope: 'admin', localOnly: true, mutating: true,
  cliHints: { name: 'retain-skill-revision', positional: [] },
  params: { ...sharedSkillKeyParams, source_incarnation: { type: 'string', required: true, description: 'Exact source incarnation.' },
    revision: { type: 'string', required: true, description: 'Exact existing immutable revision.' }, hours: { type: 'number', description: 'Pin lifetime greater than zero and at most 24 hours.' } },
  handler: async (ctx, p) => (await import('../shared-skills/retention.ts')).retainSharedSkillRevision(ctx,
    p as unknown as Parameters<typeof import('../shared-skills/retention.ts').retainSharedSkillRevision>[1]),
};

const list_brain_skillpack: Operation = {
  name: 'list_brain_skillpack',
  description:
    'List brain-resident skillpacks this brain ships (per-source). Returns each pack\'s skills, ' +
    'one-line descriptions, the schema pack it targets + whether that matches this brain, and a ' +
    'git scaffold spec. Read-only; gated by mcp.publish_skills. After orienting, call this and ' +
    'ask the user whether to install any pack the brain offers (gbrain skillpack scaffold <spec>).',
  publishGateKey: 'mcp.publish_skills',
  params: {},
  handler: async (ctx) => {
    const compatibility = await import('../shared-skills/compatibility.ts');
    if (await compatibility.sharedCatalogActive(ctx)) return compatibility.listLegacySharedPacks(ctx);
    const sc = await import('../skill-catalog.ts');
    const publish = await sc.readMcpPublishSkills(ctx);
    sc.assertPublishEnabled(ctx, publish);
    const brl = await import('../skillpack/brain-resident-locate.ts');
    return brl.loadResidentPacksForServer(ctx);
  },
  scope: 'read',
  cliHints: { name: 'brain-skillpack', positional: [] },
};

const advisor: Operation = {
  name: 'advisor',
  description:
    'Ranked, read-only "what to do next" for this brain: version drift, pending migrations, ' +
    'schema-pack issues, stalled jobs, usage-shape gaps, and setup smells. Each finding has a ' +
    'severity, why-it-matters, and the exact fix command. Never mutates. Tell the user; ask ' +
    'before running any fix. Gated by mcp.publish_advisor (separate from mcp.publish_skills ' +
    'because diagnostics are not prose skills).',
  publishGateKey: 'mcp.publish_advisor',
  params: {},
  handler: async (ctx) => {
    // Publish gate: a remote caller needs mcp.publish_advisor=true. Local
    // (ctx.remote === false) callers bypass — the trust boundary is the OS.
    if (ctx.remote !== false) {
      let enabled = false;
      try {
        const dbVal = await ctx.engine.getConfig('mcp.publish_advisor');
        enabled = dbVal != null ? dbVal === 'true' : ctx.config?.mcp?.publish_advisor === true;
      } catch {
        enabled = ctx.config?.mcp?.publish_advisor === true;
      }
      if (!enabled) {
        // Same k=v detail grammar as assertPublishEnabled (WP1): honest
        // catalogs hide this op at list time; the throw is the backstop.
        const err = new OperationError(
          'permission_denied',
          'The advisor is not published over MCP by the brain owner, so it is hidden from your ' +
            'tool catalog. Ask the owner to enable it if you need it.',
          'The owner can enable it with `gbrain config set mcp.publish_advisor true`.',
        );
        err.detail = 'config_key=mcp.publish_advisor';
        throw err;
      }
    }
    const { runAdvisor } = await import('../advisor/run.ts');
    const { VERSION } = await import('../../version.ts');
    // Over MCP there is no agent workspace on the server side: remote=true makes
    // runAdvisor drop workspace-dependent collectors (A1). The op never writes
    // history or nag state — it is strictly read-only.
    const report = await runAdvisor({
      engine: ctx.engine,
      config: ctx.config,
      version: VERSION,
      workspace: null,
      skillsDir: null,
      now: new Date(),
      remote: ctx.remote !== false,
    });
    return report;
  },
  scope: 'read',
  // NOT localOnly — exposed over MCP (E1) behind mcp.publish_advisor.
  // No cliHints: the CLI surface is the richer `gbrain advisor` command
  // (commands/advisor.ts) which adds --json exit codes + --apply.
  cliHints: { name: 'advisor', hidden: true },
};

/**
 * v0.41.19.0 — `gbrain status` thin-client surface.
 *
 * Returns a snapshot of sync freshness + last cycle state for thin-client
 * `gbrain status` callers. Per D2/D10 in the plan:
 *
 *   - Scope: admin (NOT localOnly). The op exposes operational state
 *     including sync timestamps and cycle metadata. Locking it to admin
 *     matches the `run_doctor` posture and prevents future feature creep
 *     from quietly leaking ops state to read-scoped clients.
 *
 *   - Payload (schema_version 2, Minions-visibility wave): `{schema_version,
 *     version, sync, cycle, queue, workers}`. `queue` (status counts +
 *     per-queue waiting depth + oldest-waiting age) and `workers`
 *     (supervisor liveness via pidfile/DB-lock + last completed job) were
 *     added so a remote submitter can see whether the lane its job ids point
 *     at is actually alive. Locks and Autopilot stay deliberately omitted —
 *     host-local concerns the thin client renders as "N/A on remote brain".
 *
 *   - Fail-soft (amendment 26): each v2 section computes in its own
 *     try/catch and degrades to `{error: 'unavailable'}` without failing
 *     the whole snapshot.
 *
 *   - The local CLI composes the same data plus the local-only sections
 *     directly (no MCP round-trip when running against ~/.gbrain).
 */
const get_status_snapshot: Operation = {
  name: 'get_status_snapshot',
  description: 'Snapshot for `gbrain status` thin-client mode: sync freshness + last cycle + queue depths + worker liveness. Admin-scope.',
  params: {},
  handler: async (ctx) => {
    const { buildSyncStatusReport } = await import('../../commands/sync.ts');
    const { buildCycleSnapshot } = await import('../../commands/status.ts');
    // Pull sources first (handles brains with zero declared sources too).
    let sources: Array<{ id: string; name: string; local_path: string | null; config: Record<string, unknown> }> = [];
    try {
      const rows = await ctx.engine.executeRaw<{
        id: string;
        name: string;
        local_path: string | null;
        config: Record<string, unknown> | null;
      }>(
        `SELECT id, name, local_path, config FROM sources WHERE COALESCE(archived, FALSE) = FALSE ORDER BY id`,
      );
      sources = rows.map((r) => ({
        id: r.id,
        name: r.name,
        local_path: r.local_path,
        config: r.config ?? {},
      }));
    } catch {
      // Pre-v0.26.5 brains may lack the `archived` column; degrade to all rows.
      const rows = await ctx.engine.executeRaw<{
        id: string;
        name: string;
        local_path: string | null;
        config: Record<string, unknown> | null;
      }>(`SELECT id, name, local_path, config FROM sources ORDER BY id`);
      sources = rows.map((r) => ({
        id: r.id,
        name: r.name,
        local_path: r.local_path,
        config: r.config ?? {},
      }));
    }
    const sync = await buildSyncStatusReport(ctx.engine, sources);
    const cycle = await buildCycleSnapshot(ctx.engine);
    // v2 sections, each fail-soft (amendment 26): a broken/pre-migration
    // queue table must not take down the sync/cycle payload that v1 clients
    // already depend on.
    let queue: unknown;
    try {
      const { buildQueueCounts, buildQueueDepths } = await import('../../commands/status.ts');
      queue = { counts: await buildQueueCounts(ctx.engine), by_queue: await buildQueueDepths(ctx.engine) };
    } catch {
      queue = { error: 'unavailable' as const };
    }
    let workers: unknown;
    try {
      const { buildWorkersSnapshot } = await import('../../commands/status.ts');
      workers = await buildWorkersSnapshot(ctx.engine);
    } catch {
      workers = { error: 'unavailable' as const };
    }
    // #1984: report the brain server's version so a thin-client `gbrain status`
    // can surface remote_version alongside its own local CLI version.
    const { VERSION } = await import('../../version.ts');
    return { schema_version: 2 as const, version: VERSION, sync, cycle, queue, workers };
  },
  scope: 'admin',
  localOnly: false,
};


// Ops in EXACTLY the canonical `operations` array order.
export const skillsCatalogOperations: Operation[] = [
  list_skills, get_skill, list_brain_skillpack, advisor, get_status_snapshot,
  get_skill_asset, put_skill, delete_skill, set_skill_policy, get_skill_policy,
  get_skill_retention, prune_skill_revisions, retain_skill_revision,
  import_skill_proposal,
];
