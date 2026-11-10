/**
 * GST-363: shared_stdio_binding. A stdio session reads as one member when its harness entry starts
 * `serve --stdio-member <id>` (gbrain setup claude-code|codex --stdio-member) or, for any entry without it, when config
 * mcp.stdio_member (set by hand) names one. On a host where a harness several people talk to is installed (OpenClaw
 * or Hermes, found by sharedStdioHarness), that member's private pages are one shared session away, so the check fails
 * there: for the config key with the unset command as the fix, for a bound claude-code or codex entry with
 * `gbrain setup <harness> --no-stdio-member`. Ok when something is bound and no shared harness is installed; not
 * applicable while nothing is.
 */
import { readFileSync } from 'node:fs';
import type { Check } from '../../doctor.ts';
import { agentFix, checkError, infoCheck } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { stdioMemberId } from '../../../core/access/caller.ts';
import { readCodexTomlTable } from '../../../core/bootstrap/codex-toml.ts';
import { claudeUserMcpConfigPath, codexConfigPath } from '../../../core/bootstrap/host-specs.ts';
import { registeredStdioMember } from '../../../core/stdio-member-flag.ts';
import { localSetupRecords } from '../../../core/setup/local-receipts.ts';
import { sharedStdioHarness } from '../../setup-serves.ts';

const NAME = 'shared_stdio_binding';

interface BoundEntry { harness: 'claude-code' | 'codex'; name: string; member: string; where: string; projectDir?: string }

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);

/** The claude-code and codex MCP entries on this host (gbrain's names) that start serve --stdio-member. */
function boundEntries(): BoundEntry[] {
  const names = [...new Set(['gbrain', ...localSetupRecords().filter((r) => r.harness === 'claude-code' || r.harness === 'codex').map((r) => r.name)])];
  const out: BoundEntry[] = [];
  const claudePath = claudeUserMcpConfigPath();
  let claude: Record<string, unknown> | null = null;
  try { claude = record(JSON.parse(readFileSync(claudePath, 'utf8'))); } catch { /* absent or unparseable: Claude Code starts none of it */ }
  const holders: Array<[Record<string, unknown> | null, string | undefined]> = [[record(claude?.mcpServers), undefined],
    ...Object.entries(record(claude?.projects) ?? {}).map(([dir, p]): [Record<string, unknown> | null, string] => [record(record(p)?.mcpServers), dir])];
  for (const [servers, projectDir] of holders) {
    for (const name of names) {
      const member = registeredStdioMember(servers?.[name]);
      if (member) out.push({ harness: 'claude-code', name, member, where: `the '${name}' MCP server in ${claudePath}${projectDir ? ` (project ${projectDir})` : ''}`, ...(projectDir ? { projectDir } : {}) });
    }
  }
  const codexPath = codexConfigPath();
  for (const name of names) {
    let table: unknown;
    try { table = readCodexTomlTable(codexPath, ['mcp_servers', name]); } catch { continue; }
    const member = registeredStdioMember(table);
    if (member) out.push({ harness: 'codex', name, member, where: `[mcp_servers.${name}] in ${codexPath}` });
  }
  return out;
}

async function runSharedStdioBinding(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const member = await stdioMemberId(connectedEngine(ctx));
    const entries = boundEntries();
    if (!member && entries.length === 0) {
      checks.push(infoCheck(NAME, 'Not applicable: config mcp.stdio_member is unset and no claude-code or codex entry starts serve --stdio-member, so no stdio session on this host reads as a member.', 'not_applicable'));
      return checks;
    }
    const details = { stdio_member: member, bound_entries: entries.map(({ harness, name, member: m, where }) => ({ harness, name, member: m, where })) };
    const bound = [...(member ? [`config mcp.stdio_member binds every stdio session on this host without --stdio-member to ${member}`] : []),
      ...entries.map((e) => `${e.where} starts serve --stdio-member ${e.member}`)].join('; ');
    const harness = sharedStdioHarness();
    if (!harness) {
      checks.push({ name: NAME, status: 'ok', details: { ...details, shared_harness: null },
        message: `${bound}, and no harness several people talk to (OpenClaw, Hermes) is installed here.` });
      return checks;
    }
    const docs = 'docs/guides/setup.md#a-brain-that-serves-several-people';
    const first = entries[0];
    const fix = member
      ? agentFix(['gbrain', 'config', 'unset', 'mcp.stdio_member'], `Unbinds stdio on this host, so ${harness} stops reading as ${member}. Ask the user first: a harness only ${member} uses then reads unbound until it gets its own key.`, NAME, { ask_user: true, docs })
      : agentFix(['gbrain', 'setup', first!.harness, ...(first!.name === 'gbrain' ? [] : ['--name', first!.name]), ...(first!.projectDir ? ['--scope', 'project'] : []), '--no-stdio-member'],
        `Removes --stdio-member ${first!.member} from ${first!.where}${first!.projectDir ? ` (run it from ${first!.projectDir})` : ''}, so that harness stops reading as ${first!.member} on a host where ${harness} runs. Ask the user first: give ${first!.member} their own key over HTTP instead (gbrain auth create <name> --member ${first!.member}).`, NAME, { ask_user: true, docs });
    checks.push({ name: NAME, status: 'fail', details: { ...details, shared_harness: harness },
      message: `${bound}, and ${harness} is installed here, a harness several people talk to, so a member's private pages are one stdio session away from whoever is asking it.`, fix });
  } catch (error) {
    checks.push(checkError(NAME, `run ${NAME}`, error));
  }
  return checks;
}

export const sharedStdioBindingEntry: DoctorEntry = {
  name: 'shared_stdio_binding',
  emits: ['shared_stdio_binding'],
  run: runSharedStdioBinding,
};
