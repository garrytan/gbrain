

export function isRustBrain(engine: unknown): boolean {
  return (engine as { kind?: unknown }).kind === 'rust';
}
