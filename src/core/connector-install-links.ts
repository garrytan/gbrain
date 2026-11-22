/**
 * One-click links that open an MCP client's own "add server" step with this
 * brain's MCP URL already filled in. The user still reviews the form and signs
 * in inside the client; a link never carries a credential.
 *
 * Cursor: its documented install deeplink (cursor.com/docs/mcp/install-links).
 * Cursor connects from the user's own machine, so a tailnet-only URL works.
 *
 * Claude: the add-custom-connector form on claude.ai, documented by Anthropic
 * as the custom connector install link
 * (claude.com/docs/connectors/building/directory-vs-custom). claude.ai connects
 * from Anthropic's cloud, so the link is offered only for a public URL.
 */

export interface ConnectorInstallLinks {
  claude?: string;
  cursor?: string;
}

function linkableUrl(mcpUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(mcpUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
  return url.href;
}

export function cursorInstallLink(mcpUrl: string, name = 'gbrain'): string | null {
  const url = linkableUrl(mcpUrl);
  if (!url) return null;
  const config = Buffer.from(JSON.stringify({ url })).toString('base64');
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(config)}`;
}

export function claudeConnectorLink(mcpUrl: string, name = 'GBrain'): string | null {
  const url = linkableUrl(mcpUrl);
  if (!url) return null;
  return `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=${encodeURIComponent(name)}&connectorUrl=${encodeURIComponent(url)}`;
}

/** Claude only when `isPublic` (claude.ai cannot reach a tailnet-only URL); Cursor whenever the URL is linkable. */
export function connectorInstallLinks(mcpUrl: string, isPublic: boolean): ConnectorInstallLinks {
  const claude = isPublic ? claudeConnectorLink(mcpUrl) : null;
  const cursor = cursorInstallLink(mcpUrl);
  return { ...(claude ? { claude } : {}), ...(cursor ? { cursor } : {}) };
}

/** The human lines for `gbrain mcp expose` and `--status`, in the Next block's two-column layout. */
export function installLinkLines(links: ConnectorInstallLinks, isPublic: boolean): string[] {
  const lines: string[] = [];
  if (links.claude) lines.push(`  Claude           ${links.claude}`, '                   Opens Claude\'s add-connector form with this URL filled in; review it and sign in there.');
  if (links.cursor) lines.push(`  Cursor           ${links.cursor}`, `                   Opens Cursor's MCP install prompt with this URL filled in${isPublic ? '.' : '; the Cursor machine must be on your tailnet.'}`);
  return lines;
}

/** Builds the links, prints their lines through `say`, and returns the links for the JSON document. */
export function printInstallLinks(mcpUrl: string, isPublic: boolean, say: (line: string) => void): ConnectorInstallLinks {
  const links = connectorInstallLinks(mcpUrl, isPublic);
  for (const line of installLinkLines(links, isPublic)) say(line);
  return links;
}
