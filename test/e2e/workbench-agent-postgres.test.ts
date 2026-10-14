import { afterAll } from 'bun:test';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for the assistant task regression');
assertSafeE2eDatabaseUrl(url);
const previous = process.env.PMBRAIN_AGENT_TEST_DATABASE_URL;
process.env.PMBRAIN_AGENT_TEST_DATABASE_URL = url;
afterAll(() => { if (previous === undefined) delete process.env.PMBRAIN_AGENT_TEST_DATABASE_URL; else process.env.PMBRAIN_AGENT_TEST_DATABASE_URL = previous; });
await import('../workbench-agent-runtime.serial.test');
