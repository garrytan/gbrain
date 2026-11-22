export function pick(engine: { kind: string }) { return engine.kind === 'pglite' ? 1 : 2; }
