/**
 * `gbrain telemetry`: pre-connect dispatch (engine-free). Logic lives in
 * src/commands/telemetry.ts; the record lives in src/cli/command-table.ts.
 */
export async function run(args: string[]): Promise<void> {
  const { runTelemetry } = await import('../../commands/telemetry.ts');
  await runTelemetry(args);
}
