import {assertSafeE2eDatabaseUrl} from '../helpers/db-guard.ts';

const database=process.env.DATABASE_URL;
if(!database)throw new Error('Postgres 验收需要隔离测试数据库');
assertSafeE2eDatabaseUrl(database);
process.env.PMBRAIN_RELATION_TEST_DATABASE_URL=database;
await import('../entity-capture-budget.serial.test.ts');
