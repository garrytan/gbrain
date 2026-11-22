export function sw(engine: { kind: string }) { switch (engine.kind) { case 'postgres': return 1; default: return 0; } }
