/**
 * connector-install-links.ts — one-click links that open an MCP client's own
 * "add server" step with GBrain's name and MCP URL already filled in, so the
 * user confirms instead of finding a settings page and pasting the URL. The
 * links carry no credential: authentication still happens in the client
 * (OAuth, or the client's own token field) after it opens.
 *
 * Only clients with such a link are here:
 *   - Claude (claude.ai, Claude Desktop): claude.ai's add-custom-connector
 *     dialog. Its `modal` / `connectorName` / `connectorUrl` parameters are
 *     claude.ai's own, not a documented API, so callers keep the manual steps
 *     beside the link. claude.ai connects from Anthropic's cloud, so the link
 *     is only useful for a public URL.
 *   - Cursor: Cursor's documented MCP install deeplink
 *     (cursor.com/docs/mcp/install-links), whose `config` is the base64 of an
 *     mcp.json server entry. Cursor connects from the user's own machine, so a
 *     tailnet-only URL works when that machine is on the tailnet.
 * ChatGPT, Perplexity and Claude Cowork have no prefill link; the CLI clients
 * (Claude Code, Codex, opencode, ...) already install with one command.
 */

export const CLAUDE_ADD_CONNECTOR_BASE = 'https://claude.ai/customize/connectors';
export const CURSOR_MCP_INSTALL_BASE = 'cursor://anysphere.cursor-deeplink/mcp/install';

/** Name the Claude dialog shows when the caller passes none. */
export const CLAUDE_CONNECTOR_DEFAULT_NAME = 'GBrain';
/** Cursor's mcp.json server key when the caller passes none (matches `claude mcp add gbrain`). */
export const CURSOR_SERVER_DEFAULT_NAME = 'gbrain';

/**
 * The URL as a link may carry it, or null: absolute https only (both clients
 * need https for a remote server), and no userinfo, because a credential in the
 * URL would land in a query string, browser history and anywhere the link is
 * pasted.
 */
function linkableMcpUrl(mcpUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(mcpUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return null;
  return parsed.href;
}

/**
 * claude.ai's add-connector dialog, prefilled. Values are encodeURIComponent-
 * encoded (a space is `%20`, never `+`), so the dialog reads them the same
 * whichever decoder claude.ai uses.
 */
export function claudeConnectorLink(mcpUrl: string, name: string = CLAUDE_CONNECTOR_DEFAULT_NAME): string | null {
  const url = linkableMcpUrl(mcpUrl);
  if (!url) return null;
  return `${CLAUDE_ADD_CONNECTOR_BASE}?modal=add-custom-connector`
    + `&connectorName=${encodeURIComponent(name)}`
    + `&connectorUrl=${encodeURIComponent(url)}`;
}

/**
 * Cursor's install deeplink: `config` is base64(JSON.stringify(entry)) of the
 * mcp.json entry `{ "url": … }`, base64-encoded FIRST and URL-encoded after
 * (`+`, `/` and `=` in base64 must not reach the query raw).
 */
export function cursorInstallLink(mcpUrl: string, name: string = CURSOR_SERVER_DEFAULT_NAME): string | null {
  const url = linkableMcpUrl(mcpUrl);
  if (!url) return null;
  const config = Buffer.from(JSON.stringify({ url }), 'utf-8').toString('base64');
  return `${CURSOR_MCP_INSTALL_BASE}?name=${encodeURIComponent(name)}&config=${encodeURIComponent(config)}`;
}

export interface ConnectorInstallLinks {
  claude?: string;
  cursor?: string;
}

/**
 * Every client link that works for this URL. `isPublic` says whether vendor
 * clouds can reach it (Tailscale Funnel or another public HTTPS front): only
 * then is the claude.ai link included. Empty when the URL is not linkable.
 */
export function connectorInstallLinks(mcpUrl: string, opts: { isPublic: boolean }): ConnectorInstallLinks {
  const links: ConnectorInstallLinks = {};
  const claude = opts.isPublic ? claudeConnectorLink(mcpUrl) : null;
  if (claude) links.claude = claude;
  const cursor = cursorInstallLink(mcpUrl);
  if (cursor) links.cursor = cursor;
  return links;
}

/**
 * `connectorInstallLinks` plus the human lines that present them, written
 * through `say` in the `Next` block's two-column layout (`gbrain mcp expose`
 * and `--status`). Returns the links so the caller can also carry them in
 * its JSON document.
 */
export function announceInstallLinks(mcpUrl: string, opts: { isPublic: boolean; say: (line: string) => void }): ConnectorInstallLinks {
  const links = connectorInstallLinks(mcpUrl, opts);
  const how = 'finish authentication there.';
  if (links.claude) {
    opts.say(`  Claude.ai        ${links.claude}`);
    opts.say(`                   Opens Claude's add-connector form with this MCP URL filled in; ${how}`);
  }
  if (links.cursor) {
    opts.say(`  Cursor           ${links.cursor}`);
    opts.say(`                   Opens Cursor's MCP install prompt with this URL${opts.isPublic ? '' : ' (the Cursor machine must be on your tailnet)'}; ${how}`);
  }
  return links;
}
