/**
 * claude-connector-link.ts — a claude.ai link that opens Claude's
 * "add custom connector" dialog with the connector's name and MCP URL already
 * filled in, so the user clicks Add instead of finding the settings page and
 * pasting the URL. Authentication still happens in that dialog and the OAuth
 * flow after it; the link carries no credential.
 *
 * `modal`, `connectorName` and `connectorUrl` are claude.ai's own query
 * parameters, not a documented API: if Claude renames them the link still
 * lands on the connectors page with an empty form, so every place that prints
 * it keeps the manual steps beside it.
 */

export const CLAUDE_ADD_CONNECTOR_BASE = 'https://claude.ai/customize/connectors';

/** Name the prefilled dialog shows when the caller passes none. */
export const CLAUDE_CONNECTOR_DEFAULT_NAME = 'GBrain';

/**
 * The prefilled add-connector link for `mcpUrl`, or null when the URL is not
 * an absolute https URL (claude.ai connects from Anthropic's cloud and only
 * accepts https endpoints, so any other link would open a form that fails) or
 * when it embeds userinfo (a credential in the URL would land in a claude.ai
 * query string, browser history and anywhere the link is pasted).
 *
 * Values are percent-encoded with encodeURIComponent (a space is `%20`, never
 * `+`), so the dialog reads them the same whichever decoder claude.ai uses.
 */
export function claudeConnectorLink(mcpUrl: string, name: string = CLAUDE_CONNECTOR_DEFAULT_NAME): string | null {
  let parsed: URL;
  try {
    parsed = new URL(mcpUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return null;
  return `${CLAUDE_ADD_CONNECTOR_BASE}?modal=add-custom-connector`
    + `&connectorName=${encodeURIComponent(name)}`
    + `&connectorUrl=${encodeURIComponent(parsed.href)}`;
}
