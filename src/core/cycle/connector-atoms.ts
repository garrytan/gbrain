/**
 * #5856: atom extraction of connector `email` and `meeting` pages is on by
 * default and bounded by the per-attempt auto-drain budget. Setting
 * `cycle.extract_atoms.connector_pages` to false (or 0/off/no) opts out: atom
 * discovery and the backlog count then skip those pages of Google and GitHub
 * connector sources, so no routine cycle, drain or autopilot auto-drain sends
 * their bodies to the chat model. Other page types of a connector source, and
 * every page of a checkout-backed source, are unaffected.
 */
import type { BrainEngine } from '../engine.ts';
import { CONNECTOR_SOURCE_KINDS } from '../persistence/connector-identity.ts';

export const CONNECTOR_ATOM_PAGES_KEY = 'cycle.extract_atoms.connector_pages';
export const CONNECTOR_ATOM_PAGE_TYPES = ['email', 'meeting'] as const;

export async function connectorAtomPagesEnabled(engine: BrainEngine): Promise<boolean> {
  return !/^(false|0|off|no)$/i.test(((await engine.getConfig(CONNECTOR_ATOM_PAGES_KEY).catch(() => null)) ?? '').trim());
}

/** The backlog count's form of the same opt-out: the page types and connector source kinds to leave out, or null while connector pages are extracted. */
export async function connectorAtomExclusion(engine: BrainEngine): Promise<{ pageTypes: string[]; sourceKinds: string[] } | null> {
  if (await connectorAtomPagesEnabled(engine)) return null;
  return { pageTypes: [...CONNECTOR_ATOM_PAGE_TYPES], sourceKinds: [...CONNECTOR_SOURCE_KINDS] };
}

/** A page whose frontmatter says `extract_atoms: false` (a record-tier or private email, ingest-tiers.ts) is never sent to the chat model. */
const PAGE_ATOM_OPT_OUT_SQL = `AND COALESCE(p.frontmatter->>'extract_atoms', '') <> 'false'`;

/** The discovery/backlog predicate over `pages p`: the per-page opt-out, plus the connector email/meeting exclusion when opted out. */
export async function connectorAtomExclusionSql(engine: BrainEngine): Promise<string> {
  if (await connectorAtomPagesEnabled(engine)) return PAGE_ATOM_OPT_OUT_SQL;
  const list = (values: readonly string[]) => values.map(v => `'${v}'`).join(',');
  return `${PAGE_ATOM_OPT_OUT_SQL} AND NOT (p.type IN (${list(CONNECTOR_ATOM_PAGE_TYPES)}) AND EXISTS (SELECT 1 FROM sources cs
        WHERE cs.id = p.source_id AND cs.config->>'kind' IN (${list(CONNECTOR_SOURCE_KINDS)})))`;
}
