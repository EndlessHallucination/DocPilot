/**
 * copilot/storage.ts
 *
 * The only environment-specific file in the codebase. Provides one key/value slot
 * for the API key and a bundled-asset URL resolver, backed by chrome.storage in
 * the extension build and by localStorage plus document.baseURI on the web.
 * EXPLAINER §8.3.
 *
 * ⚠ ONE KEY, EVER. The context answers and the ask thread stay in memory — that
 * is the privacy claim, and it holds only as long as nothing widens this
 * interface.
 */

/** True in the extension build, false on a deployed web page. */
export const IS_EXTENSION =
    typeof chrome !== "undefined" && chrome.runtime?.id !== undefined;

/**
 * Where the key actually lives, in words a user can check.
 *
 * ⚠⚠ THE TWO STRINGS ARE NOT INTERCHANGEABLE. Chrome sandboxes extension storage
 * from other extensions and from web pages; localStorage is scoped to the origin
 * and readable by any script running on it. Neither is encrypted. Claiming the
 * extension's guarantee on the web is the kind of overclaim that unravels in a
 * Q&A — which is why the UI reads this rather than hardcoding either.
 * EXPLAINER §8.2.
 */
export const STORAGE_DESCRIPTION = IS_EXTENSION
    ? "Stored by Chrome in this extension's local storage — not synced, not readable by other extensions or sites."
    : "Stored in this browser, for this site only — it never reaches a server.";

/**
 * Resolve a bundled asset: pdf.js cmaps, standard fonts, wasm, and the Hebrew
 * export font.
 *
 * ⚠ LOAD-BEARING FOR HEBREW. cmaps decode CID fonts, and a wrong path here does
 * not throw — Hebrew simply extracts as garbage or not at all, which looks
 * exactly like an extraction bug. If line counts go to zero after a build change,
 * check the network tab before the code.
 *
 * Resolved against document.baseURI rather than a hardcoded "/", so the web build
 * still works when deployed under a subpath.
 */
export function assetUrl(path: string): string {
    if (IS_EXTENSION) return chrome.runtime.getURL(path);

    return new URL(path, document.baseURI).href;
}

export async function readStored<T>(key: string): Promise<T | undefined> {
    if (IS_EXTENSION) {
        const stored = await chrome.storage.local.get(key);
        return stored[key] as T | undefined;
    }

    const raw = localStorage.getItem(key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
}

export async function writeStored(key: string, value: unknown): Promise<void> {
    if (IS_EXTENSION) {
        await chrome.storage.local.set({ [key]: value });
        return;
    }

    localStorage.setItem(key, JSON.stringify(value));
}

export async function removeStored(key: string): Promise<void> {
    if (IS_EXTENSION) {
        await chrome.storage.local.remove(key);
        return;
    }

    localStorage.removeItem(key);
}