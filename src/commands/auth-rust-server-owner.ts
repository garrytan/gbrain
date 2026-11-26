/**
 * `gbrain auth create <name> --rust-server-owner` (multi-user Rust only): mints the owner server token a brain
 * server accepts over the network (src/core/rust-engine/served/owner-token.ts). Trusted local CLI only: it writes
 * to the brain this host's config opens. Prints the token once.
 */
import { createEngine } from '../core/engine-factory.ts';
import { loadConfig, toEngineConfig } from '../core/config.ts';
import { exitCliError } from '../cli/cli-error.ts';
import { OperationError } from '../core/ops/contract.ts';
import { rustMultiuserFromEnv } from '../core/rust-engine/multiuser-switch.ts';
import { storeMultiuser } from '../core/rust-engine/access-self-check.ts';
import { mintOwnerServerToken } from '../core/rust-engine/served/owner-token.ts';

export async function createRustServerOwner(rest: string[]): Promise<void> {
  const name = rest[0] ?? '';
  if (!name || name.startsWith('--') || rest.length > 1) { console.error('Usage: auth create <name> --rust-server-owner'); process.exit(1); }
  const config = loadConfig();
  if (!config) { console.error('No GBrain config found. Run `gbrain init` first.'); process.exit(1); }
  const engineConfig = toEngineConfig(config);
  const engine = await createEngine(engineConfig);
  try {
    await engine.connect(engineConfig);
    // The brain's resolved mode (multiuser-switch.ts): the store's answer when it gives one, else the environment half.
    const store = (engine as { openStoreIfOpen?: (m: string) => { multiuser?: boolean } | null }).openStoreIfOpen?.('createRustServerOwner');
    if (!(store ? storeMultiuser(store) : rustMultiuserFromEnv())) { console.error('Error: --rust-server-owner needs multi-user Rust: set GBRAIN_RUST_MULTIUSER=1 or the brain config engine.rust.multiuser.'); process.exit(1); }
    const { token, id } = await mintOwnerServerToken(engine, name);
    console.log(`Owner server token created for "${name}" (id ${id}): a brain server accepts it over the network with the brain owner's full access.\n`);
    console.log(`  ${token}\n`);
    console.log('Save this token — it will not be shown again. Put it in the variable your client\'s rust_server.token_env names (default GBRAIN_RUST_SERVER_TOKEN).');
    console.log(`Revoke with: gbrain auth revoke "${name}"`);
  } catch (e: any) {
    if (e instanceof OperationError) exitCliError(e, 'auth');
    console.error(e?.code === '23505' ? `A token named "${name}" already exists. Revoke it first or use a different name.` : `Error: ${e?.message ?? e}`);
    process.exit(1);
  } finally {
    await engine.disconnect().catch(() => undefined);
  }
}
