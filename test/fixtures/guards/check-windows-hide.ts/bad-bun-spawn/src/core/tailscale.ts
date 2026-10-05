export function status(): number {
  return Bun.spawnSync(['tailscale', 'status']).exitCode;
}
