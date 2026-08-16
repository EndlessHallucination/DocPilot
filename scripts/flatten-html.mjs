/**
 * scripts/flatten-html.mjs
 *
 * Vite writes the entry HTML to dist-web/src/viewer/index.html, mirroring its
 * source path. A static host serves the root, so copy it up.
 *
 * A copy rather than a move: the nested path stays valid, so a stale link or a
 * host configured to serve the subdirectory keeps working.
 *
 * Asset URLs inside the HTML are absolute (/assets/…) because base is "/", so
 * they resolve correctly from the root. If you ever deploy under a subpath,
 * set `base` in vite.config.ts and they follow — assetUrl() in
 * copilot/storage.ts resolves against document.baseURI for the same reason.
 */

import { copyFileSync, existsSync } from "node:fs";

const from = "dist-web/src/viewer/index.html";
const to = "dist-web/index.html";

if (!existsSync(from)) {
    console.error(`[build] ${from} not found — did "vite build --mode web" run?`);
    process.exit(1);
}

copyFileSync(from, to);
console.log(`[build] ${to}`);
