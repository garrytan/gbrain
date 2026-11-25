/**
 * Source precedence (agent-platform C3): which kind of source a row came from, so an agent can weigh a system of
 * record above a chat log when two rows disagree. It is a label only: it never raises a row's trust tier, never turns
 * text into instructions and, until the precedence ranking prior passes its eval, never changes ordering.
 *
 * The class is set per source with `gbrain sources set-precedence` (sources.config.precedence, trusted local). Without
 * it a guest source is external, the conversation archive, meeting and Google sources are chat, and everything else is
 * curated. A rule page (type: rule) or an allowed-claims page (type: facts with claims: allowed) counts as approved,
 * unless its source is set to record or external, or the page itself is external_untrusted or was written by an agent
 * over MCP.
 */

export const PRECEDENCE_CLASSES = ['record', 'approved', 'curated', 'doc', 'chat', 'external'] as const;
export type Precedence = typeof PRECEDENCE_CLASSES[number];

export const isPrecedence = (value: unknown): value is Precedence =>
  typeof value === 'string' && (PRECEDENCE_CLASSES as readonly string[]).includes(value);

const CHAT_SOURCE_IDS = ['conversations', 'conversations-owner'];
const CHAT_SOURCE_KINDS = ['meetings', 'google'];
const quoted = (values: readonly string[]) => values.map(v => `'${v}'`).join(', ');
/**
 * A page whose own front matter cannot approve it: an outside sender's page, or one an agent wrote over MCP. A trusted
 * local writer (a server-stamped `cli:` channel, such as setup's `gbrain put` of me/facts) can approve its page.
 */
export const selfApprovalBlockedSql = (page: string) =>
  `(${page}.trust_tier = 'external_untrusted' OR (${page}.trust_tier = 'agent_written' AND COALESCE(${page}.write_origin->>'channel', '') NOT LIKE 'cli:%'))`;
export const selfApprovalBlocked = (tier: string, origin: string) =>
  tier === 'external_untrusted' || (tier === 'agent_written' && !origin.startsWith('cli:'));

/** SQL true for a page that states rules or allowed claims (`page` is a pages alias). */
export const approvedPageSql = (page: string) =>
  `(${page}.type = 'rule' OR (${page}.type = 'facts' AND ${page}.frontmatter->>'claims' = 'allowed'))`;

/**
 * The precedence class as one SQL CASE. `source` is a sources alias (it may be NULL on a LEFT JOIN), `sourceId` the
 * row's source id column, `guest` the guest-source predicate (guests/marker.ts), and `page` a pages alias, or null
 * for a row with no page.
 */
export function precedenceSql(o: { source: string; sourceId: string; guest: string; page: string | null }): string {
  const set = `${o.source}.config->>'precedence'`;
  const approved = o.page
    ? `WHEN ${approvedPageSql(o.page)} AND NOT ${selfApprovalBlockedSql(o.page)} AND COALESCE(${set}, '') NOT IN ('record', 'external') THEN 'approved'`
    : '';
  return `CASE WHEN ${o.guest} THEN 'external' ${approved}
    WHEN ${set} IN (${quoted(PRECEDENCE_CLASSES)}) THEN ${set}
    WHEN ${o.sourceId} IN (${quoted(CHAT_SOURCE_IDS)}) OR ${o.source}.config->>'kind' IN (${quoted(CHAT_SOURCE_KINDS)}) THEN 'chat'
    ELSE 'curated' END`;
}
