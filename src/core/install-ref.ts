/**
 * The one git ref every install surface names (GBRA-224): README and agent install docs, the bootstrap runbook fetch,
 * the in-agent setup helper, the template repository, plugin launchers and the CLI's own install hints.
 *
 * Today it is `latest-stable`, the tag release.yml moves on every published release (the alpha channel). Install surfaces
 * stay there until a release that contains the stable channel client has been promoted to `stable`; the flip is then this
 * one line plus `bun run check:install-ref --write` (and the generated plugin and template trees). The lint
 * (scripts/check-install-ref.ts, test/install-ref.test.ts) refuses any install pin, runbook fetch or helper fetch that
 * names another ref, master included. The alpha channel's update check (src/commands/check-update.ts) reads
 * `latest-stable` on its own and does not follow this constant.
 */
export const INSTALL_REF = 'latest-stable';
export const INSTALL_PIN = `github:garrytan/gbrain#${INSTALL_REF}`;
export const INSTALL_RAW_BASE = `https://raw.githubusercontent.com/garrytan/gbrain/${INSTALL_REF}`;
