// Guard self-test fixture (known-BAD): unreviewed dynamic import in the shared engine SQL dir (refactor wave 1).
export async function load(): Promise<unknown> {
  return await import('node:path');
}
