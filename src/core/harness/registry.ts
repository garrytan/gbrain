/** Harness identities and supported setup mechanisms. Runtime evidence is separate
 * from documentation evidence: a shell probe cannot certify a vendor session. */
export type HarnessMode = 'local-cli' | 'thin-cli' | 'stdio' | 'http';
export interface HarnessAdapter {
  id: string;
  label: string;
  aliases: readonly string[];
  modes: readonly HarnessMode[];
  connection: 'codex-toml' | 'claude-json' | 'opencode-json' | 'thin-cli' | 'manual';
  renewable: boolean;
  /** Compatibility: legacy agent register supports only these adapters. */
  legacyRegister?: boolean;
  guide: string;
  reload: string;
  evidence: { documentedAt: string; runtimeTestedAt: string | null; references: readonly string[] };
  nativeInstructions: 'existing' | 'manual';
}

const repo = 'https://github.com/garrytan/gbrain/blob/master/';
const dated = (references: string[]) => ({ documentedAt: '2026-09-09', runtimeTestedAt: null, references });
export const HARNESS_ADAPTERS: readonly HarnessAdapter[] = [
  { id: 'claude-code', legacyRegister: true, label: 'Claude Code', aliases: ['claude'], modes: ['local-cli', 'stdio', 'http'], connection: 'claude-json', renewable: false,
    guide: 'docs/mcp/CLAUDE_CODE.md', reload: 'Restart Claude Code and inspect /mcp.', nativeInstructions: 'existing',
    evidence: dated(['https://code.claude.com/docs/en/mcp']) },
  { id: 'claude-desktop', label: 'Claude Desktop', aliases: [], modes: ['stdio', 'http'], connection: 'manual', renewable: true,
    guide: 'docs/mcp/CLAUDE_DESKTOP.md', reload: 'Reconnect the server in Claude Desktop settings.', nativeInstructions: 'manual',
    evidence: dated([`${repo}docs/mcp/`]) },
  { id: 'codex', legacyRegister: true, label: 'Codex', aliases: [], modes: ['local-cli', 'stdio', 'http'], connection: 'codex-toml', renewable: false,
    guide: 'docs/mcp/CODEX.md', reload: 'Start a new Codex session and inspect /mcp.', nativeInstructions: 'existing',
    evidence: dated(['https://developers.openai.com/codex/mcp']) },
  { id: 'opencode', legacyRegister: true, label: 'opencode', aliases: [], modes: ['local-cli', 'stdio', 'http'], connection: 'opencode-json', renewable: false,
    guide: 'docs/mcp/OPENCODE.md', reload: 'Restart opencode and inspect its MCP connections.', nativeInstructions: 'existing',
    evidence: dated(['https://opencode.ai/docs/mcp-servers/']) },
  { id: 'openclaw', legacyRegister: true, label: 'OpenClaw', aliases: [], modes: ['local-cli', 'thin-cli'], connection: 'thin-cli', renewable: true,
    guide: 'docs/mcp/OPENCLAW.md', reload: 'Load the generated GBrain instructions in a new agent session.', nativeInstructions: 'existing',
    evidence: dated([`${repo}docs/mcp/OPENCLAW.md`]) },
  { id: 'grok-build', label: 'Grok Build', aliases: ['grok'], modes: ['local-cli', 'stdio', 'http'], connection: 'manual', renewable: true,
    guide: 'docs/mcp/GROK.md', reload: 'Reload Grok Build and inspect its MCP tools.', nativeInstructions: 'existing',
    evidence: dated([`${repo}docs/mcp/GROK.md`]) },
  { id: 'grok-bot', label: 'Grok Bot', aliases: [], modes: ['local-cli', 'thin-cli'], connection: 'thin-cli', renewable: true,
    guide: 'docs/guides/grok-bot.md', reload: 'Enable the saved GBrain skill for this Bot and test in a new conversation.', nativeInstructions: 'manual',
    evidence: dated(['https://docs.x.ai/grok-bot/computer-and-apps', 'https://docs.x.ai/grok-bot/skills-routines-and-automations']) },
  { id: 'muse', label: 'Muse personal agent', aliases: [], modes: ['local-cli', 'thin-cli'], connection: 'thin-cli', renewable: true,
    guide: 'docs/guides/muse.md', reload: 'Attach the generated instructions using Muse’s available skill controls; test in a new conversation.', nativeInstructions: 'manual',
    evidence: dated(['https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse']) },
  { id: 'muse-code', label: 'Muse Code', aliases: [], modes: ['stdio', 'http'], connection: 'manual', renewable: true,
    guide: 'docs/guides/muse.md#muse-code-is-a-different-product', reload: 'Reload Muse Code’s MCP connection.', nativeInstructions: 'manual',
    evidence: dated(['https://dev.meta.ai/docs/muse-code/extending']) },
  ...(['cursor', 'perplexity', 'chatgpt', 'generic'] as const).map(id => ({
    id, label: id === 'generic' ? 'your agent' : id === 'perplexity' ? 'Perplexity Computer' : id, aliases: [], modes: ['http'] as HarnessMode[],
    connection: 'manual' as const, renewable: true, guide: 'docs/guides/hosted-harness-access.md',
    reload: 'Follow this client’s connection settings and reconnect its MCP server.', nativeInstructions: 'manual' as const,
    evidence: dated([`${repo}docs/mcp/`]),
  })),
];

export function harnessAdapter(id: string): HarnessAdapter {
  const adapter = HARNESS_ADAPTERS.find(a => a.id === id || a.aliases.includes(id));
  if (!adapter) throw new Error(`Unknown harness. Choose: ${HARNESS_ADAPTERS.map(a => a.id).join(', ')}`);
  return adapter;
}

export function publicHarnessMetadata() {
  return HARNESS_ADAPTERS.map(({ id, label, modes, guide, evidence }) => ({ id, label, modes, documentation: `${repo}${guide}`, evidence }));
}

export function renderHarnessReference(): string {
  const rows = HARNESS_ADAPTERS.map(a => `| ${a.id} | ${a.modes.join(', ')} | ${a.connection === 'manual' ? 'Follow client settings' : a.connection} | ${a.renewable ? '1 hour' : '30 days'} | [Guide](../../${a.guide}) |`);
  return ['# Harness adapter reference', '', '<!-- Generated by bun run build:harness-docs from src/core/harness/registry.ts. -->', '',
    'A supported transport is distinct from a tested vendor session. The new Grok Bot and Muse paths use finite local or thin CLI calls; native MCP activation is not asserted. Query `gbrain mcp adapters` for dated documentation sources. Token lifetimes below apply to new grants unless explicitly overridden.', '',
    '| Adapter | Supported modes | Connection mechanism | New access-token lifetime | Instructions |', '| --- | --- | --- | --- | --- |', ...rows, '',
    'Aliases: `grok` means Grok Build; `claude` means Claude Code. The older `--agent` connection commands retain their defaults. Use the separate `grok-bot`, `muse`, and `muse-code` identifiers for those products.', '',
    'Managed installers preserve unrelated configuration and use private credential files and ownership receipts. Manual adapters give guidance; they do not write a universal configuration format. Reload behavior and native enablement steps are recorded in the install result.', '',
    'See [hosted access](hosted-harness-access.md) for profiles, private delivery, removal, and verification. Actual harness evidence remains required after server checks pass.', ''].join('\n');
}
