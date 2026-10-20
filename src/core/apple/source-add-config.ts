/**
 * The `sources.config` blob `sources add --kind apple` writes (issue #6855),
 * shared by the unmanaged insert (sources-ops.ts) and the managed lifecycle
 * (persistence/managed-sources.ts) so the two can never diverge. Config carries
 * labels and tuning only: the connector holds no credential (macOS grants
 * access per app through System Settings, never through gbrain).
 */
import { appleTuningConfig, APPLE_DEFAULT_ACCOUNT, APPLE_DEFAULT_HISTORY_DAYS } from './source-config.ts';
import type { AppleSourceConfig } from './types.ts';

/** The typed `AddSourceOpts.apple` payload. */
export type AppleAddOptions = Pick<AppleSourceConfig, 'services' | 'dir'> & Partial<Omit<AppleSourceConfig, 'services' | 'dir'>>;

export function appleAddConfig(apple: AppleAddOptions, managedDir: string, federated: boolean): Record<string, unknown> {
  return {
    kind: 'apple',
    a_account: apple.account ?? APPLE_DEFAULT_ACCOUNT,
    // Written explicitly (not elided when all three): the service list is the
    // privacy scope of this source and should be readable in its config.
    a_services: apple.services.join(','),
    a_history_days: apple.historyDays ?? APPLE_DEFAULT_HISTORY_DAYS,
    ...appleTuningConfig({ ...apple, account: undefined, services: undefined, historyDays: undefined }),
    a_managed: apple.dir === managedDir,
    federated,
  };
}
