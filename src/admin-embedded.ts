// AUTO-GENERATED — do not edit by hand.
// Run `bun run scripts/build-admin-embedded.ts` to regenerate.
// Source: admin/dist/ at 2026-07-25.
//
// Bun resolves the file: imports to a path that works at runtime even
// inside a compiled binary (`bun build --compile`). The manifest maps
// the request path the express handler sees to (resolved-path, mime).

// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_0_assets_charts_BO6HVfrh_js from '../admin/dist/assets/charts-BO6HVfrh.js' with { type: 'file' };
// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_1_assets_index_CmZRJcqu_js from '../admin/dist/assets/index-CmZRJcqu.js' with { type: 'file' };
// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_2_assets_index_CxplMq4a_css from '../admin/dist/assets/index-CxplMq4a.css' with { type: 'file' };
// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_3_assets_react_LdaKN5mt_js from '../admin/dist/assets/react-LdaKN5mt.js' with { type: 'file' };
// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_4_assets_ui_Biebs49j_js from '../admin/dist/assets/ui-Biebs49j.js' with { type: 'file' };
// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_5_index_html from '../admin/dist/index.html' with { type: 'file' };
// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_6_wechat_donation_jpg from '../admin/dist/wechat-donation.jpg' with { type: 'file' };
// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_7_wecom_helper_jpg from '../admin/dist/wecom-helper.jpg' with { type: 'file' };

export interface AdminAsset {
  path: string;
  mime: string;
}

export const ADMIN_ASSETS: Record<string, AdminAsset> = {
  "/admin/assets/charts-BO6HVfrh.js": { path: A_0_assets_charts_BO6HVfrh_js as unknown as string, mime: "application/javascript; charset=utf-8" },
  "/admin/assets/index-CmZRJcqu.js": { path: A_1_assets_index_CmZRJcqu_js as unknown as string, mime: "application/javascript; charset=utf-8" },
  "/admin/assets/index-CxplMq4a.css": { path: A_2_assets_index_CxplMq4a_css as unknown as string, mime: "text/css; charset=utf-8" },
  "/admin/assets/react-LdaKN5mt.js": { path: A_3_assets_react_LdaKN5mt_js as unknown as string, mime: "application/javascript; charset=utf-8" },
  "/admin/assets/ui-Biebs49j.js": { path: A_4_assets_ui_Biebs49j_js as unknown as string, mime: "application/javascript; charset=utf-8" },
  "/admin/index.html": { path: A_5_index_html as unknown as string, mime: "text/html; charset=utf-8" },
  "/admin/wechat-donation.jpg": { path: A_6_wechat_donation_jpg as unknown as string, mime: "image/jpeg" },
  "/admin/wecom-helper.jpg": { path: A_7_wecom_helper_jpg as unknown as string, mime: "image/jpeg" },
};

/** Index entry point for SPA fallback. */
export const ADMIN_INDEX_HTML: AdminAsset = ADMIN_ASSETS['/admin/index.html'];

export const ADMIN_ASSET_COUNT = 8;
