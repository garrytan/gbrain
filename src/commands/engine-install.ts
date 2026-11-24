/**
 * `gbrain engine install rust [--from <file>] [--json]`: download, check and install the Rust engine addon this gbrain
 * release names (src/core/rust-engine/addon-install.ts). Engine-free: it opens no brain and reads no database.
 * Exit 0 when the addon is installed (or already was), 1 on a typed refusal, 2 on a usage error.
 */
import type { RustAddonInstallDeps, RustAddonInstallResult } from '../core/rust-engine/addon-install.ts';
import { OperationError } from '../core/ops/contract.ts';

const USAGE = [
  'Usage: gbrain engine install rust [--from <file>] [--json]',
  '',
  'Downloads the Rust engine addon this gbrain release names for this platform, checks its SHA-256 and its build',
  'attestation from the gbrain release workflow, and installs it under the gbrain home, where the Rust engine and',
  'shadow mode load it. An addon that is already installed and checks out is kept. Brains on PGLite or Postgres are',
  'not changed. Releases carry linux-x64-glibc and darwin-arm64 addons.',
  '',
  '  --from <file>  install a copy of the release addon you already have (the manifest is still read online)',
  '  --json         print one JSON document',
].join('\n');

export interface EngineInstallIo {
  out(line: string): void;
  err(line: string): void;
  install?(opts: { from?: string }, deps?: Partial<RustAddonInstallDeps>): Promise<RustAddonInstallResult>;
}

export async function runEngineInstall(args: string[], io: EngineInstallIo = { out: console.log, err: console.error }): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.out(USAGE);
    return 0;
  }
  let json = false;
  let from: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') json = true;
    else if (a === '--from') {
      from = args[++i];
      if (!from) { io.err('engine install: --from needs a file path.'); return 2; }
    } else rest.push(a);
  }
  if (rest.length !== 1 || rest[0] !== 'rust') {
    io.err(USAGE);
    return 2;
  }
  const install = io.install ?? (await import('../core/rust-engine/addon-install.ts')).installRustAddon;
  try {
    const result = await install(from === undefined ? {} : { from });
    if (json) io.out(JSON.stringify({ schema_version: 1, ...result }, null, 2));
    else {
      io.out(result.status === 'installed'
        ? `Installed the Rust engine addon for gbrain v${result.version} (${result.target}) at ${result.path}.`
        : `The Rust engine addon for gbrain v${result.version} (${result.target}) is already installed at ${result.path}.`);
      io.out(`  sha256 ${result.sha256}, engine_build ${result.engine_build}. Check it with gbrain engine status --json.`);
    }
    return 0;
  } catch (err) {
    if (!(err instanceof OperationError)) throw err;
    if (json) {
      io.out(JSON.stringify({ schema_version: 1, status: 'refused', code: err.code, reason: err.reason ?? null, message: err.message, suggestion: err.suggestion ?? null }, null, 2));
    } else {
      io.err(`engine install: ${err.code} (${err.reason ?? 'unknown'}): ${err.message}`);
      if (err.suggestion) io.err(err.suggestion);
    }
    return 1;
  }
}
