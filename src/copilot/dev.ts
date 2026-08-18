/**
 * copilot/dev.ts
 *
 * Runtime flag for diagnostics. Set to false before a demo — smokeReport walks
 * every line of every page and fills the console.
 *
 * ⚠ Use this, never `import.meta.env.DEV`. Vite strips that at compile time, so
 * in a built extension the guarded block is GONE, not false — and a missing
 * diagnostic looks exactly like broken code. EXPLAINER §8.3.
 */
export const COPILOT_DEV = true;