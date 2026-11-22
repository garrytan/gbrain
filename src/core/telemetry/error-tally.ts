/**
 * The error codes this process rendered for the CLI, in order. renderCliError
 * notes each one here; the CLI's exit seam (cli/telemetry-hook.ts) counts the
 * registered ones when telemetry is on. No imports, so the renderer can note a
 * code without loading the telemetry client.
 */
const rendered: string[] = [];

export function noteCliErrorCode(code: string): void {
  if (rendered.length < 50) rendered.push(code);
}

export function renderedCliErrorCodes(): readonly string[] {
  return rendered;
}
