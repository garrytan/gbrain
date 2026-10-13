import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('数据库路径验收需要隔离测试数据库');
assertSafeE2eDatabaseUrl(url);
process.env.PMBRAIN_PATH_TEST_DATABASE_URL = url;
await import('../pglite-database-path.serial.test.ts');
