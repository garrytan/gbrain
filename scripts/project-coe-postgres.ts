#!/usr/bin/env bun

import { constants } from "node:fs";
import { link, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  assertCoePostgresClientTarget,
  assertCoeReportDestination,
  parseCoePostgresProjectorArgs,
  runCoePostgresProjection,
  type CoePostgresProjectorArgs,
  type CoeProjectionRunReport,
} from "../src/coe/project-postgres.ts";
import { loadConfig } from "../src/core/config.ts";
import { PostgresEngine } from "../src/core/postgres-engine.ts";

function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[REDACTED_DATABASE_URL]")
    .replace(/(password|token|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

function redactThrowable(error: unknown): unknown {
  const redacted = redactError(error);
  const original = error instanceof Error ? error.message : String(error);
  if (redacted === original) return error;
  const sanitized = new Error(redacted);
  if (error instanceof Error) sanitized.name = error.name;
  return sanitized;
}

export interface CoeReportWriteHooks {
  beforeParentOpen?: () => Promise<void> | void;
  afterParentOpen?: () => Promise<void> | void;
}

export async function writeCoeProjectorReport(
  path: string,
  value: unknown,
  hooks: CoeReportWriteHooks = {},
): Promise<void> {
  const parentPath = dirname(path);
  const expectedCanonicalParent = await realpath(parentPath);
  if (expectedCanonicalParent !== resolve(parentPath)) {
    throw new Error("report parent path must not traverse symbolic links");
  }
  await hooks.beforeParentOpen?.();
  const parent = await open(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const openedParent = await parent.stat();
  const directoryPath = `/proc/self/fd/${parent.fd}`;
  const openedCanonicalParent = await realpath(directoryPath);
  if (openedCanonicalParent !== expectedCanonicalParent) {
    await parent.close();
    throw new Error("report parent path changed during publication");
  }
  const finalPath = `${directoryPath}/${basename(path)}`;
  const temporaryPath = `${directoryPath}/.${basename(path)}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let temporary;
  try {
    await hooks.afterParentOpen?.();
    const currentParent = await open(
      parentPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const current = await currentParent.stat();
      if (current.dev !== openedParent.dev || current.ino !== openedParent.ino) {
        throw new Error("report parent directory changed during publication");
      }
    } finally {
      await currentParent.close();
    }

    temporary = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await temporary.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await temporary.sync();
    await temporary.close();
    temporary = undefined;
    await link(temporaryPath, finalPath);
    await unlink(temporaryPath);
    await parent.sync();
  } catch (error) {
    await temporary?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  } finally {
    await parent.close();
  }
}

export interface CoeProjectorCliEngine {
  connect(config: unknown): Promise<void>;
  disconnect(): Promise<void>;
}

export interface CoeProjectorCliDependencies {
  loadConfiguration: typeof loadConfig;
  createEngine: () => CoeProjectorCliEngine;
  runProjection: (
    engine: CoeProjectorCliEngine,
    args: CoePostgresProjectorArgs,
  ) => Promise<CoeProjectionRunReport>;
  writeReport: (path: string, value: unknown) => Promise<void>;
  now: () => Date;
  writeStdout: (text: string) => void;
}

const DEFAULT_DEPENDENCIES: CoeProjectorCliDependencies = {
  loadConfiguration: loadConfig,
  createEngine: () => new PostgresEngine() as unknown as CoeProjectorCliEngine,
  runProjection: (engine, args) =>
    runCoePostgresProjection(engine as unknown as PostgresEngine, args),
  writeReport: writeCoeProjectorReport,
  now: () => new Date(),
  writeStdout: (text) => {
    process.stdout.write(text);
  },
};

export async function runCoeProjectorCli(
  argv: string[],
  overrides: Partial<CoeProjectorCliDependencies> = {},
): Promise<void> {
  const dependencies: CoeProjectorCliDependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const args = parseCoePostgresProjectorArgs(argv);
  await assertCoeReportDestination(args.registryRoot, args.reportPath);
  await mkdir(dirname(args.reportPath), { recursive: true });
  await assertCoeReportDestination(args.registryRoot, args.reportPath);

  let engine: CoeProjectorCliEngine | undefined;
  let report: CoeProjectionRunReport | undefined;
  let primaryError: unknown;
  try {
    const config = dependencies.loadConfiguration();
    if (!config || config.engine !== "postgres") throw new Error("gbrain config engine must be postgres");
    assertCoePostgresClientTarget(config.database_url, args);
    engine = dependencies.createEngine();
    await engine.connect({ ...config, poolSize: 1 });
    report = await dependencies.runProjection(engine, args);
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown;
  try {
    await engine?.disconnect();
  } catch (error) {
    cleanupError = error;
  }

  if (primaryError || cleanupError || !report) {
    const outcomeError = primaryError ?? cleanupError ?? new Error("projection did not return a report");
    let reportError: unknown;
    try {
      await dependencies.writeReport(args.reportPath, {
        generated_at: dependencies.now().toISOString(),
        command: "coe:project-postgres",
        status: "failed",
        stage: primaryError ? args.mode : "disconnect",
        error: redactError(outcomeError),
        ...(cleanupError ? { cleanup_error: redactError(cleanupError) } : {}),
        ...(report ? { projection_status: report.status } : {}),
      });
    } catch (error) {
      reportError = error;
    }
    if (primaryError) throw redactThrowable(primaryError);
    if (cleanupError) throw redactThrowable(cleanupError);
    if (reportError) throw redactThrowable(reportError);
    throw redactThrowable(outcomeError);
  }

  try {
    await dependencies.writeReport(args.reportPath, {
      generated_at: dependencies.now().toISOString(),
      command: "coe:project-postgres",
      ...report,
    });
  } catch (error) {
    const boundary = report.status === "projected"
      ? "projection committed but final report publication failed"
      : "dry-run completed but final report publication failed";
    throw new Error(`${boundary}: ${redactError(error)}`);
  }
  dependencies.writeStdout(`${JSON.stringify({ status: report.status, report: args.reportPath })}\n`);
}

if (import.meta.main) {
  runCoeProjectorCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${redactError(error)}\n`);
    process.exitCode = 1;
  });
}
