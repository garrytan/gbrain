// Regenerates test/fixtures/operation-golden-manifest.json from the live operation
// registry. Run after any change to the operation contract (new ops, param/tier changes).
import { getCliCommandCatalog } from '../src/cli.ts';
import { operations } from '../src/core/operations.ts';
import { buildOperationGoldenManifest } from '../src/core/services/operation-conformance-service.ts';

const manifest = buildOperationGoldenManifest({
  operations,
  cliCatalog: getCliCommandCatalog(),
});

const target = new URL('../test/fixtures/operation-golden-manifest.json', import.meta.url);
await Bun.write(target, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${manifest.operations.length} operations to operation-golden-manifest.json`);
