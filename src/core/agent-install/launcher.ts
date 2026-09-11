import { shellQuote } from '../mcp-registration.ts';
import { AGENT_ENV_SHELL_PATTERN } from './environment.ts';

/** Shared by local PGLite and hosted thin-client installs. No shell profiles or cwd routing. */
export function renderAgentLauncher(p: { root: string; bunPath: string; cliPath?: string; sourceId?: string; repairHint?: string }): string {
  const missing = `! -x ${shellQuote(p.bunPath)}` + (p.cliPath ? ` || ! -f ${shellQuote(p.cliPath)}` : '');
  const invocation = shellQuote(p.bunPath) + (p.cliPath ? ` --no-env-file ${shellQuote(p.cliPath)}` : '');
  const repair = p.repairHint ?? 'Restore the runtime used by this launcher, then repeat this installation.';
  return `#!/usr/bin/env bash
set -euo pipefail
# This launcher belongs to the GBrain installation named below.
for gbrain_env_name in $(compgen -e); do
  case "$gbrain_env_name" in
    ${AGENT_ENV_SHELL_PATTERN}) unset "$gbrain_env_name" ;;
  esac
done
export GBRAIN_HOME=${shellQuote(p.root)}
export GBRAIN_BRAIN_ID=host
export GBRAIN_SOURCE=${shellQuote(p.sourceId ?? 'default')}
export GBRAIN_SKIP_STARTUP_HOOKS=1
# Empty, present keys also prevent .gbrain/.env from redirecting this installation.
export DATABASE_URL='' GBRAIN_DATABASE_URL=''
cd ${shellQuote(p.root)}
if [[ ${missing} ]]; then
  printf '%s\\n' ${shellQuote(`GBrain runtime is missing. ${repair}`)} >&2
  exit 1
fi
exec ${invocation} --brain host "$@"
`;
}
