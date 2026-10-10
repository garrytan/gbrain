/**
 * `confirm_memory` (#5575: A4, CEO-2, CEO-9, DX-3, DX-20): the one MCP-visible
 * owner action. It raises a fact (`f<id>`), take (`t<id>`) or page
 * (`p:<source>/<slug>`) to user_confirmed, and only for the owner: a
 * connection holding `memory_confirm` (minted by the local CLI), or the local
 * CLI on an interactive terminal where the user types the target's token.
 * Agent tokens get `insufficient_scope` with a `tell_user_to_run` fix naming
 * `gbrain trust confirm <ref>`; a non-TTY local caller gets
 * `confirmation_required`. The other owner actions (review accept/reject,
 * release, drop, revert, allow, disable) are not operations at all: they run
 * only from the local CLI or the resident owner's 0600 IPC administration
 * (persistence/administration.ts), never from an MCP session (ENG-15).
 * Never import from '../operations.ts' here (cycle).
 */
import { opError, type Operation } from './contract.ts';
import { requireOwnerConfirmation } from '../trust/confirm.ts';
import { applyOwnerAction, previewOwnerAction } from '../trust/owner-actions.ts';
import { parseTrustRef } from '../trust/refs.ts';
import { currentVerifiedLocalWriter } from '../persistence/identity.ts';

const confirm_memory: Operation = {
  name: 'confirm_memory',
  mutating: true,
  idempotent: true,
  writeInference: 'non_content',
  outputRedaction: 'no_stored_text',
  description: 'Owner only: mark a fact, take or page as confirmed by the user (trust tier user_confirmed). '
    + 'Needs a connection the user granted memory_confirm on the brain host; agent connections are refused with a command '
    + 'for the user to run. Never call this on your own judgment: confirm only what the user explicitly confirmed.',
  params: {
    ref: { type: 'string', required: true, description: 'What to confirm: f<id> (fact), t<id> (take) or p:<source>/<slug> (page).' },
  },
  scope: 'write',
  handler: async (ctx, p) => {
    const raw = typeof p.ref === 'string' ? p.ref : '';
    const ref = parseTrustRef(raw);
    if (ref.kind !== 'fact' && ref.kind !== 'take' && !(ref.kind === 'page' && ref.sourceId)) {
      throw opError('invalid_params', 'confirm_memory takes f<id>, t<id> or p:<source>/<slug>.',
        'Pass the ref of one fact, take or page (pages with their source, e.g. p:default/notes/alice-example). Trust proposals and held writes are decided on the brain host with gbrain trust review.');
    }
    const preview = await previewOwnerAction(ctx.engine, { action: 'confirm', ref: raw });
    if (ctx.remote !== false) {
      const allowed = ctx.auth?.allowedSources ?? (ctx.auth?.sourceId ? [ctx.auth.sourceId] : null);
      const [sourceRow] = ref.kind === 'page' ? [{ source_id: ref.sourceId! }] : await ctx.engine.executeRaw<{ source_id: string }>(
        ref.kind === 'fact' ? 'SELECT source_id FROM facts WHERE id = $1' : 'SELECT p.source_id FROM takes t JOIN pages p ON p.id = t.page_id WHERE t.id = $1', [ref.id]);
      if (allowed && sourceRow && !allowed.includes(sourceRow.source_id)) {
        throw opError('not_found', `No ${ref.kind} ${preview.ref} visible to this connection.`, 'Check the ref and the source your connection may use.');
      }
    }
    if (ctx.dryRun) return { dry_run: true, action: 'confirm_memory', ref: preview.ref, raises: preview.raises, summary: preview.summary };
    if (!preview.raises) return { action: 'confirm', ref: preview.ref, status: 'unchanged', tier: 'user_confirmed' };
    const confirmation = await requireOwnerConfirmation(ctx, { ref: preview.ref, token: preview.token, summary: preview.summary, command: preview.command });
    const principal = ctx.auth?.principal ?? currentVerifiedLocalWriter()?.principal ?? null;
    return applyOwnerAction(ctx.engine, { action: 'confirm', ref: raw }, {
      binding: preview.binding, confirmation, by: principal, config: ctx.config, ...(ctx.remote !== false ? { ctx } : {}),
    });
  },
};

export const trustOperations: Operation[] = [confirm_memory];
