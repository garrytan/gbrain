import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderHarnessReference } from '../src/core/harness/registry.ts';
writeFileSync(fileURLToPath(new URL('../docs/guides/harness-adapters.md', import.meta.url)), renderHarnessReference());
