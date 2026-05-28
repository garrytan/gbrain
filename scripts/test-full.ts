import { spawnSync } from "node:child_process";

function run(command: string, args: string[]): number {
  const result = spawnSync(command, args, {
    env: process.env,
    stdio: "inherit",
  });
  return result.status ?? 1;
}

for (const args of [
  ["run", "verify"],
  ["run", "test"],
  ["run", "test:slow"],
]) {
  const status = run("bun", args);
  if (status !== 0) process.exit(status);
}

if (process.env.DATABASE_URL) {
  process.exit(run("bun", ["run", "test:e2e"]));
}

console.error(
  "[test:full] skipped E2E (no DATABASE_URL); run docker-compose -f docker-compose.ci.yml up + bun run test:e2e to include",
);
