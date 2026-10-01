// Guard self-test fixture (known-GOOD): static-only module in the shared engine SQL dir.
export async function load(): Promise<unknown> {
  return 1;
}
