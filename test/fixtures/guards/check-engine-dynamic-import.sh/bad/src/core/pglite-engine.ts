// Guard self-test fixture (known-BAD): unreviewed dynamic import on an engine façade.
export async function load(): Promise<unknown> {
  return await import('node:path');
}
