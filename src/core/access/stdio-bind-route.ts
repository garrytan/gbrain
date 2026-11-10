/**
 * GST-363: how to bind a stdio connection that is bound to nobody, by the brain's engine. On a local PGLite brain a
 * harness only one person uses binds with setup --stdio-member (config mcp.stdio_member, which every stdio session on
 * the host then reads as); on Postgres that key would bind every host that opens the brain, so setup refuses it and
 * the route is one member key per person over serve --http. The refusal, the grace notice, the access owner hint and
 * whoami's unbound note all read the route here.
 */
import type { Action } from '../agent-output.ts';

export type EngineKind = 'pglite' | 'postgres';

export interface StdioBindRoute { argv: string[]; inputs: NonNullable<Action['inputs']>; text: string }

export function stdioBindRoute(kind: EngineKind, member = '<id>'): StdioBindRoute {
  const httpKeys = `gbrain serve --http with one gbrain auth create <name> --member <id> key per person`;
  if (kind === 'postgres') return {
    argv: ['gbrain', 'auth', 'create', '<NAME>', '--member', '<MEMBER>'],
    inputs: [{ name: 'NAME', how: 'A name for the HTTP key of the person this harness serves (for example alice-laptop).' }],
    text: `Give each person a key over HTTP: ${httpKeys}. This brain is Postgres, so a stdio server stays unbound: mcp.stdio_member is stored in the brain and would bind every host that opens it.`,
  };
  return {
    argv: ['gbrain', 'setup', '<HARNESS>', '--serves', 'several', '--members', '<MEMBERS>', '--stdio-member', '<MEMBER>'],
    inputs: [{ name: 'HARNESS', how: 'The harness only this one person uses (for example claude-code or codex). Never a harness several people talk to.' },
      { name: 'MEMBERS', how: 'Every person this brain serves, comma-separated (gbrain access member list names them); MEMBER is one of them.' }],
    text: `For a harness only one person uses on this local PGLite brain: gbrain setup <harness> --serves several --members <ids> --stdio-member ${member}; every stdio session on this brain, from any harness on this host, then reads as that member, private pages included. For a harness several people talk to, give each person a key over HTTP instead: ${httpKeys}.`,
  };
}
