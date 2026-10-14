import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { assertNoSymlinks } from '../core/agent-install/state.ts';
import { installHermesPlugin } from '../core/harness/hermes.ts';
import { writeStdoutFinal } from '../core/cli-force-exit.ts';

const HELP = `Usage: gbrain hermes setup --hermes-home /absolute/profile --url https://brain.example/mcp [--token-file /private/token] [--json]
       gbrain hermes setup --hermes-home /absolute/profile --remove [--json]

Installs the bundled Hermes provider and canonical GBrain skills in this profile.
Capture stays off. Use this profile's existing GBRAIN_MCP_TOKEN in .env, or pass
a private token file. Identity and unrelated configuration are preserved.
Restart Hermes and verify memory in a new conversation after setup or removal.
Removal restores unchanged owned settings; revoke server credentials separately.
`;

export async function runHermesSetup(args: string[]): Promise<Record<string, unknown>> {
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return { status: 'help' }; }
  let home: string | undefined, url: string | undefined, tokenFile: string | undefined;
  let remove = false, json = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--remove') { remove = true; continue; }
    if (flag === '--json') { json = true; continue; }
    if (!['--hermes-home', '--url', '--token-file'].includes(flag)) throw new Error(`Unknown Hermes setup flag: ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag === '--hermes-home') home = value;
    else if (flag === '--url') url = value;
    else tokenFile = value;
  }
  if (!home) throw new Error('Hermes setup requires --hermes-home with the intended absolute profile');
  if (remove && (url || tokenFile)) throw new Error('Removal does not accept connection credentials');
  let token: string | undefined;
  if (tokenFile) {
    if (!isAbsolute(tokenFile)) throw new Error('Token file must be absolute');
    assertNoSymlinks(tokenFile);
    const stat = lstatSync(tokenFile);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Token file must be a private regular file (0600)');
    token = readFileSync(tokenFile, 'utf8').trim();
  }
  const receipt = await installHermesPlugin({ home, url, token, remove });
  if (json) await writeStdoutFinal(`${JSON.stringify(receipt, null, 2)}\n`);
  else console.log(`Hermes: ${receipt.status}. ${receipt.message ?? ''}`);
  return receipt;
}
