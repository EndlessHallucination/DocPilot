import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json' with { type: 'json' }

export default defineManifest({
    manifest_version: 3,
    name: 'PDF Copilot',
    version: pkg.version,
    description: 'Fill and sign PDFs in your browser, with field-by-field guidance.',

    permissions: ['storage'],

    host_permissions: [
        'https://api.anthropic.com/*',
        'https://api.openai.com/*',
    ],

    action: { default_title: "Open PDF Copilot" },
    background: { service_worker: "src/background/service-worker.ts", type: "module" },

    content_security_policy: {
        extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
})