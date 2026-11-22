export function pick(engine: { kind: 'pglite' | 'postgres' }) {
  switch (engine.kind) {
    case 'pglite': return 1;
    case 'postgres': return 2;
    default: { const unreachable: never = engine.kind; throw new Error(String(unreachable)); }
  }
}
