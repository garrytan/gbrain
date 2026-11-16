/**
 * GST-363: how to bind a stdio connection that is bound to nobody. Since per-harness binding (serve --stdio-member),
 * a harness only one person uses binds with `gbrain setup claude-code|codex --stdio-member <member>`, which writes
 * the member into that one harness entry, on PGLite and Postgres alike; setup refuses it where OpenClaw or Hermes is
 * installed. A harness several people talk to gets one member key per person over `serve --http` instead. The
 * refusal, the grace notice, the access owner hint and whoami's unbound note all read the route here.
 */
import type { Action } from '../agent-output.ts';

export interface StdioBindRoute { argv: string[]; inputs: NonNullable<Action['inputs']>; text: string }

export function stdioBindRoute(member = '<id>'): StdioBindRoute {
  return {
    argv: ['gbrain', 'setup', '<HARNESS>', '--stdio-member', '<MEMBER>'],
    inputs: [{ name: 'HARNESS', how: 'claude-code or codex, the harness only this one person uses. Never a harness several people talk to.' }],
    text: `For a harness only one person uses: gbrain setup claude-code|codex --stdio-member ${member}, which binds that one harness entry on this machine (refused where OpenClaw or Hermes is installed). `
      + `For a harness several people talk to, give each person a key over HTTP instead: gbrain serve --http with one gbrain auth create <name> --member <id> key per person.`,
  };
}
