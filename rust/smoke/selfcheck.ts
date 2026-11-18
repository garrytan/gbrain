/**
 * Compiled by `bun build --compile --no-compile-autoload-bunfig` and run by run.ts. It proves a
 * single-file executable can load the addon with process.dlopen from a path given at run time,
 * and that the main behaviors work there too.
 */
import { loadAddon } from './addon.ts';
import { compiledCases } from './cases.ts';

const addon = loadAddon();
let failed = 0;
for (const testCase of compiledCases) {
  try {
    await testCase.run(addon);
  } catch (error) {
    failed++;
    console.error(`FAIL ${testCase.name}\n${error instanceof Error ? error.message : String(error)}`);
  }
}
if (failed > 0) process.exit(1);
console.log(`selfcheck ok: ${compiledCases.length} cases, target ${addon.target}`);
process.exit(0);
