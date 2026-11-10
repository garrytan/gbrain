/**
 * GST-363: how to bind a stdio connection that is bound to nobody. A harness only one person uses binds with
 * `gbrain setup <harness> --stdio-member <member>` (claude-code or codex), which writes `serve --stdio-member` into that
 * one harness entry, so it binds only that harness on this machine, on PGLite and Postgres alike. A harness several
 * people talk to (OpenClaw, Hermes) gets one member key per person over serve --http instead. The refusal, the grace
 * notice, the access owner hint and whoami's unbound note all read the route here.
 */
import type { Action } from '../agent-output.ts';

export type EngineKind = 'pglite' | 'postgres';

export interface StdioBindRoute { argv: string[]; inputs: NonNullable<Action['inputs']>; text: string }

/** The route is the same on either engine: the binding lives in the harness entry, never in the brain. */
export function stdioBindRoute(_kind: EngineKind, member = '<id>'): StdioBindRoute {
  return {
    argv: ['gbrain', 'setup', '<HARNESS>', '--stdio-member', '<MEMBER>'],
    inputs: [{ name: 'HARNESS', how: 'claude-code or codex, used by this one person only. Never a harness several people talk to (OpenClaw, Hermes): give each of them a key over HTTP instead.' }],
    text: `For a Claude Code or Codex install only one person uses: gbrain setup <claude-code|codex> --stdio-member ${member}, which binds that harness's stdio entry on this machine and nothing else. For a harness several people talk to (OpenClaw, Hermes), give each person a key over HTTP instead: gbrain serve --http with one gbrain auth create <name> --member <id> key per person.`,
  };
}
