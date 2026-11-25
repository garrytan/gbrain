// Dump the strict gazetteer and the exact scan texts the mention pass feeds findMentionedEntities.
import { writeFileSync } from 'node:fs';
const G = '/code/garrytan/gbrain/src';
const { createEngine } = await import(`${G}/core/engine-factory.ts`);
const { buildGazetteer } = await import(`${G}/core/by-mention.ts`);
const { readMentionPolicy } = await import(`${G}/core/mentions/policy.ts`);
const url = process.argv[2] ?? 'postgresql://postgres@127.0.0.1:5499/brain_snap';
const engine = await createEngine({ engine: 'postgres' });
await engine.connect({ database_url: url });
const policy = await readMentionPolicy(engine);
const gaz = await buildGazetteer(engine, { policy, strict: true });
const rows = await engine.executeRaw(`SELECT slug, source_id, title, compiled_truth, timeline, body_storage FROM pages WHERE deleted_at IS NULL ORDER BY source_id, slug`);
const pages = rows.map((p: any) => ({ slug: p.slug, source_id: p.source_id, text: `${p.title ?? ''}\n\n${p.compiled_truth ?? ''}\n\n${p.timeline ?? ''}`, storage: p.body_storage }));
writeFileSync('/var/tmp/rx/gaz.json', JSON.stringify([...gaz]));
writeFileSync('/var/tmp/rx/pages.json', JSON.stringify(pages));
const sizes = [...gaz.values()].map(b => b.length).sort((a, b) => b - a);
console.log(JSON.stringify({ buckets: gaz.size, entries: sizes.reduce((a, b) => a + b, 0), biggest: sizes.slice(0, 5), pages: pages.length, segmented: pages.filter((p: any) => p.storage === 'segmented').length, chars: pages.reduce((a: number, p: any) => a + p.text.length, 0), policy }));
await engine.disconnect();
