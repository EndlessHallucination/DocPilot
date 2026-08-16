/**
 * copilot/dev.ts
 *
 * ─── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────
 * `import.meta.env.DEV` is not a runtime boolean. Vite substitutes it at
 * COMPILE time and then dead-code-eliminates the whole block, so in a
 * production build every `if (import.meta.env.DEV) { … }` is simply gone —
 * not false, gone. An unpacked extension loaded from `dist/` is a production
 * build.
 *
 * That cost real time three separate times in one session (§8.38): smokeReport
 * appeared not to run, the classification log appeared not to run, and the
 * "dropped N of M classifications" warning had been invisible since the day it
 * was written. Each time the symptom was identical to the code being broken,
 * which is the worst possible failure mode for a diagnostic.
 *
 * A plain exported constant is a real runtime value. It still tree-shakes when
 * set to false — the bundler can prove the branch is dead — so nothing is lost
 * except the trap.
 *
 * ─── SET THIS TO false BEFORE THE DEMO ───────────────────────────────────
 * Not for correctness — nothing here logs the API key, and §4 says keep it
 * that way — but because a console full of smoke reports on stage is noise,
 * and `smokeReport` walks every line of every page.
 */
export const COPILOT_DEV = true;