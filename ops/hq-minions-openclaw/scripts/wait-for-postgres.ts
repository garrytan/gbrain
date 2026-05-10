#!/usr/bin/env bun
const url = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL or GBRAIN_DATABASE_URL is required.');
  process.exit(2);
}

let postgres: typeof import('postgres').default;
try {
  postgres = (await import('postgres')).default;
} catch {
  console.error('postgres dependency unavailable. Run bun install from the GBrain repo or hq-minions-openclaw package.');
  process.exit(2);
}

const deadline = Date.now() + Number(process.env.WAIT_TIMEOUT_MS ?? 60000);
let last: unknown;

while (Date.now() < deadline) {
  const sql = postgres(url, { max: 1, connect_timeout: 3 });
  try {
    await sql`SELECT 1`;
    await sql.end();
    console.log('postgres_ready');
    process.exit(0);
  } catch (error) {
    last = error;
    await sql.end({ timeout: 1 }).catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

console.error('Timed out waiting for Postgres.', last);
process.exit(1);
