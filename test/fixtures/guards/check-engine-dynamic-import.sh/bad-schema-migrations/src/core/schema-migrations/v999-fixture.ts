// Guard self-test fixture (known-BAD): unreviewed require() in a split migration (refactor wave 1).
export async function load(): Promise<unknown> {
  return require('node:path');
}
