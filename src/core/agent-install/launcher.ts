import { shellQuote } from '../mcp-registration.ts';
import { AGENT_ENV_SHELL_PATTERN } from './environment.ts';

/**
 * Shared by local PGLite and hosted thin-client installs. No shell profiles or cwd routing. `dependencies` is the source
 * tree whose own node_modules the CLI resolves from (#9665): a host restore that drops it gets a restore command, not a
 * module-resolution error.
 */
export function renderAgentLauncher(p: { root: string; bunPath: string; cliPath?: string; sourceId?: string; repairHint?: string; mode?: 'local' | 'thin-client'; dependencies?: string }): string {
  const missing = `! -x ${shellQuote(p.bunPath)}` + (p.cliPath ? ` || ! -f ${shellQuote(p.cliPath)}` : '');
  const invocation = shellQuote(p.bunPath) + (p.cliPath ? ` --no-env-file ${shellQuote(p.cliPath)}` : '');
  const repair = p.repairHint ?? 'Restore the runtime used by this launcher, then repeat this installation.';
  const routing = p.mode === 'thin-client'
    ? ''
    : `export GBRAIN_BRAIN_ID=host\nexport GBRAIN_SOURCE=${shellQuote(p.sourceId ?? 'default')}\n`;
  const brainArg = p.mode === 'thin-client' ? '' : ' --brain host';
  const dependencies = p.dependencies ? `if [[ ! -d ${shellQuote(`${p.dependencies}/node_modules`)} ]]; then
  printf '%s\\n' ${shellQuote(`GBrain dependencies are missing from ${p.dependencies}/node_modules. Restore them from the lockfile: cd ${shellQuote(p.dependencies)} && ${shellQuote(p.bunPath)} install --frozen-lockfile --ignore-scripts`)} >&2
  exit 1
fi
` : '';
  return `#!/usr/bin/env bash
set -euo pipefail
# This launcher belongs to the GBrain installation named below.
for gbrain_env_name in $(compgen -e); do
  case "$gbrain_env_name" in
    ${AGENT_ENV_SHELL_PATTERN}) unset "$gbrain_env_name" ;;
  esac
done
export GBRAIN_HOME=${shellQuote(p.root)}
${routing}export GBRAIN_SKIP_STARTUP_HOOKS=1
# Empty, present keys also prevent .gbrain/.env from redirecting this installation.
export DATABASE_URL='' GBRAIN_DATABASE_URL=''
cd ${shellQuote(p.root)}
if [[ ${missing} ]]; then
  printf '%s\\n' ${shellQuote(`GBrain runtime is missing. ${repair}`)} >&2
  exit 1
fi
${dependencies}exec ${invocation}${brainArg} "$@"
`;
}
