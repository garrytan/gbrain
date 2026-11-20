import { PGLiteEngine } from '/code/garrytan/gbrain/src/core/pglite-engine.ts';
import { hybridSearch } from '/code/garrytan/gbrain/src/core/search/hybrid.ts';
const engine = new PGLiteEngine();
await engine.connect({ engine: 'pglite', database_path: '/var/tmp/audit/retrieval/b1fault/.gbrain/brain.pglite' } as any);
const show = (label: string, rows: any[], meta: any) => {
  console.log(label, JSON.stringify(rows.map(r => ({ slug: r.slug, score: +r.score.toFixed(4), superseded: r.superseded ?? null, superseded_by: r.superseded_by ?? null }))));
  console.log('  degraded:', JSON.stringify(meta?.degraded ?? null));
};
let meta: any = null;
show('normal', await hybridSearch(engine, 'tapirword', { limit: 5, onMeta: (m: any) => { meta = m; } } as any), meta);
(engine as any).supersedingPageSlugs = async () => { throw new Error('simulated: canceling statement due to statement timeout'); };
meta = null;
show('fault ', await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false, onMeta: (m: any) => { meta = m; } } as any), meta);
await engine.disconnect();
