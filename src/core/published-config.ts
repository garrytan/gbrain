/**
 * The DB-plane config merge, as published after connect.
 *
 * #1475 — `connectEngine` merges the DB plane over file/env once after connect (`loadConfigWithEngine`) and
 * publishes the result here for `makeContext` (ctx.config) and for `gbrain serve` (`serve_cli_socket`, `serve_vector_prewarm`), so neither
 * reads the config table again. Why a map rather than a module-level variable: a process can hold more than one
 * engine (`--brain <mount>` connects a second one), and the host brain's merged config must never be served for a
 * mounted brain. Weak so a disconnected engine does not pin its config for the life of the process.
 */
import type { GBrainConfig } from './config.ts';

export const MERGED_CONFIG_BY_ENGINE = new WeakMap<object, GBrainConfig>();

/**
 * `serve.cli_socket` (docs/guides/cli-socket.md) joins the merge from the bulk config snapshot only, never a per-key
 * read: a serve that leaves the warm CLI socket off then does no work for it at boot, and a brain whose config table
 * cannot be read in one statement opens the socket only with `gbrain serve --cli-socket`.
 */
export function mergeServeCliSocket(merged: GBrainConfig, snapshot: Record<string, string> | null): GBrainConfig {
  const value = snapshot?.['serve.cli_socket'];
  if (merged.serve_cli_socket === undefined && value !== undefined) merged.serve_cli_socket = /^(1|true|on|yes)$/i.test(value.trim());
  return merged;
}

/**
 * `serve.vector_prewarm` (core/vector-prewarm.ts) joins the merge the same way, from the bulk snapshot only: a serve that
 * leaves the prewarm off does no work and no config read for it at boot.
 */
export function mergeServeVectorPrewarm(merged: GBrainConfig, snapshot: Record<string, string> | null): GBrainConfig {
  const value = snapshot?.['serve.vector_prewarm'];
  if (merged.serve_vector_prewarm === undefined && value !== undefined) merged.serve_vector_prewarm = /^(1|true|on|yes)$/i.test(value.trim());
  return merged;
}
