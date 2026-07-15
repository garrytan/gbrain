// AUTO-GENERATED — do not edit by hand.
// Run `bun run scripts/build-admin-embedded.ts` to regenerate.
// Source: admin/dist/ at 2026-07-15.
//
// Bun resolves the file: imports to a path that works at runtime even
// inside a compiled binary (`bun build --compile`). The manifest maps
// the request path the express handler sees to (resolved-path, mime).

// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_0_assets_index_DH9hmX_g_js from '../admin/dist/assets/index-DH9hmX-g.js' with { type: 'file' };
// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_1_assets_index_yvSHufX1_css from '../admin/dist/assets/index-yvSHufX1.css' with { type: 'file' };
// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_2_index_html from '../admin/dist/index.html' with { type: 'file' };
// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_3_wecom_helper_jpg from '../admin/dist/wecom-helper.jpg' with { type: 'file' };

export interface AdminAsset {
  path: string;
  mime: string;
}

export const ADMIN_ASSETS: Record<string, AdminAsset> = {
  "/admin/assets/index-DH9hmX-g.js": { path: A_0_assets_index_DH9hmX_g_js as unknown as string, mime: "application/javascript; charset=utf-8" },
  "/admin/assets/index-yvSHufX1.css": { path: A_1_assets_index_yvSHufX1_css as unknown as string, mime: "text/css; charset=utf-8" },
  "/admin/index.html": { path: A_2_index_html as unknown as string, mime: "text/html; charset=utf-8" },
  "/admin/wecom-helper.jpg": { path: A_3_wecom_helper_jpg as unknown as string, mime: "image/jpeg" },
};

/** Index entry point for SPA fallback. */
export const ADMIN_INDEX_HTML: AdminAsset = ADMIN_ASSETS['/admin/index.html'];

export const ADMIN_ASSET_COUNT = 4;
