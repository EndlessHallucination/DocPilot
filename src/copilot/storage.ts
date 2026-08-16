/**
 * copilot/storage.ts
 *
 * One key/value slot for the API key, backed by chrome.storage.local in the
 * extension build and localStorage on the web. Everything else in the app is
 * already environment-agnostic; this is the only place that isn't.
 *
 * ⚠ ONE KEY, EVER. The context answers and the ask thread stay in memory —
 * that is §4's privacy claim, and it holds only as long as nothing widens this
 * interface. Both backends store a single JSON blob under a single name.
 */

/** True in the extension build, false on a deployed web page. */
export const IS_EXTENSION =
    typeof chrome !== "undefined" && chrome.runtime?.id !== undefined;

/**
 * Where the key actually lives, in words a user can check.
 *
 * ⚠ THE TWO STRINGS ARE NOT INTERCHANGEABLE. Chrome sandboxes extension
 * storage from other extensions and from web pages; localStorage is scoped to
 * the site's origin and readable by any script running on it. Neither is
 * encrypted. Claiming the extension's guarantee on the web is the kind of
 * overclaim that unravels in a Q&A.
 */
export const STORAGE_DESCRIPTION = IS_EXTENSION
    ? "Stored by Chrome in this extension's local storage — not synced, not readable by other extensions or sites."
    : "Stored in this browser, for this site only — it never reaches a server.";

/**
 * Resolve a bundled asset (pdf.js cmaps, fonts, wasm).
 *
 * The extension needs an absolute chrome-extension:// URL. The web build
 * resolves against document.baseURI rather than a hardcoded "/", so the app
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