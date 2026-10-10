/**
 * The versioned harness x transport capability table behind `gbrain setup`.
 *
 * Data, not prose: one row per harness and transport, saying whether setup
 * wires it, which context it can read (pull through MCP tools) and whether
 * gbrain context reaches a native session without being asked (push). A push
 * row stays `native-pending` until an observed event injects a randomized item
 * into a fresh native session; nothing in this table is claimed from docs or
 * from a shell probe alone. Bump `SETUP_CAPABILITY_TABLE_VERSION` when a row's
 * meaning changes.
 */

export const SETUP_CAPABILITY_TABLE_VERSION = 1;

export const SETUP_HARNESSES = ['claude-code', 'codex', 'openclaw', 'hermes'] as const;
export type SetupHarness = (typeof SETUP_HARNESSES)[number];

export type SetupTransport = 'local-stdio' | 'local-context-engine' | 'thin-client';

export interface SetupCapabilityRow {
  harness: SetupHarness;
  transport: SetupTransport;
  /** `supported`: `gbrain setup <harness>` wires it; `unsupported`: coded refusal with `docs`. */
  setup: 'supported' | 'unsupported';
  /** Pull: memory tools the session can call. `connection-verified` means setup's smoke proves it. */
  pull: 'connection-verified' | 'manual';
  /** Push without a tool call. `native-verified` requires an observed injected event. */
  push: 'native-pending' | 'native-verified' | 'unsupported';
  /** Events setup installs on a memory-only setup (read context only). */
  read_events: readonly string[];
  /** Events installed only after automatic capture is accepted. */
  capture_events: readonly string[];
  docs: string;
}

export const SETUP_CAPABILITIES: readonly SetupCapabilityRow[] = [
  { harness: 'claude-code', transport: 'local-stdio', setup: 'supported', pull: 'connection-verified', push: 'native-pending',
    read_events: ['SessionStart', 'UserPromptSubmit'], capture_events: ['Stop', 'SessionEnd'], docs: 'docs/mcp/CLAUDE_CODE.md' },
  { harness: 'codex', transport: 'local-stdio', setup: 'unsupported', pull: 'manual', push: 'native-pending',
    read_events: [], capture_events: ['SessionEnd'], docs: 'docs/mcp/CODEX.md' },
  { harness: 'openclaw', transport: 'local-context-engine', setup: 'unsupported', pull: 'manual', push: 'native-pending',
    read_events: [], capture_events: [], docs: 'docs/mcp/OPENCLAW.md' },
  { harness: 'openclaw', transport: 'thin-client', setup: 'unsupported', pull: 'manual', push: 'unsupported',
    read_events: [], capture_events: [], docs: 'docs/mcp/OPENCLAW.md' },
  { harness: 'hermes', transport: 'local-stdio', setup: 'unsupported', pull: 'manual', push: 'unsupported',
    read_events: [], capture_events: [], docs: 'docs/mcp/HERMES.md' },
];

export function isSetupHarness(v: string | undefined): v is SetupHarness {
  return (SETUP_HARNESSES as readonly string[]).includes(v ?? '');
}

export function capabilityRows(harness: SetupHarness): SetupCapabilityRow[] {
  return SETUP_CAPABILITIES.filter((r) => r.harness === harness);
}
