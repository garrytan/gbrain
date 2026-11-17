/** The addon target name of the machine gbrain is running on (the only place the loader reads the C runtime family). */
import { familySync, GLIBC, MUSL } from 'detect-libc';

/**
 * The addon target name for this platform, in the form the addon's `target()` reports
 * (`linux-x64-glibc`, `darwin-arm64`, ...). It names the platform whether or not a release publishes
 * an addon for it. Returns null when the platform cannot be identified (an unknown Linux C runtime).
 */
export function detectAddonTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  libc: () => string | null = familySync,
): string | null {
  if (platform === 'linux') {
    const family = libc();
    return family === GLIBC || family === MUSL ? `linux-${arch}-${family}` : null;
  }
  return `${platform}-${arch}`;
}
