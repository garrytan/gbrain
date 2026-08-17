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
    section: {
      type: 'string',
      description: 'Optional: only skills whose routing section matches this exactly.',
    },
  },
  handler: async (ctx, p) => {
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
    name: {
      type: 'string',
      required: true,
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
];
