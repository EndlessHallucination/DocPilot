import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { crx } from '@crxjs/vite-plugin'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import manifest from './manifest.config.ts'

const PDFJS = 'node_modules/pdfjs-dist'

/**
 * Two builds from one source.
 *
 *   vite build              → dist/      the Chrome extension (crx + manifest)
 *   vite build --mode web   → dist-web/  a static site, no extension APIs
 *
 * --mode rather than an env var so it works the same on Windows.
 *
 * The web build drops the crx plugin and nothing else. Everything that touched
 * chrome.* now goes through copilot/storage.ts, which branches at runtime, so
 * there is no second entry point and no forked code to keep in step.
 */
export default defineConfig(({ mode }) => {
    const web = mode === 'web'

    return {
        plugins: [
            react(),
            tailwindcss(),
            // The only build-specific plugin. crx writes the manifest and the
            // service worker, neither of which means anything on a web page.
            ...(web ? [] : [crx({ manifest })]),
            // Both builds need these: cmaps decode Hebrew (see pdf-setup.ts).
            viteStaticCopy({
                targets: [
                    { src: `${PDFJS}/cmaps`, dest: 'pdfjs' },
                    { src: `${PDFJS}/standard_fonts`, dest: 'pdfjs' },
                    { src: `${PDFJS}/wasm`, dest: 'pdfjs' },
                ],
            }),
        ],

        build: {
            outDir: web ? 'dist-web' : 'dist',
            emptyOutDir: true,
            rollupOptions: {
                input: { viewer: 'src/viewer/index.html' },
            },
        },
    }
})