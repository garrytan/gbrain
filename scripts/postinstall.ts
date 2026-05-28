export const POSTINSTALL_MESSAGE = [
  "[gbrain] postinstall does not open your brain or run migrations automatically.",
  "[gbrain] After install or upgrade, run: gbrain upgrade",
  "[gbrain] Source or bun-link installs can run: gbrain post-upgrade",
].join("\n");

export interface RunPostinstallOptions {
  log?: (message: string) => void;
}

export async function runPostinstall({
  log = console.error,
}: RunPostinstallOptions = {}): Promise<number> {
  log(POSTINSTALL_MESSAGE);
  return 0;
}

if (import.meta.main) {
  process.exit(await runPostinstall());
}
