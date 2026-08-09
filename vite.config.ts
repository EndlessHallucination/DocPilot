import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { crx } from '@crxjs/vite-plugin'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import manifest from './manifest.config.ts'

const PDFJS = 'node_modules/pdfjs-dist'

export default defineConfig({
    plugins: [
        react(),
        tailwindcss(),
        crx({ manifest }),
        viteStaticCopy({
            targets: [
                { src: `${PDFJS}/cmaps`, dest: 'pdfjs' },
                { src: `${PDFJS}/standard_fonts`, dest: 'pdfjs' },
                { src: `${PDFJS}/wasm`, dest: 'pdfjs' },
            ],
        }),
    ],

    build: {
        rollupOptions: {
            input: { viewer: 'src/viewer/index.html' }
        },
    },
})