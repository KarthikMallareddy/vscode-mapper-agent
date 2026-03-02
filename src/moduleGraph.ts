/**
 * moduleGraph.ts — Per-folder module import graph.
 *
 * Builds a directed graph of import relationships between source files,
 * grouped by folder/package. Edge count is capped per folder to prevent
 * visual clutter.
 */

import * as vscode from 'vscode';
import * as path from 'path';

// ──────────────────────── Types ────────────────────────

export interface ModuleNode {
    id: string;
    relPath: string;
    filePath: string;
    group: string; // folder/package name
}

export interface ModuleEdge {
    from: string;  // relPath
    to: string;    // relPath
    importLine: number;
}

export interface ModuleGraphResult {
    nodes: ModuleNode[];
    edges: ModuleEdge[];
    groups: Map<string, ModuleNode[]>;
}

// ──────────────────────── Config ────────────────────────

const MAX_FILES = 200;
const MAX_EDGES_PER_GROUP = 50;

const IGNORE_GLOB = '**/{node_modules,dist,out,.next,build,coverage,.turbo,venv,.venv,__pycache__,.history,.git,generated}/**';

// ──────────────────────── Graph Builder ────────────────────────

/**
 * Build a per-folder module import graph for the workspace.
 */
export async function buildModuleGraph(rootPath: string): Promise<ModuleGraphResult> {
    const fileUris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(rootPath, '**/*.{py,ts,tsx,js,jsx,mjs,go,java,kt,rs}'),
        IGNORE_GLOB,
        MAX_FILES
    );

    const nodes: ModuleNode[] = [];
    const edges: ModuleEdge[] = [];
    const groups = new Map<string, ModuleNode[]>();

    // Index all source files.
    const relPathSet = new Set<string>();
    const fileByRel = new Map<string, vscode.Uri>();
    for (const uri of fileUris) {
        const rel = path.relative(rootPath, uri.fsPath).replace(/\\/g, '/');
        relPathSet.add(rel);
        fileByRel.set(rel, uri);
        const group = groupForRel(rel);
        const id = toNodeId(rel);
        const node: ModuleNode = { id, relPath: rel, filePath: uri.fsPath, group };
        nodes.push(node);
        const arr = groups.get(group) || [];
        arr.push(node);
        groups.set(group, arr);
    }

    // Count edges per group to enforce cap.
    const edgeCountByGroup = new Map<string, number>();

    // Parse imports from each file.
    for (const uri of fileUris) {
        const rel = path.relative(rootPath, uri.fsPath).replace(/\\/g, '/');
        const group = groupForRel(rel);
        let text: string;
        try {
            text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        } catch {
            continue;
        }

        const ext = path.extname(rel).toLowerCase();
        const imports = extractImports(text, ext, rel);

        for (const imp of imports) {
            const resolved = resolveImport(imp.target, rel, relPathSet);
            if (!resolved) continue;

            // Cap edges per group.
            const count = edgeCountByGroup.get(group) || 0;
            if (count >= MAX_EDGES_PER_GROUP) continue;
            edgeCountByGroup.set(group, count + 1);

            edges.push({ from: rel, to: resolved, importLine: imp.line });
        }
    }

    return { nodes, edges, groups };
}

// ──────────────────────── Import Extraction ────────────────────────

interface RawImport {
    target: string;
    line: number;
}

function extractImports(text: string, ext: string, _relPath: string): RawImport[] {
    const lines = text.split(/\r?\n/);
    const imports: RawImport[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        switch (ext) {
            case '.py': {
                // from foo import bar / import foo
                const fromMatch = line.match(/^\s*from\s+(\S+)\s+import/);
                if (fromMatch) { imports.push({ target: fromMatch[1], line: i + 1 }); continue; }
                const impMatch = line.match(/^\s*import\s+(\S+)/);
                if (impMatch && !impMatch[1].startsWith('__')) imports.push({ target: impMatch[1], line: i + 1 });
                break;
            }
            case '.ts':
            case '.tsx':
            case '.js':
            case '.jsx':
            case '.mjs': {
                // import ... from "path" / require("path")
                const esMatch = line.match(/\bfrom\s+["']([^"']+)["']/);
                if (esMatch) { imports.push({ target: esMatch[1], line: i + 1 }); continue; }
                const cjsMatch = line.match(/require\s*\(\s*["']([^"']+)["']\s*\)/);
                if (cjsMatch) imports.push({ target: cjsMatch[1], line: i + 1 });
                break;
            }
            case '.go': {
                const goMatch = line.match(/^\s*"([^"]+)"/);
                if (goMatch) imports.push({ target: goMatch[1], line: i + 1 });
                break;
            }
            case '.java':
            case '.kt': {
                const javaMatch = line.match(/^\s*import\s+([\w.]+)/);
                if (javaMatch) imports.push({ target: javaMatch[1], line: i + 1 });
                break;
            }
        }
    }

    return imports;
}

// ──────────────────────── Import Resolution ────────────────────────

/**
 * Try to resolve an import string to a relPath in the project.
 * Returns null if it's an external / unresolvable import.
 */
function resolveImport(target: string, fromRel: string, knownPaths: Set<string>): string | null {
    // Skip absolute (non-relative) imports for JS/TS since they're packages.
    if (target.startsWith('.')) {
        return resolveRelative(fromRel, target, knownPaths);
    }

    // Python relative-style: convert dot notation to path
    if (target.includes('.') && !target.startsWith('@') && !target.includes('/')) {
        const pyPath = target.replace(/\./g, '/');
        return tryExtensions(pyPath, knownPaths);
    }

    // Try direct match (for Python absolute imports within the project)
    const directPath = target.replace(/\./g, '/');
    return tryExtensions(directPath, knownPaths);
}

function resolveRelative(fromRel: string, target: string, knownPaths: Set<string>): string | null {
    const fromDir = path.dirname(fromRel);
    const joined = path.posix.normalize(path.posix.join(fromDir, target));
    return tryExtensions(joined, knownPaths);
}

function tryExtensions(basePath: string, knownPaths: Set<string>): string | null {
    // Exact match
    if (knownPaths.has(basePath)) return basePath;

    // With common extensions
    const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.java', '.kt', '.rs'];
    for (const ext of exts) {
        if (knownPaths.has(basePath + ext)) return basePath + ext;
    }

    // Index file
    for (const ext of exts) {
        const indexPath = basePath + '/index' + ext;
        if (knownPaths.has(indexPath)) return indexPath;
    }

    // Python __init__.py
    if (knownPaths.has(basePath + '/__init__.py')) return basePath + '/__init__.py';

    return null;
}

// ──────────────────────── Helpers ────────────────────────

function groupForRel(rel: string): string {
    const parts = rel.split('/');
    if (parts.length <= 1) return '.';
    return parts[0]; // Top-level folder
}

function toNodeId(rel: string): string {
    return rel.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Build a Mermaid diagram from the module graph.
 */
export function buildModuleGraphMermaid(
    result: ModuleGraphResult,
    escapeMermaidLabel: (s: string) => string
): { mermaid: string; openMap: Record<string, { filePath: string; line: number }> } {
    const lines: string[] = ['flowchart LR'];
    const openMap: Record<string, { filePath: string; line: number }> = {};

    // Group nodes into subgraphs.
    for (const [group, groupNodes] of result.groups) {
        if (groupNodes.length === 0) continue;
        const groupId = toNodeId('mod_' + group);
        lines.push(`  subgraph ${groupId}[📂 ${escapeMermaidLabel(group)}]`);
        lines.push('    direction TB');
        for (const n of groupNodes.slice(0, 25)) { // Cap nodes per group
            const label = path.basename(n.relPath);
            lines.push(`    ${n.id}[${escapeMermaidLabel(label)}]`);
            openMap[label] = { filePath: n.filePath, line: 1 };
        }
        if (groupNodes.length > 25) {
            const moreId = toNodeId(`more_${group}`);
            lines.push(`    ${moreId}[+${groupNodes.length - 25} more]`);
            lines.push(`    style ${moreId} fill:none,stroke:none,color:#64748b,font-size:11px`);
        }
        lines.push('  end');
    }

    // Add edges.
    const addedEdges = new Set<string>();
    for (const e of result.edges) {
        const fromId = toNodeId(e.from);
        const toId = toNodeId(e.to);
        const key = `${fromId}->${toId}`;
        if (addedEdges.has(key)) continue;
        addedEdges.add(key);
        lines.push(`  ${fromId} --> ${toId}`);
    }

    return { mermaid: lines.join('\n'), openMap };
}
