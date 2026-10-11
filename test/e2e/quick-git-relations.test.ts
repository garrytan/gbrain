import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const database = process.env.DATABASE_URL;
if (!database) throw new Error('Postgres 验收需要隔离测试数据库');
assertSafeE2eDatabaseUrl(database);
process.env.PMBRAIN_TASK_TEST_DATABASE_URL = database;
await import('../quick-git-relations.serial.test.ts');
await import('../task-relations.serial.test.ts');
