// Bun.file(...) on a src path.

export async function load(): Promise<string> {
  return Bun.file(new URL('../../../src/core/example.ts', import.meta.url)).text();
}
