/**
 * symbolIndex.ts — LSP-powered symbol collection with regex fallback.
 *
 * Uses VS Code's language server APIs as primary source:
 *   - vscode.executeDocumentSymbolProvider  (symbols in a file)
 *   - vscode.executeReferenceProvider       (cross-file references)
 *   - vscode.executeDefinitionProvider      (go-to-definition for imports)
 *
 * Falls back to regex heuristics when no language server is available.
 */

import * as vscode from 'vscode';
import * as path from 'path';

// ──────────────────────── Types ────────────────────────

export type SymbolKind = 'class' | 'function' | 'variable';

export interface IndexedSymbol {
    name: string;
    kind: SymbolKind;
    filePath: string;
    relPath: string;
    line: number;
    char: number;
    stableKey: string;
    /** Decorators / annotations directly above the definition (Python) */
    decorators?: Array<{ line: number; text: string; note?: string }>;
}

export interface SymbolReference {
    filePath: string;
    relPath: string;
    line: number;
    note?: string;
}

// ──────────────────────── Helpers ────────────────────────

function toSymbolKind(k: vscode.SymbolKind): SymbolKind | null {
    switch (k) {
        case vscode.SymbolKind.Class:
        case vscode.SymbolKind.Struct:
        case vscode.SymbolKind.Interface:
        case vscode.SymbolKind.Enum:
            return 'class';
        case vscode.SymbolKind.Function:
        case vscode.SymbolKind.Method:
        case vscode.SymbolKind.Constructor:
            return 'function';
        case vscode.SymbolKind.Variable:
        case vscode.SymbolKind.Constant:
        case vscode.SymbolKind.Property:
        case vscode.SymbolKind.Field:
            return 'variable';
        default:
            return null;
    }
}

function isPublicName(name: string, kind: SymbolKind): boolean {
    if (name.startsWith('_') && kind !== 'variable') return false;
    // Filter trivially private / internal names.
    if (name.startsWith('__') && name.endsWith('__')) return true; // dunder is fine
    if (/^[a-z]$/.test(name)) return false; // single-letter
    return true;
}

function isPublicVariable(name: string, relPath: string): boolean {
    if (/[a-z]/.test(name) && !/[A-Z_]/.test(name)) return false; // all-lowercase single word
    if (name.length <= 2) return false;
    const isAllCaps = /^[A-Z][A-Z0-9_]+$/.test(name);
    const isExport = /^(export|module\.exports)/.test(name);
    const isConfigFile = /(config|settings|constants)/i.test(relPath);
    return isAllCaps || isExport || isConfigFile;
}

// ──────────────────────── Primary: LSP Symbols ────────────────────────

/**
 * Get top-level symbols for a file using VS Code's document symbol provider.
 * Falls back to regex if no provider is available.
 */
export async function getSymbolsForFile(
    rootPath: string,
    filePath: string,
    maxSymbols = 200
): Promise<IndexedSymbol[]> {
    const uri = vscode.Uri.file(filePath);
    const relPath = path.relative(rootPath, filePath).replace(/\\/g, '/');
    const out: IndexedSymbol[] = [];

    try {
        const provided = await vscode.commands.executeCommand<any>(
            'vscode.executeDocumentSymbolProvider',
            uri
        );

        if (Array.isArray(provided) && provided.length > 0) {
            const first = provided[0];
            const isDocumentSymbol = first && typeof first === 'object' && 'range' in first;

            if (isDocumentSymbol) {
                for (const s of provided as vscode.DocumentSymbol[]) {
                    const kind = toSymbolKind(s.kind);
                    if (!kind) continue;
                    if (!isPublicName(s.name, kind)) continue;
                    if (kind === 'variable' && !isPublicVariable(s.name, relPath)) continue;
                    const line = (s.selectionRange?.start?.line ?? s.range.start.line) + 1;
                    const ch = s.selectionRange?.start?.character ?? s.range.start.character ?? 0;
                    out.push({
                        name: s.name,
                        kind,
                        filePath,
                        relPath,
                        line,
                        char: ch,
                        stableKey: `${kind}:${s.name}:${relPath}:${line}`,
                    });
                    if (out.length >= maxSymbols) break;
                }
            } else {
                // SymbolInformation format (older providers)
                for (const s of provided as Array<{ name: string; kind: vscode.SymbolKind; location: vscode.Location }>) {
                    const kind = toSymbolKind(s.kind);
                    if (!kind) continue;
                    if (!isPublicName(s.name, kind)) continue;
                    if (kind === 'variable' && !isPublicVariable(s.name, relPath)) continue;
                    const line = (s.location?.range?.start?.line ?? 0) + 1;
                    const ch = s.location?.range?.start?.character ?? 0;
                    out.push({
                        name: s.name,
                        kind,
                        filePath,
                        relPath,
                        line,
                        char: ch,
                        stableKey: `${kind}:${s.name}:${relPath}:${line}`,
                    });
                    if (out.length >= maxSymbols) break;
                }
            }

            if (out.length > 0) return out;
        }
    } catch {
        // LSP not available, fall through to regex.
    }

    // ──── Regex fallback ────
    return getSymbolsFromRegex(rootPath, filePath, relPath, maxSymbols);
}

/**
 * Get cross-file references for a symbol using VS Code's reference provider.
 */
export async function getReferencesForSymbol(
    rootPath: string,
    filePath: string,
    line: number,
    char: number,
    maxRefs = 30
): Promise<SymbolReference[]> {
    const uri = vscode.Uri.file(filePath);
    const pos = new vscode.Position(Math.max(0, line - 1), Math.max(0, char));
    const refs: SymbolReference[] = [];
    const seen = new Set<string>();

    try {
        const locations = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeReferenceProvider',
            uri,
            pos
        );

        if (!Array.isArray(locations)) return refs;

        for (const loc of locations) {
            const fp = loc.uri.fsPath;
            const rp = path.relative(rootPath, fp).replace(/\\/g, '/');
            const refLine = (loc.range?.start?.line ?? 0) + 1;

            // Skip the definition itself.
            if (fp === filePath && refLine === line) continue;
            // Skip node_modules / dist.
            if (rp.includes('node_modules') || rp.startsWith('dist/')) continue;

            const key = `${fp}:${refLine}`;
            if (seen.has(key)) continue;
            seen.add(key);

            refs.push({ filePath: fp, relPath: rp, line: refLine, note: 'Reference' });
            if (refs.length >= maxRefs) break;
        }
    } catch {
        // No reference provider available.
    }

    return refs;
}

/**
 * Resolve a definition location for a symbol (e.g., an import) using VS Code's definition provider.
 */
export async function getDefinitionLocation(
    filePath: string,
    line: number,
    char: number
): Promise<{ filePath: string; line: number; char: number } | null> {
    const uri = vscode.Uri.file(filePath);
    const pos = new vscode.Position(Math.max(0, line - 1), Math.max(0, char));

    try {
        const defs = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
            'vscode.executeDefinitionProvider',
            uri,
            pos
        );

        if (!Array.isArray(defs) || defs.length === 0) return null;

        const first = defs[0] as any;
        if (first.targetUri) {
            // LocationLink
            return {
                filePath: first.targetUri.fsPath,
                line: (first.targetSelectionRange?.start?.line ?? first.targetRange?.start?.line ?? 0) + 1,
                char: first.targetSelectionRange?.start?.character ?? 0,
            };
        } else if (first.uri) {
            // Location
            return {
                filePath: first.uri.fsPath,
                line: (first.range?.start?.line ?? 0) + 1,
                char: first.range?.start?.character ?? 0,
            };
        }
    } catch {
        // No definition provider.
    }
    return null;
}

// ──────────────────────── Regex Fallback ────────────────────────

async function getSymbolsFromRegex(
    rootPath: string,
    filePath: string,
    relPath: string,
    maxSymbols: number
): Promise<IndexedSymbol[]> {
    const out: IndexedSymbol[] = [];
    const ext = path.extname(filePath).toLowerCase();

    try {
        const uri = vscode.Uri.file(filePath);
        const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        const lines = raw.split(/\r?\n/);

        if (ext === '.py') {
            collectPythonSymbols(lines, filePath, relPath, out, maxSymbols);
        } else if (['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext)) {
            collectTsJsSymbols(lines, filePath, relPath, out, maxSymbols);
        }
    } catch {
        // Can't read file.
    }
    return out;
}

function collectPythonSymbols(
    lines: string[],
    filePath: string,
    relPath: string,
    out: IndexedSymbol[],
    max: number
): void {
    for (let i = 0; i < lines.length && out.length < max; i++) {
        const line = lines[i];
        const funcMatch = line.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
        if (funcMatch && !funcMatch[1].startsWith('_')) {
            out.push({ name: funcMatch[1], kind: 'function', filePath, relPath, line: i + 1, char: 0, stableKey: `function:${funcMatch[1]}:${relPath}:${i + 1}` });
            continue;
        }
        const classMatch = line.match(/^class\s+([A-Za-z_]\w*)\s*[:(]/);
        if (classMatch) {
            out.push({ name: classMatch[1], kind: 'class', filePath, relPath, line: i + 1, char: 0, stableKey: `class:${classMatch[1]}:${relPath}:${i + 1}` });
            continue;
        }
        const varMatch = line.match(/^([A-Z][A-Z0-9_]+)\s*=/);
        if (varMatch) {
            out.push({ name: varMatch[1], kind: 'variable', filePath, relPath, line: i + 1, char: 0, stableKey: `variable:${varMatch[1]}:${relPath}:${i + 1}` });
        }
    }
}

function collectTsJsSymbols(
    lines: string[],
    filePath: string,
    relPath: string,
    out: IndexedSymbol[],
    max: number
): void {
    for (let i = 0; i < lines.length && out.length < max; i++) {
        const line = lines[i];
        const funcMatch = line.match(/^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$]\w*)\s*[(<]/);
        if (funcMatch) {
            out.push({ name: funcMatch[1], kind: 'function', filePath, relPath, line: i + 1, char: 0, stableKey: `function:${funcMatch[1]}:${relPath}:${i + 1}` });
            continue;
        }
        const arrowMatch = line.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$]\w*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$]\w*)\s*=>/);
        if (arrowMatch) {
            out.push({ name: arrowMatch[1], kind: 'function', filePath, relPath, line: i + 1, char: 0, stableKey: `function:${arrowMatch[1]}:${relPath}:${i + 1}` });
            continue;
        }
        const classMatch = line.match(/^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$]\w*)(?:\s+|{|<)/);
        if (classMatch) {
            out.push({ name: classMatch[1], kind: 'class', filePath, relPath, line: i + 1, char: 0, stableKey: `class:${classMatch[1]}:${relPath}:${i + 1}` });
            continue;
        }
        const ifaceMatch = line.match(/^(?:export\s+)?interface\s+([A-Za-z_$]\w*)(?:\s+|{|<)/);
        if (ifaceMatch) {
            out.push({ name: ifaceMatch[1], kind: 'class', filePath, relPath, line: i + 1, char: 0, stableKey: `class:${ifaceMatch[1]}:${relPath}:${i + 1}` });
        }
    }
}
