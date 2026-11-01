import * as db from '../../src/core/db.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
const url = process.env.DATABASE_URL!;
assertSafeE2eDatabaseUrl(url);
await db.connect({ database_url: url });
try {
  try {
    await db.initSchema();
    console.log(JSON.stringify({ status: 'initialized' }));
  } catch (error) {
    console.log(JSON.stringify({ code: (error as { code?: string }).code }));
  }
} finally { await db.disconnect(); }
