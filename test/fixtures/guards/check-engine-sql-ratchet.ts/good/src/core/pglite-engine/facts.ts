// Guard self-test fixture (known-GOOD): a module-dir function with no SQL.
export function describeFact(name: string): string {
  return `Insert into the list: ${name}`;
}
