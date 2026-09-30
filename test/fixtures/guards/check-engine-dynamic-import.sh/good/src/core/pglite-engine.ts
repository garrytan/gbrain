// Guard self-test fixture (known-GOOD): a reviewed lazy import carries the marker.
export async function load(): Promise<unknown> {
  return await import('node:path'); // engine-dynamic-import-ok: fixture
}
