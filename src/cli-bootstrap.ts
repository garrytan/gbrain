export {};
if (process.env.PMBRAIN_DB_OWNER === '1' && process.send) await import('./product/database/database-worker.ts');
else await import('./cli.ts');
