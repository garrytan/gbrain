import express, { type Express, type Request, type Response, type RequestHandler } from 'express';
import type { BrainEngine } from '../core/engine.ts';
import { OperationError } from '../core/ops/contract.ts';
import { addMember, bindCredential, disableMember, enableMember, listMembers, setMemberEmail, type BindingPatch } from '../core/access/members.ts';
import { ATTEST_SYSTEMS, linkMember, linkMemberByEmail, listMemberLinks, parseAttestOps, unlinkMember } from '../core/access/actor.ts';
import { operationsByName } from '../core/operations.ts';
import { executeRawJsonb } from '../core/sql-query.ts';

/**
 * GST-1094 gap 4: owner administration of the people a trusted system serves, over the running server: the attest
 * right on a client, members, and the canonical ids linked to them. Owner session only (requireAdmin); never an MCP
 * operation or an OAuth scope. Every refusal is the library's, as on the local CLI (gbrain auth rescope --attest-actor,
 * gbrain access member add|disable|enable|link|unlink).
 *
 * GST-1158: a member's declared email is set on add or with action set, and a link may name the member by that email
 * instead of its id. Only here and on the brain host: no MCP operation or OAuth scope reads or sets it.
 */
export function mountAdminAccess(app: Express, requireAdmin: RequestHandler, engine: BrainEngine): void {
  app.get('/admin/api/access/members', requireAdmin, async (req, res) => {
    await answer(res, false, async () => ({ members: await listMembers(engine, { includeRemoved: req.query.all === '1' || req.query.all === 'true' }) }));
  });

  app.post('/admin/api/access/members', requireAdmin, express.json(), async (req, res) => {
    const { action, id } = req.body ?? {};
    if (action !== 'add' && action !== 'set' && action !== 'disable' && action !== 'enable') return refuse(res, 'action must be add, set, disable or enable.');
    if (action === 'add' && req.body.email !== undefined && typeof req.body.email !== 'string') return refuse(res, 'email must be a string.');
    if (action === 'set' && !(typeof req.body.email === 'string' || req.body.email === null)) return refuse(res, 'set needs email: an address, or null to clear it.');
    if (action === 'add' && req.body.name !== undefined && typeof req.body.name !== 'string') return refuse(res, 'name must be a string.');
    if (action === 'add' && req.body.groups !== undefined && !(Array.isArray(req.body.groups) && req.body.groups.every((g: unknown) => typeof g === 'string'))) return refuse(res, 'groups must be an array of group ids.');
    await answer(res, true, async () => {
      if (action === 'add') {
        const result = await addMember(engine, id, { name: req.body.name, email: req.body.email, groups: req.body.groups });
        await audit(engine, 'member_add', { member: result.member.id, groups_created: result.groups_created });
        return { applied: true, ...result };
      }
      if (action === 'set') {
        const result = await setMemberEmail(engine, id, req.body.email);
        if (result.changed) await audit(engine, 'member_set', { member: result.member.id, email: result.member.email === null ? 'cleared' : 'declared' });
        return { applied: result.changed, ...result };
      }
      const member = await (action === 'disable' ? disableMember : enableMember)(engine, id);
      await audit(engine, `member_${action}`, { member: member.id });
      return { applied: true, member };
    });
  });

  app.get('/admin/api/access/member-links', requireAdmin, async (req, res) => {
    const member = typeof req.query.member === 'string' && req.query.member ? req.query.member : undefined;
    await answer(res, false, async () => ({ links: await listMemberLinks(engine, { member }) }));
  });

  app.post('/admin/api/access/member-links', requireAdmin, express.json(), async (req, res) => {
    const { action, member, email, externalId, dryRun } = req.body ?? {};
    const system = req.body?.system ?? 'qm';
    if (action !== 'link' && action !== 'unlink') return refuse(res, 'action must be link or unlink.');
    if (email !== undefined && (action !== 'link' || member !== undefined || typeof email !== 'string')) return refuse(res, 'email names the member of a link, instead of member; it is a string and only link takes it.');
    if (!ATTEST_SYSTEMS.includes(system)) return refuse(res, `system must be ${ATTEST_SYSTEMS.join(' or ')}.`);
    if (dryRun !== undefined && typeof dryRun !== 'boolean') return refuse(res, 'dryRun must be a boolean.');
    await answer(res, dryRun !== true, async () => {
      const result = action === 'unlink' ? await unlinkMember(engine, system, externalId, { dryRun })
        : email !== undefined ? await linkMemberByEmail(engine, email, system, externalId, { dryRun }) : await linkMember(engine, member, system, externalId, { dryRun });
      if (result.applied) await audit(engine, `member_${action}`, { system, external_id: result.link.external_id, member: result.link.member_id });
      return result;
    });
  });

  app.post('/admin/api/access/attest', requireAdmin, express.json(), async (req, res) => {
    const { clientId, attestActor, attestOps, dryRun } = req.body ?? {};
    if (typeof clientId !== 'string' || !clientId) return refuse(res, 'clientId required.');
    if (attestActor === undefined && attestOps === undefined) return refuse(res, 'Pass attestActor (qm or null) and/or attestOps.');
    if (attestActor !== undefined && attestActor !== null && !ATTEST_SYSTEMS.includes(attestActor)) return refuse(res, `attestActor must be ${ATTEST_SYSTEMS.join(' or ')}, or null to clear the right.`);
    if (attestOps !== undefined && attestOps !== null && !(Array.isArray(attestOps) && attestOps.every((op: unknown) => typeof op === 'string'))) return refuse(res, 'attestOps must be an array of operation names, or null for the default.');
    if (dryRun !== undefined && typeof dryRun !== 'boolean') return refuse(res, 'dryRun must be a boolean.');
    await answer(res, dryRun !== true, async () => {
      const patch: BindingPatch = {
        ...(attestActor !== undefined ? { attestActor } : {}),
        ...(attestOps !== undefined ? { attestOps: attestOps === null ? null : parseAttestOps(attestOps.join(','), name => operationsByName[name]) } : {}),
      };
      const result = await bindCredential(engine, { kind: 'client', id: clientId }, patch, { dryRun });
      if (result.changed && !dryRun) await audit(engine, 'client_attest', { client_id: clientId, attest_actor: result.attest_actor ?? null, attest_ops: result.attest_ops ?? null });
      return { applied: result.changed && dryRun !== true, client_id: clientId, attest_actor: result.attest_actor ?? null, attest_ops: result.attest_ops ?? null, changed: result.changed,
        tokenImplications: 'Takes effect on the next request; a client that newly holds the right takes a new token with grant_type=client_credentials.' };
    });
  });
}

const PROPOSAL_PAGE = 50;
const PROPOSAL_DECISION_FIELDS = ['action', 'reason', 'dryRun'];

/**
 * GST-2407: the owner's review of memory proposals (memory_propose) over the running server, the remote twin of
 * gbrain memory-proposals list|show|approve|deny. Approve and deny run the command's own library calls (one transaction,
 * the stored actor and page revision re-checked, publication through the writer door) with decided_by admin-api. The
 * proposed text is shown only inside the transcript fence, each decision names exactly one request id, and each
 * applied decision leaves one audit row that never carries the proposed text.
 */
export function mountAdminMemoryProposals(app: Express, requireAdmin: RequestHandler, engine: BrainEngine): void {
  app.get('/admin/api/memory-proposals', requireAdmin, async (req, res) => {
    const sourceId = typeof req.query.source === 'string' && req.query.source ? req.query.source : undefined;
    const after = typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : undefined;
    await answer(res, false, async () => {
      const { listMemoryProposals, proposalCursor } = await import('../core/persistence/memory-proposals.ts');
      const { ownerView } = await import('./memory-proposals.ts');
      const rows = await listMemoryProposals(engine, { sourceId, after, limit: PROPOSAL_PAGE });
      return { proposals: await Promise.all(rows.map(ownerView)), next_cursor: rows.length === PROPOSAL_PAGE ? proposalCursor(rows.at(-1)!) : null };
    });
  });

  app.get('/admin/api/memory-proposals/:request_id', requireAdmin, async (req, res) => {
    await answer(res, false, async () => {
      const { ownerProposal } = await import('../core/persistence/memory-proposals.ts');
      const { ownerView } = await import('./memory-proposals.ts');
      return ownerView(await ownerProposal(engine, String(req.params.request_id)));
    });
  });

  app.post('/admin/api/memory-proposals/:request_id', requireAdmin, express.json(), async (req, res) => {
    const body = req.body ?? {};
    const { action, reason, dryRun } = body;
    if (action !== 'approve' && action !== 'deny') return refuse(res, 'action must be approve or deny.');
    const unknown = Object.keys(body).find(key => !PROPOSAL_DECISION_FIELDS.includes(key));
    if (unknown !== undefined) return refuse(res, `Unknown field ${unknown}: a decision takes action, reason and dryRun, for the one request id in the path.`);
    if (dryRun !== undefined && typeof dryRun !== 'boolean') return refuse(res, 'dryRun must be a boolean.');
    if (action === 'approve' && reason !== undefined) return refuse(res, 'reason goes with deny; approve takes none.');
    if (action === 'deny' && typeof reason !== 'string') return refuse(res, 'deny needs reason: 1 to 500 characters the proposer reads on its receipt.');
    await answer(res, dryRun !== true, async () => {
      const lib = await import('../core/persistence/memory-proposals.ts');
      const { ownerContext } = await import('./memory-proposals.ts');
      const row = await lib.ownerProposal(engine, String(req.params.request_id));
      const ctx = await ownerContext(engine, dryRun === true);
      const result = action === 'approve'
        ? await lib.approveMemoryProposal(ctx, row.request_id, { decidedBy: 'admin-api' })
        : await lib.denyMemoryProposal(ctx, row.request_id, reason, { decidedBy: 'admin-api' });
      const applied = dryRun !== true && result.decided === true;
      if (applied) await audit(engine, `proposal_${action}`, { request_id: row.request_id, kind: row.kind, slug: row.slug, member: row.member_id, state: result.status });
      return { applied, ...result, ...(action === 'approve' && lib.approveFailed(result) ? { outcome: 'failed' } : {}) };
    }, 'Show the proposal (GET /admin/api/memory-proposals/<request_id>)');
  });
}

function refuse(res: Response, message: string): void {
  res.status(400).json({ error: 'invalid_params', code: 'invalid_params', message, outcome: 'failed' });
}

async function answer(res: Response, mutation: boolean, run: () => Promise<Record<string, unknown>>, inspect = 'List the members, links or client'): Promise<void> {
  res.set('Cache-Control', 'no-store');
  try {
    res.json(await run());
  } catch (error) {
    if (error instanceof OperationError) {
      res.status(400).json({ error: error.code, code: error.code, message: error.message, suggestion: error.suggestion, ...(error.reason ? { reason: error.reason } : {}), outcome: 'failed' });
      return;
    }
    res.status(503).json({ error: 'administration_unavailable', code: 'administration_unavailable', outcome: mutation ? 'unknown' : 'failed',
      message: mutation ? `The change outcome is unknown. ${inspect} before another change.` : 'Administration is temporarily unavailable. Retry the read.' });
  }
}

/** One audit row per applied change, in the request log like a surface change; fail-open, as there. */
async function audit(engine: BrainEngine, action: string, detail: Record<string, unknown>): Promise<void> {
  try {
    await executeRawJsonb(engine, `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, params) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      ['admin-api', 'admin-api', 'access_admin', 0, 'success'], [{ actor: 'admin-api', action, ...detail }]);
  } catch (err) {
    process.stderr.write(`[access-admin] failed to write the ${action} audit row: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
