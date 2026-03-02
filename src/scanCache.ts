/**
 * scanCache.ts — Workspace scan cache with file watcher invalidation.
 *
 * Caches the WorkspaceScan result per rootPath and invalidates it
 * when files are created, deleted, or modified (debounced).
 */

import * as vscode from 'vscode';

/** The maximum age (ms) before a cached scan is considered stale. */
const MAX_CACHE_AGE_MS = 5 * 60 * 1000; // 5 minutes

/** Debounce time (ms) before invalidating the cache after a file change event. */
const DEBOUNCE_MS = 2000;

/** Generic scan result – the actual type is defined in extension.ts. We use `any` to avoid circular imports. */
interface CacheEntry {
    scan: any;
    timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

let watcher: vscode.FileSystemWatcher | undefined;

/**
 * Retrieve a cached scan if it exists and is fresh enough.
 * Returns `null` if no valid cache entry is available.
 */
export function getCachedScan(rootPath: string): any | null {
    const entry = cache.get(rootPath);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > MAX_CACHE_AGE_MS) {
        cache.delete(rootPath);
        return null;
    }
    return entry.scan;
}

/**
 * Store a scan result in the cache.
 */
export function setCachedScan(rootPath: string, scan: any): void {
    cache.set(rootPath, { scan, timestamp: Date.now() });
}

/**
 * Invalidate the cache for a specific rootPath.
 */
export function invalidateCache(rootPath: string): void {
    cache.delete(rootPath);
}

/**
 * Invalidate all cached scans.
 */
export function invalidateAll(): void {
    cache.clear();
}

/**
 * Determine which rootPath (if any) a given file URI belongs to.
 */
function rootPathForUri(uri: vscode.Uri): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return null;
    const fsPath = uri.fsPath.toLowerCase();
    for (const f of folders) {
        if (fsPath.startsWith(f.uri.fsPath.toLowerCase())) {
            return f.uri.fsPath;
        }
    }
    return null;
}

/**
 * Debounced invalidation: rapid file changes only trigger one invalidation.
 */
function debouncedInvalidate(rootPath: string): void {
    const existing = debounceTimers.get(rootPath);
    if (existing) clearTimeout(existing);
    debounceTimers.set(rootPath, setTimeout(() => {
        invalidateCache(rootPath);
        debounceTimers.delete(rootPath);
    }, DEBOUNCE_MS));
}

/**
 * Initialize the file watcher. Call this once during extension activation.
 * Returns a Disposable so the watcher is cleaned up on deactivation.
 */
export function initCacheWatcher(): vscode.Disposable {
    if (watcher) watcher.dispose();

    // Watch for source-file changes across the workspace.
    watcher = vscode.workspace.createFileSystemWatcher(
        '**/*.{py,ts,tsx,js,jsx,java,kt,go,rs,json,toml,txt,yml,yaml,env,mod,lock}',
        false, false, false
    );

    const onChange = (uri: vscode.Uri) => {
        const root = rootPathForUri(uri);
        if (root) debouncedInvalidate(root);
    };

    watcher.onDidCreate(onChange);
    watcher.onDidChange(onChange);
    watcher.onDidDelete(onChange);

    return watcher;
}
