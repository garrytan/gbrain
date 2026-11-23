/**
 * Block Kit for a take proposal: the claim, its kind/weight/holder/page, and Accept / Reject buttons while it is
 * pending; once decided the buttons give way to the decision (who, through what, when). Every outside string is
 * escaped for Slack mrkdwn (&, <, >), so a claim can never form a mention, a link or a broadcast.
 */
import type { ProposalEventPayload } from '../types.ts';

export const ACCEPT_ACTION = 'gbrain_take_proposal_accept';
export const REJECT_ACTION = 'gbrain_take_proposal_reject';
const TEXT_MAX = 2800;

export function escapeMrkdwn(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const clip = (value: string, max = TEXT_MAX) => value.length > max ? `${value.slice(0, max - 1)}…` : value;

/** `{slug}` / `{source}` in a page_url template, URL-encoded per path segment; null without a template. */
export function pageUrl(template: string | undefined, proposal: Pick<ProposalEventPayload['proposal'], 'page_slug' | 'source_id'>): string | null {
  if (!template) return null;
  const slug = proposal.page_slug.split('/').map(encodeURIComponent).join('/');
  const url = template.replace(/\{slug\}/g, slug).replace(/\{source\}/g, encodeURIComponent(proposal.source_id));
  return /^https:\/\/[^\s|<>]+$/.test(url) ? url : null;
}

export interface RenderOpts { sink: string; interactive: boolean; pageUrlTemplate?: string }

export function renderProposalMessage(proposal: ProposalEventPayload['proposal'], opts: RenderOpts): { text: string; blocks: unknown[] } {
  const url = pageUrl(opts.pageUrlTemplate, proposal);
  const page = url ? `<${url}|${escapeMrkdwn(proposal.page_slug)}>` : `\`${escapeMrkdwn(proposal.page_slug)}\``;
  const weight = Number(proposal.weight).toFixed(2);
  const facts = [proposal.kind, `weight ${weight}`, `holder \`${escapeMrkdwn(proposal.holder)}\``,
    ...(proposal.domain ? [escapeMrkdwn(proposal.domain)] : []), `source \`${escapeMrkdwn(proposal.source_id)}\``];
  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*Take proposal #${proposal.id}* on ${page}` } },
    { type: 'section', text: { type: 'mrkdwn', text: clip(`>${escapeMrkdwn(proposal.claim).replace(/\n/g, '\n>')}`) } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: facts.join(' · ') }] },
  ];
  if (proposal.status === 'pending') {
    if (opts.interactive) {
      blocks.push({ type: 'actions', block_id: `gbrain_tp_${proposal.id}`, elements: [
        { type: 'button', action_id: ACCEPT_ACTION, style: 'primary', text: { type: 'plain_text', text: 'Accept' }, value: `${opts.sink}:${proposal.id}` },
        { type: 'button', action_id: REJECT_ACTION, style: 'danger', text: { type: 'plain_text', text: 'Reject' }, value: `${opts.sink}:${proposal.id}` },
      ] });
    } else {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Review with \`takes_proposal_accept\` / \`takes_proposal_reject\` (id ${proposal.id}).` }] });
    }
  } else {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: decisionLine(proposal) }] });
  }
  const text = clip(`Take proposal #${proposal.id} (${proposal.kind}, weight ${weight}) on ${proposal.page_slug}: ${proposal.claim}`, 3000);
  return { text, blocks };
}

function decisionLine(proposal: ProposalEventPayload['proposal']): string {
  const verb = proposal.status === 'accepted' ? ':white_check_mark: *Accepted*' : proposal.status === 'rejected' ? ':x: *Rejected*' : `*${escapeMrkdwn(proposal.status)}*`;
  const who = proposal.acted_by ? ` by ${escapeMrkdwn(proposal.acted_by)}` : '';
  const via = proposal.acted_via ? ` via ${escapeMrkdwn(proposal.acted_via)}` : '';
  const at = proposal.acted_at ? (() => {
    const epoch = Math.floor(Date.parse(proposal.acted_at!) / 1000);
    return Number.isFinite(epoch) ? ` <!date^${epoch}^{date_short_pretty} {time}|${proposal.acted_at}>` : '';
  })() : '';
  const row = proposal.status === 'accepted' && proposal.promoted_row_num ? ` → take #${proposal.promoted_row_num}` : '';
  const reason = proposal.status === 'rejected' && proposal.reason ? `: ${escapeMrkdwn(clip(proposal.reason, 500))}` : '';
  return `${verb}${who}${via}${at}${row}${reason}`;
}
