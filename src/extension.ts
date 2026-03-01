import * as vscode from 'vscode';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    console.log('@mapper is now active!');

    const resetCommand = vscode.commands.registerCommand('mapper.resetApiKey', async () => {
        await context.secrets.delete("GEMINI_API_KEY");
        vscode.window.showInformationMessage("🔄 Gemini API Key cleared.");
    });
    context.subscriptions.push(resetCommand);

    const mapper = vscode.chat.createChatParticipant("mapper", async (request, context_chat, response, token) => {
        // /draw does not require an API key; keep Gemini wiring for future commands.
        // const apiKey = await getApiKey(context);
        // (AI wiring disabled for now)

        if (request.command === 'draw') {
            response.markdown("🎨 **@mapper is performing a Deep Scan...**\n\n");
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) return;

            const rootPath = workspaceFolders[0].uri.fsPath;
            // const fileTree = await getFileTree(rootPath);
            
            try {
                const scan = await scanWorkspace(rootPath);
                const preview = buildPreviewFromScan(scan);
                openMermaidPreview(preview);

            } catch (err: any) {
                response.markdown(`❌ **Scan Error:** ${err.message}`);
            }
            return;
        }

        response.markdown("👋 I am **@mapper**. Try `/draw`!");
    });

    context.subscriptions.push(mapper);
}

function sanitizeMermaid(text: string): string {
    // The model sometimes emits markdown, headings, or ASCII separators (----) that break Mermaid parsing.
    const withoutFences = text.replace(/```mermaid\s*/gi, '').replace(/```\s*/g, '');
    const withoutMultilineLabels = collapseMermaidLabelNewlines(withoutFences);

    const lines = withoutMultilineLabels
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.replace(/\s+$/g, '')); // rtrim

    const cleaned: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Drop common non-Mermaid noise.
        if (/^#+\s+/.test(trimmed)) continue; // markdown headings
        if (/^[-=_]{3,}$/.test(trimmed)) continue; // ASCII separators
        if (/^```/.test(trimmed)) continue;

        // Drop clearly incomplete node declarations like "O[" or "O(" or "O{".
        // These happen when the model breaks labels across lines.
        if (/^[A-Za-z0-9_]+\s*[\[\(\{]\s*$/.test(trimmed)) continue;

        // If the line defines a node but then trails off into a separator like:
        //   A[Label] --------------------
        // keep only the node definition so Mermaid can parse the diagram.
        const nodeWithTail = line.match(/^(\s*[A-Za-z0-9_]+\s*(?:\[[^\]]*\]|\([^\)]*\)|\{[^\}]*\}))\s*-{3,}\s*$/);
        if (nodeWithTail) {
            cleaned.push(nodeWithTail[1]);
            continue;
        }

        // Drop "node[" lines that are effectively just separators (unclosed or empty labels).
        if (/^[A-Za-z0-9_]+\s*\[\s*-{3,}\s*$/.test(trimmed)) continue;
        if (/^[A-Za-z0-9_]+\s*\[\s*\]$/.test(trimmed)) continue;

        cleaned.push(line);
    }

    let result = cleaned.join('\n').trim();

    // Ensure a diagram directive exists.
    if (!/^(flowchart|graph)\s+/i.test(result)) {
        result = `flowchart TD\n${result}`;
    }

    return result;
}

function collapseMermaidLabelNewlines(input: string): string {
    // Mermaid node labels cannot contain raw newlines inside [], (), {}.
    // Convert newlines to spaces while inside any of these delimiters.
    let square = 0;
    let paren = 0;
    let brace = 0;
    let out = '';

    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch === '[') square++;
        else if (ch === ']' && square > 0) square--;
        else if (ch === '(') paren++;
        else if (ch === ')' && paren > 0) paren--;
        else if (ch === '{') brace++;
        else if (ch === '}' && brace > 0) brace--;

        if ((square > 0 || paren > 0 || brace > 0) && ch === '\n') {
            out += ' ';
        } else {
            out += ch;
        }
    }

    return out;
}

type ScanNodeKind = 'frontend' | 'backend' | 'service' | 'datastore' | 'external' | 'unknown';

interface ScanNode {
    id: string;
    label: string;
    kind: ScanNodeKind;
}

type SymbolKind = 'function' | 'class' | 'variable';

interface SymbolDef {
    name: string;
    kind: SymbolKind;
    filePath: string; // absolute
    relPath: string;  // workspace-relative
    line: number;     // 1-based
}

interface SymbolUse {
    filePath: string; // absolute
    relPath: string;  // workspace-relative
    line: number;     // 1-based
}

interface ScanEdge {
    from: string;
    to: string;
    label?: string;
}

interface WorkspaceScan {
    nodes: ScanNode[];
    edges: ScanEdge[];
    notes: string[];
    detailsByKind: Record<ScanNodeKind, Array<{ label: string; relPath?: string; filePath?: string }>>;
    symbols: SymbolDef[];
    symbolUses: Record<string, SymbolUse[]>; // key = `${kind}:${name}`
}

interface MermaidPreview {
    startViewId: string;
    views: Record<string, string>;
    navByViewId: Record<string, Record<string, string>>;
    openByViewId: Record<string, Record<string, { filePath: string; line: number }>>;
}

async function scanWorkspace(rootPath: string): Promise<WorkspaceScan> {
    const nodes: ScanNode[] = [];
    const edges: ScanEdge[] = [];
    const notes: string[] = [];

    const depHints = new Set<string>();
    const envKeys = new Set<string>();
    const detailsByKind: WorkspaceScan["detailsByKind"] = {
        frontend: [],
        backend: [],
        service: [],
        datastore: [],
        external: [],
        unknown: [],
    };
    const symbols: SymbolDef[] = [];
    const symbolUses: Record<string, SymbolUse[]> = {};
    const inspectedSourceFiles = new Set<string>();

    const packageJsonUris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(rootPath, '**/package.json'),
        '**/{node_modules,dist,out,.next,build,coverage,.turbo,.history,.git}/**',
        200
    );

    const pkgInfos: Array<{ name: string; dirName: string; fullPath: string; deps: Set<string> }> = [];

    for (const uri of packageJsonUris) {
        const fullPath = uri.fsPath;
        const dir = path.dirname(fullPath);
        const dirName = path.basename(dir);

        if (fullPath.includes(`${path.sep}node_modules${path.sep}`)) continue;

        try {
            const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
            const json = JSON.parse(raw);
            const name = String(json.name || dirName);
            const deps = new Set<string>([
                ...Object.keys(json.dependencies || {}),
                ...Object.keys(json.devDependencies || {}),
                ...Object.keys(json.peerDependencies || {}),
            ]);
            pkgInfos.push({ name, dirName, fullPath, deps });
            for (const d of deps) depHints.add(d.toLowerCase());
        } catch {
            // Ignore unreadable package.json files.
        }
    }

    notes.push(`Workspace root: ${rootPath}`);
    notes.push(`Found ${pkgInfos.length} package.json file(s) under workspace root.`);

    // Python / Java / Go / Rust / etc project markers (to support non-Node repos).
    const requirementsUris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(rootPath, '**/requirements.txt'),
        '**/{node_modules,dist,out,.next,build,coverage,.turbo,venv,.venv,__pycache__,.history,.git}/**',
        50
    );
    const pyprojectUris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(rootPath, '**/pyproject.toml'),
        '**/{node_modules,dist,out,.next,build,coverage,.turbo,venv,.venv,__pycache__,.history,.git}/**',
        50
    );
    const pipfileUris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(rootPath, '**/Pipfile'),
        '**/{node_modules,dist,out,.next,build,coverage,.turbo,venv,.venv,__pycache__,.history,.git}/**',
        20
    );
    const environmentYmlUris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(rootPath, '**/environment.yml'),
        '**/{node_modules,dist,out,.next,build,coverage,.turbo,venv,.venv,__pycache__,.history,.git}/**',
        20
    );
    const goModUris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(rootPath, '**/go.mod'),
        '**/{node_modules,dist,out,.next,build,coverage,.turbo,.history,.git}/**',
        20
    );
    const cargoTomlUris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(rootPath, '**/Cargo.toml'),
        '**/{node_modules,dist,out,.next,build,coverage,.turbo,.history,.git}/**',
        20
    );
    const pomXmlUris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(rootPath, '**/pom.xml'),
        '**/{node_modules,dist,out,.next,build,coverage,.turbo,.history,.git}/**',
        20
    );
    const gradleUris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(rootPath, '**/build.gradle*'),
        '**/{node_modules,dist,out,.next,build,coverage,.turbo,.history,.git}/**',
        20
    );
    const envUris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(rootPath, '**/.env*'),
        '**/{node_modules,dist,out,.next,build,coverage,.turbo,.history,.git}/**',
        20
    );

    const hasPythonProject = requirementsUris.length > 0 || pyprojectUris.length > 0 || pipfileUris.length > 0 || environmentYmlUris.length > 0;
    const hasGoProject = goModUris.length > 0;
    const hasRustProject = cargoTomlUris.length > 0;
    const hasJavaProject = pomXmlUris.length > 0 || gradleUris.length > 0;

    notes.push(`Found ${requirementsUris.length} requirements.txt file(s).`);
    notes.push(`Found ${pyprojectUris.length} pyproject.toml file(s).`);
    notes.push(`Found ${pipfileUris.length} Pipfile(s).`);
    notes.push(`Found ${environmentYmlUris.length} environment.yml file(s).`);
    notes.push(`Found ${goModUris.length} go.mod file(s).`);
    notes.push(`Found ${cargoTomlUris.length} Cargo.toml file(s).`);
    notes.push(`Found ${pomXmlUris.length} pom.xml file(s).`);
    notes.push(`Found ${gradleUris.length} build.gradle file(s).`);
    notes.push(`Found ${envUris.length} .env file(s).`);

    for (const uri of requirementsUris) {
        const text = await readTextFile(uri);
        if (!text) continue;
        for (const dep of parseRequirementsTxt(text)) depHints.add(dep);
    }
    for (const uri of pyprojectUris) {
        const text = await readTextFile(uri);
        if (!text) continue;
        for (const dep of parsePyprojectTomlDeps(text)) depHints.add(dep);
    }
    for (const uri of pipfileUris) {
        const text = await readTextFile(uri);
        if (!text) continue;
        for (const dep of parsePipfileDeps(text)) depHints.add(dep);
    }
    for (const uri of environmentYmlUris) {
        const text = await readTextFile(uri);
        if (!text) continue;
        for (const dep of parseEnvironmentYmlDeps(text)) depHints.add(dep);
    }
    for (const uri of goModUris) {
        const text = await readTextFile(uri);
        if (!text) continue;
        for (const dep of parseGoModDeps(text)) depHints.add(dep);
    }
    for (const uri of cargoTomlUris) {
        const text = await readTextFile(uri);
        if (!text) continue;
        for (const dep of parseCargoTomlDeps(text)) depHints.add(dep);
    }
    for (const uri of pomXmlUris) {
        const text = await readTextFile(uri);
        if (!text) continue;
        for (const dep of parsePomXmlDeps(text)) depHints.add(dep);
    }
    for (const uri of gradleUris) {
        const text = await readTextFile(uri);
        if (!text) continue;
        for (const dep of parseGradleDeps(text)) depHints.add(dep);
    }
    for (const uri of envUris) {
        const text = await readTextFile(uri);
        if (!text) continue;
        for (const key of parseDotEnvKeys(text)) envKeys.add(key);
    }

    // Python-centric discovery: classify .py files into sections based on imports + paths.
    if (hasPythonProject) {
        const pyUris = await vscode.workspace.findFiles(
            new vscode.RelativePattern(rootPath, '**/*.py'),
            '**/{node_modules,dist,out,.next,build,coverage,.turbo,venv,.venv,__pycache__,.history,.git}/**',
            250
        );

        // Cap reads to keep scanning quick.
        const maxFilesToRead = Math.min(pyUris.length, 120);
        for (let i = 0; i < maxFilesToRead; i++) {
            const uri = pyUris[i];
            const rel = path.relative(rootPath, uri.fsPath).replace(/\\/g, '/');
            if (rel.startsWith('.history/') || rel.startsWith('.git/')) continue;
            if (rel.startsWith('venv/') || rel.startsWith('.venv/')) continue;
            if (rel.includes('/__pycache__/')) continue;
            const text = await readTextFile(uri);
            inspectedSourceFiles.add(uri.fsPath);
            const lower = (text || '').toLowerCase();

            const isStreamlitFile = /\bimport\s+streamlit\b|\bfrom\s+streamlit\b|\bst\./.test(lower) || rel.startsWith('pages/');
            const isFastApiFile = /\bfrom\s+fastapi\b|\bimport\s+fastapi\b|\bfastapi\s*\(/.test(lower) || /\bfastapi\s*\(\s*\)/.test(lower);
            const isFlaskFile = /\bfrom\s+flask\b|\bimport\s+flask\b|\bflask\s*\(|\bflaskapp\b/.test(lower) || /\bflask\s*\(\s*\)/.test(lower);
            const isDjangoFile = /\bdjango\b/.test(lower) || rel === 'manage.py' || rel.endsWith('/wsgi.py') || rel.endsWith('/asgi.py');

            const usesDb = /\bsqlalchemy\b|\bpsycopg2\b|\basyncpg\b|\bpymongo\b|\bmongodb\b|\bredis\b|\bcreate_engine\b/.test(lower);
            const usesExternal = /\bopenai\b|\bsupabase\b|\bfirebase_admin\b|\brequests\b|\bhttpx\b|\baiohttp\b/.test(lower);

            if (isStreamlitFile) {
                detailsByKind.frontend.push({ label: rel, relPath: rel, filePath: uri.fsPath });
                collectPythonSymbols(rootPath, uri.fsPath, rel, text || '', symbols);
                continue;
            }

            if (isFastApiFile || isFlaskFile || isDjangoFile) {
                detailsByKind.backend.push({ label: rel, relPath: rel, filePath: uri.fsPath });
                collectPythonSymbols(rootPath, uri.fsPath, rel, text || '', symbols);
                continue;
            }

            if (usesDb) {
                detailsByKind.datastore.push({ label: rel, relPath: rel, filePath: uri.fsPath });
                collectPythonSymbols(rootPath, uri.fsPath, rel, text || '', symbols);
                continue;
            }

            if (usesExternal) {
                detailsByKind.external.push({ label: rel, relPath: rel, filePath: uri.fsPath });
                collectPythonSymbols(rootPath, uri.fsPath, rel, text || '', symbols);
                continue;
            }

            // Heuristic by folder name.
            if (/(^|\/)(api|routes|router|controllers)(\/|$)/.test(rel)) detailsByKind.backend.push({ label: rel, relPath: rel, filePath: uri.fsPath });
            else if (/(^|\/)(ui|views|templates|static)(\/|$)/.test(rel)) detailsByKind.frontend.push({ label: rel, relPath: rel, filePath: uri.fsPath });
            else detailsByKind.unknown.push({ label: rel, relPath: rel, filePath: uri.fsPath });
            collectPythonSymbols(rootPath, uri.fsPath, rel, text || '', symbols);
        }

        notes.push(`Python file scan: ${Math.min(pyUris.length, 250)} file(s) discovered; ${Math.min(pyUris.length, 120)} inspected.`);
    }

    // If we still don't have any signals, do a lightweight source scan for framework/service imports.
    if (depHints.size === 0) {
        const sourceUris = await vscode.workspace.findFiles(
            new vscode.RelativePattern(rootPath, '**/*.{py,ts,tsx,js,jsx,java,kt,go,rs}'),
            '**/{node_modules,dist,out,.next,build,coverage,.turbo,venv,.venv,__pycache__,.history,.git}/**',
            200
        );
        const sampled = sourceUris.slice(0, 120);
        for (const uri of sampled) {
            const text = await readTextFile(uri);
            if (!text) continue;
            for (const hint of extractImportHints(text)) depHints.add(hint);
        }
        notes.push(`Scanned ${sampled.length} source file(s) for import hints.`);
    }

    for (const pkg of pkgInfos) {
        const kind = inferKindFromPackage(pkg);
        const id = toMermaidId(pkg.dirName || pkg.name);
        nodes.push({ id, label: prettyLabel(pkg.dirName || pkg.name), kind });
    }

    // Datastores/external services based on concrete deps OR env keys.
    const hasMongo = hasAny(depHints, ['mongoose', 'mongodb', 'pymongo']) || hasAnyEnv(envKeys, ['MONGODB_URI']);
    const hasPostgres = hasAny(depHints, ['pg', 'postgres', 'psycopg2', 'psycopg', 'asyncpg', 'sqlalchemy']) || hasAnyEnv(envKeys, ['DATABASE_URL']);
    const hasRedis = hasAny(depHints, ['redis', 'ioredis', 'redis-py']) || hasAnyEnv(envKeys, ['REDIS_URL']);
    const hasSupabase = hasAny(depHints, ['@supabase/supabase-js', 'supabase']) || hasAnyEnv(envKeys, ['SUPABASE_URL', 'SUPABASE_ANON_KEY']);
    const hasFirebase = hasAny(depHints, ['firebase', 'firebase-admin', 'firebase_admin']) || hasAnyEnv(envKeys, ['FIREBASE_PROJECT_ID']);
    const hasOpenAI = hasAny(depHints, ['openai', '@openai/openai']) || hasAnyEnv(envKeys, ['OPENAI_API_KEY']);
    const hasHttpClient = hasAny(depHints, ['axios', 'requests', 'httpx', 'aiohttp', 'urllib3']);
    const hasExpress = hasAny(depHints, ['express', 'fastify', 'koa', '@types/express']);
    const hasFastAPI = hasAny(depHints, ['fastapi', 'uvicorn', 'starlette']);
    const hasFlask = hasAny(depHints, ['flask']);
    const hasDjango = hasAny(depHints, ['django']);
    const hasStreamlit = hasAny(depHints, ['streamlit']);
    const hasSpringBoot = hasAny(depHints, ['spring-boot', 'spring-boot-starter-web']);
    const hasGin = hasAny(depHints, ['github.com/gin-gonic/gin']);
    const hasFiber = hasAny(depHints, ['github.com/gofiber/fiber']);
    const hasAxum = hasAny(depHints, ['axum']);
    const hasActix = hasAny(depHints, ['actix-web']);

    if (hasMongo) ensureNode(nodes, 'MongoDB', 'MongoDB', 'datastore');
    if (hasPostgres) ensureNode(nodes, 'Postgres', 'PostgreSQL', 'datastore');
    if (hasRedis) ensureNode(nodes, 'Redis', 'Redis Cache', 'datastore');

    if (hasSupabase) ensureNode(nodes, 'Supabase', 'Supabase', 'external');
    if (hasFirebase) ensureNode(nodes, 'Firebase', 'Firebase', 'external');
    if (hasOpenAI) ensureNode(nodes, 'OpenAI', 'OpenAI API', 'external');

    // Add top-level app nodes for non-Node repos.
    if (hasStreamlit && !nodes.some((n) => n.kind === 'frontend')) {
        ensureNode(nodes, 'StreamlitApp', 'Streamlit App', 'frontend');
        if (detailsByKind.frontend.length === 0) detailsByKind.frontend.push({ label: 'Streamlit App' });
    }

    if ((hasFastAPI || hasFlask || hasDjango || hasSpringBoot || hasGin || hasFiber || hasAxum || hasActix) && !nodes.some((n) => n.kind === 'backend')) {
        ensureNode(nodes, 'Backend', 'Backend/API', 'backend');
        if (detailsByKind.backend.length === 0) detailsByKind.backend.push({ label: 'Backend/API' });
    }

    // Generic app nodes when we can infer the ecosystem but not the framework.
    if (!nodes.some((n) => n.kind === 'frontend' || n.kind === 'backend')) {
        if (hasPythonProject) {
            ensureNode(nodes, 'PythonApp', 'Python App', 'backend');
            if (detailsByKind.backend.length === 0) detailsByKind.backend.push({ label: 'Python App' });
        } else if (hasGoProject) {
            ensureNode(nodes, 'GoService', 'Go Service', 'backend');
            if (detailsByKind.backend.length === 0) detailsByKind.backend.push({ label: 'Go Service' });
        } else if (hasRustProject) {
            ensureNode(nodes, 'RustService', 'Rust Service', 'backend');
            if (detailsByKind.backend.length === 0) detailsByKind.backend.push({ label: 'Rust Service' });
        } else if (hasJavaProject) {
            ensureNode(nodes, 'JavaService', 'Java Service', 'backend');
            if (detailsByKind.backend.length === 0) detailsByKind.backend.push({ label: 'Java Service' });
        }
    }

    // Choose a backend node if one exists.
    const effectiveBackendId = nodes.find((n) => n.kind === 'backend')?.id || null;

    // Frontends -> backend edges.
    if (effectiveBackendId) {
        for (const n of nodes) {
            if (n.id === effectiveBackendId) continue;
            if (n.kind === 'frontend') {
                edges.push({ from: n.id, to: effectiveBackendId, label: hasHttpClient ? 'HTTP' : undefined });
            }
        }
    }

    // Backend -> datastores/external edges.
    if (effectiveBackendId) {
        for (const n of nodes) {
            if (n.id === effectiveBackendId) continue;
            if (n.kind === 'datastore' || n.kind === 'external') {
                edges.push({ from: effectiveBackendId, to: n.id });
            }
        }
    }

    // If there's no backend, connect the primary frontend/app node to datastores/external so the graph isn't empty.
    if (!effectiveBackendId) {
        const appNodeId = nodes.find((n) => n.kind === 'frontend')?.id || nodes.find((n) => n.kind === 'backend')?.id || null;
        if (appNodeId) {
            for (const n of nodes) {
                if (n.id === appNodeId) continue;
                if (n.kind === 'datastore' || n.kind === 'external') {
                    edges.push({ from: appNodeId, to: n.id });
                }
            }
        }
    }

    if (nodes.length === 0) {
        notes.push('No package.json files detected; diagram is minimal.');
        nodes.push({ id: 'Workspace', label: 'Workspace', kind: 'unknown' });
        if (detailsByKind.unknown.length === 0) detailsByKind.unknown.push({ label: 'Workspace' });
    }

    if (hasHttpClient && !effectiveBackendId) {
        notes.push('Detected HTTP client usage but no backend was identified.');
    }

    // Keep detail lists bounded for readability.
    for (const k of Object.keys(detailsByKind) as ScanNodeKind[]) {
        if (detailsByKind[k].length > 30) {
            detailsByKind[k] = detailsByKind[k].slice(0, 30);
            notes.push(`Truncated ${k} details to 30 items.`);
        }
    }

    // Build a bounded "where used" index for extracted symbols (Python-focused for now).
    await indexSymbolUses(rootPath, symbols, Array.from(inspectedSourceFiles), symbolUses, notes);

    return { nodes, edges, notes, detailsByKind, symbols, symbolUses };
}

function inferKindFromPackage(pkg: { dirName: string; deps: Set<string> }): ScanNodeKind {
    const name = (pkg.dirName || '').toLowerCase();
    if (name.includes('front')) return 'frontend';
    if (name.includes('back')) return 'backend';
    if (name.includes('server')) return 'backend';
    if (name.includes('extension')) return 'frontend';

    if (pkg.deps.has('next') || pkg.deps.has('react') || pkg.deps.has('react-dom')) return 'frontend';
    if (pkg.deps.has('express') || pkg.deps.has('fastify') || pkg.deps.has('koa')) return 'backend';

    return 'unknown';
}

function ensureNode(nodes: ScanNode[], id: string, label: string, kind: ScanNodeKind) {
    if (nodes.some((n) => n.id === id)) return;
    nodes.push({ id, label, kind });
}

function collectPythonSymbols(rootPath: string, filePath: string, relPath: string, text: string, out: SymbolDef[]) {
    // Very lightweight Python symbol extraction (module-level defs/classes, plus top-level assignments).
    // This is heuristic by design; keeps the diagram explainable without needing a full parser.
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const maxSymbolsPerFile = 30;
    let added = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        if (/^\s+/.test(line)) continue; // skip indented (nested) for now
        if (/^\s*#/.test(line)) continue;

        const defMatch = line.match(/^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
        if (defMatch) {
            out.push({ name: defMatch[1], kind: 'function', filePath, relPath, line: i + 1 });
            added++;
            if (added >= maxSymbolsPerFile) return;
            continue;
        }

        const classMatch = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\(|:)/);
        if (classMatch) {
            out.push({ name: classMatch[1], kind: 'class', filePath, relPath, line: i + 1 });
            added++;
            if (added >= maxSymbolsPerFile) return;
            continue;
        }

        const assignMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[^=]/);
        if (assignMatch) {
            const name = assignMatch[1];
            // Ignore obvious dunder/constants and ultra-common names.
            if (name.startsWith('__')) continue;
            if (['app', 'main', 'data', 'df', 'st', 'logger', 'config'].includes(name.toLowerCase())) continue;
            out.push({ name, kind: 'variable', filePath, relPath, line: i + 1 });
            added++;
            if (added >= maxSymbolsPerFile) return;
        }
    }
}

async function indexSymbolUses(
    rootPath: string,
    symbols: SymbolDef[],
    inspectedFiles: string[],
    outUses: Record<string, SymbolUse[]>,
    notes: string[]
) {
    // Bounded global usage scan across extracted symbols and already-inspected Python files.
    // Keeps output useful without turning into a full code-indexer.
    const maxSymbols = 120;
    const maxUsesPerSymbol = 10;

    const unique: SymbolDef[] = [];
    const seen = new Set<string>();

    for (const s of symbols) {
        if (!s.name || s.name.length < 3) continue;
        const key = `${s.kind}:${s.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(s);
        if (unique.length >= maxSymbols) break;
    }

    if (unique.length === 0) return;

    // Scan usages across the files we already inspected (best-effort).
    const files = inspectedFiles.slice(0, 120);
    notes.push(`Indexed ${unique.length} symbol(s) across ${files.length} file(s).`);

    const fileTextByPath = new Map<string, string>();
    for (const fp of files) {
        try {
            const uri = vscode.Uri.file(fp);
            const bytes = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(bytes).toString('utf8');
            fileTextByPath.set(fp, text);
        } catch {
            // ignore
        }
    }

    for (const sym of unique) {
        const key = `${sym.kind}:${sym.name}`;
        const uses: SymbolUse[] = [];
        const re = new RegExp(`\\\\b${escapeRegex(sym.name)}\\\\b`);

        for (const fp of files) {
            const text = fileTextByPath.get(fp);
            if (!text) continue;
            const rel = path.relative(rootPath, fp).replace(/\\/g, '/');
            const lines = text.replace(/\r\n/g, '\n').split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (fp === sym.filePath && i + 1 === sym.line) continue; // skip definition line
                if (!re.test(lines[i])) continue;
                uses.push({ filePath: fp, relPath: rel, line: i + 1 });
                if (uses.length >= maxUsesPerSymbol) break;
            }
            if (uses.length >= maxUsesPerSymbol) break;
        }

        outUses[key] = uses;
    }
}

function escapeRegex(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSymbolsNav(scan: WorkspaceScan, kind: ScanNodeKind): Record<string, string> {
    const nav: Record<string, string> = {};
    const rootId = kind === 'frontend' ? 'Frontend' : kind === 'backend' ? 'Backend' : kind === 'datastore' ? 'DataStore' : kind === 'external' ? 'External' : 'Other';
    nav['Objects: where defined and used'] = `objects_${kind}`;
    // allow clicking the section root to open a symbol view too
    nav[rootId] = `objects_${kind}`;
    return nav;
}

function buildOpenMapForDetails(scan: WorkspaceScan, kind: ScanNodeKind): Record<string, { filePath: string; line: number }> {
    const open: Record<string, { filePath: string; line: number }> = {};
    const details = scan.detailsByKind[kind] || [];
    const prefix =
        kind === 'frontend' ? 'UI:' :
        kind === 'backend' ? 'API:' :
        kind === 'datastore' ? 'DB:' :
        kind === 'external' ? 'EXT:' :
        '';
    for (const d of details) {
        if (!d.filePath || !d.relPath) continue;
        // Match on either the raw relPath or the prefixed label used in views.
        open[d.relPath] = { filePath: d.filePath, line: 1 };
        open[d.label] = { filePath: d.filePath, line: 1 };
        if (prefix) open[`${prefix} ${d.relPath}`] = { filePath: d.filePath, line: 1 };
    }
    return open;
}

function addSymbolsViews(
    views: Record<string, string>,
    navByViewId: Record<string, Record<string, string>>,
    openByViewId: Record<string, Record<string, { filePath: string; line: number }>>,
    scan: WorkspaceScan,
    sectionKind: ScanNodeKind,
    prefix: string
) {
    const viewId = `objects_${sectionKind}`;
    const lines: string[] = [];
    lines.push('flowchart TB');
    lines.push(`  Root[Objects in ${escapeMermaidLabel(sectionKind)}]`);

    const sectionFiles = new Set((scan.detailsByKind[sectionKind] || []).map((d) => d.filePath).filter(Boolean) as string[]);
    const sectionSymbols = scan.symbols
        .filter((s) => sectionFiles.size === 0 ? true : sectionFiles.has(s.filePath))
        .slice(0, 40);

    if (sectionSymbols.length === 0) {
        lines.push('  Root --> Empty[No objects detected]');
        views[viewId] = addClassStyling(lines.join('\n'));
        navByViewId[viewId] = {};
        openByViewId[viewId] = {};
        return;
    }

    const nav: Record<string, string> = {};
    const open: Record<string, { filePath: string; line: number }> = {};

    for (let i = 0; i < sectionSymbols.length; i++) {
        const s = sectionSymbols[i];
        const sid = toMermaidId(`Sym_${i + 1}_${hashString(`${s.kind}:${s.name}:${s.relPath}:${s.line}`)}`);
        const label = `${prefix} ${s.kind}: ${s.name}`;
        lines.push(`  ${sid}[${escapeMermaidLabel(label)}]`);
        lines.push(`  Root --> ${sid}`);
        nav[label] = `symbol_${hashString(`${s.kind}:${s.name}:${s.relPath}:${s.line}`)}`;

        // Also allow clicking the definition location label to open.
        const defLabel = `${s.relPath}:${s.line}`;
        open[defLabel] = { filePath: s.filePath, line: s.line };
    }

    views[viewId] = addClassStyling(lines.join('\n'));
    navByViewId[viewId] = nav;
    openByViewId[viewId] = open;

    // Individual symbol views with "defined in" and "used in" locations.
    for (const s of sectionSymbols) {
        const symKey = `${s.kind}:${s.name}`;
        const symViewId = `symbol_${hashString(`${s.kind}:${s.name}:${s.relPath}:${s.line}`)}`;
        const sv: string[] = [];
        sv.push('flowchart TB');
        sv.push(`  Sym[${escapeMermaidLabel(`${prefix} ${s.kind}: ${s.name}`)}]`);

        const defNode = toMermaidId(`Def_${hashString(`${s.relPath}:${s.line}`)}`);
        const defLabel = `Defined: ${s.relPath}:${s.line}`;
        sv.push(`  ${defNode}[${escapeMermaidLabel(defLabel)}]`);
        sv.push(`  Sym --> ${defNode}`);

        const uses = (scan.symbolUses[symKey] || []).slice(0, 8);
        if (uses.length === 0) {
            const noneId = toMermaidId(`NoUses_${hashString(symKey)}`);
            sv.push(`  ${noneId}[No usages indexed]`);
            sv.push(`  Sym --> ${noneId}`);
        } else {
            for (let i = 0; i < uses.length; i++) {
                const u = uses[i];
                const uid = toMermaidId(`Use_${i + 1}_${hashString(`${u.relPath}:${u.line}`)}`);
                const uLabel = `Used: ${u.relPath}:${u.line}`;
                sv.push(`  ${uid}[${escapeMermaidLabel(uLabel)}]`);
                sv.push(`  Sym --> ${uid}`);
            }
        }

        views[symViewId] = addClassStyling(sv.join('\n'));
        navByViewId[symViewId] = {};

        const openMap: Record<string, { filePath: string; line: number }> = {};
        openMap[defLabel] = { filePath: s.filePath, line: s.line };
        for (const u of uses) {
            const uLabel = `Used: ${u.relPath}:${u.line}`;
            openMap[uLabel] = { filePath: u.filePath, line: u.line };
        }
        openByViewId[symViewId] = openMap;
    }
}

function hashString(input: string): string {
    // Non-cryptographic stable hash for view ids.
    let h = 2166136261;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
}

function hasAny(hints: Set<string>, needles: string[]): boolean {
    for (const needle of needles) {
        if (hints.has(needle.toLowerCase())) return true;
    }
    return false;
}

function hasAnyEnv(keys: Set<string>, needles: string[]): boolean {
    for (const needle of needles) {
        if (keys.has(needle.toUpperCase())) return true;
    }
    return false;
}

async function readTextFile(uri: vscode.Uri): Promise<string | null> {
    try {
        return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
        return null;
    }
}

function parseRequirementsTxt(text: string): string[] {
    const out: string[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('-r') || line.startsWith('--')) continue;
        // Strip environment markers and versions (fastapi==0.1; python_version>="3.10")
        const cleaned = line.split(';')[0].trim();
        const name = cleaned.split(/[<=>~! \[]/)[0]?.trim();
        if (name) out.push(name.toLowerCase());
    }
    return out;
}

function parsePyprojectTomlDeps(text: string): string[] {
    // Heuristic: extract keys from [project] dependencies = ["a", "b"] and Poetry's [tool.poetry.dependencies].
    const out: string[] = [];

    // Poetry-style: lines like `requests = "^2.31.0"` under the deps section.
    let inPoetryDeps = false;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (/^\[tool\.poetry\.dependencies\]/.test(line)) {
            inPoetryDeps = true;
            continue;
        }
        if (/^\[/.test(line) && !/^\[tool\.poetry\.dependencies\]/.test(line)) {
            inPoetryDeps = false;
        }
        if (inPoetryDeps) {
            const m = line.match(/^([A-Za-z0-9_.-]+)\s*=/);
            if (m && m[1] && m[1].toLowerCase() !== 'python') out.push(m[1].toLowerCase());
        }
    }

    // PEP 621-style: dependencies = ["fastapi>=...", "streamlit"]
    const depBlock = text.match(/^\s*dependencies\s*=\s*\[(.|\n)*?\]\s*$/m);
    if (depBlock) {
        const inner = depBlock[0];
        for (const m of inner.matchAll(/"([^"]+)"/g)) {
            const name = m[1].split(/[<=>~! \[]/)[0]?.trim();
            if (name) out.push(name.toLowerCase());
        }
    }

    return out;
}

function parsePipfileDeps(text: string): string[] {
    const out: string[] = [];
    let inPackages = false;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (/^\[packages\]/i.test(line) || /^\[dev-packages\]/i.test(line)) {
            inPackages = true;
            continue;
        }
        if (/^\[/.test(line) && !/^\[packages\]/i.test(line) && !/^\[dev-packages\]/i.test(line)) {
            inPackages = false;
        }
        if (!inPackages) continue;
        const m = line.match(/^([A-Za-z0-9_.-]+)\s*=/);
        if (m && m[1]) out.push(m[1].toLowerCase());
    }
    return out;
}

function parseEnvironmentYmlDeps(text: string): string[] {
    const out: string[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        // Conda deps often: `- python=3.11` or pip: `- pip:` then pip list.
        const m = line.match(/^-+\s*([A-Za-z0-9_.-]+)(=|$)/);
        if (m && m[1]) out.push(m[1].toLowerCase());
    }
    return out;
}

function parseGoModDeps(text: string): string[] {
    const out: string[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('//')) continue;
        // `require github.com/gin-gonic/gin v1.9.0`
        const m = line.match(/^(require\s+)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s+v/);
        if (m && m[2]) out.push(m[2].toLowerCase());
    }
    return out;
}

function parseCargoTomlDeps(text: string): string[] {
    const out: string[] = [];
    let inDeps = false;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (/^\[dependencies\]/.test(line) || /^\[dev-dependencies\]/.test(line)) {
            inDeps = true;
            continue;
        }
        if (/^\[/.test(line) && !/^\[dependencies\]/.test(line) && !/^\[dev-dependencies\]/.test(line)) {
            inDeps = false;
        }
        if (!inDeps) continue;
        const m = line.match(/^([A-Za-z0-9_-]+)\s*=/);
        if (m && m[1]) out.push(m[1].toLowerCase());
    }
    return out;
}

function parsePomXmlDeps(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/g)) {
        if (m[1]) out.push(m[1].toLowerCase());
    }
    return out;
}

function parseGradleDeps(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(/['"]([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+):/g)) {
        // Keep artifactId as a hint.
        if (m[2]) out.push(m[2].toLowerCase());
        if (m[1] && m[1].toLowerCase().includes('springframework')) out.push('spring-boot');
    }
    return out;
}

function parseDotEnvKeys(text: string): string[] {
    const out: string[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (m && m[1]) out.push(m[1].toUpperCase());
    }
    return out;
}

function extractImportHints(text: string): string[] {
    const lower = text.toLowerCase();
    const out = new Set<string>();

    // Frameworks
    if (/\bstreamlit\b/.test(lower)) out.add('streamlit');
    if (/\bfastapi\b/.test(lower)) out.add('fastapi');
    if (/\bflask\b/.test(lower)) out.add('flask');
    if (/\bdjango\b/.test(lower)) out.add('django');
    if (/\bexpress\b/.test(lower)) out.add('express');
    if (/\bnext\b/.test(lower)) out.add('next');
    if (/\breact\b/.test(lower)) out.add('react');

    // Services
    if (/\bopenai\b/.test(lower)) out.add('openai');
    if (/\bsupabase\b/.test(lower)) out.add('supabase');
    if (/\bfirebase(_admin)?\b/.test(lower)) out.add('firebase_admin');

    // HTTP clients
    if (/\baxios\b/.test(lower)) out.add('axios');
    if (/\brequests\b/.test(lower)) out.add('requests');
    if (/\bhttpx\b/.test(lower)) out.add('httpx');

    // Datastores
    if (/\bmongodb\b|\bpymongo\b/.test(lower)) out.add('mongodb');
    if (/\bredis\b/.test(lower)) out.add('redis');
    if (/\bpostgres\b|\bpsycopg2\b|\basyncpg\b/.test(lower)) out.add('postgres');
    if (/\bsqlalchemy\b/.test(lower)) out.add('sqlalchemy');

    return Array.from(out);
}

function buildMermaidFromScan(scan: WorkspaceScan): string {
    const lines: string[] = [];
    lines.push('flowchart TD');

    const byKind = new Map<ScanNodeKind, ScanNode[]>();
    for (const n of scan.nodes) {
        const arr = byKind.get(n.kind) || [];
        arr.push(n);
        byKind.set(n.kind, arr);
    }

    const sections: Array<{ kind: ScanNodeKind; title: string }> = [
        { kind: 'frontend', title: 'Frontend' },
        { kind: 'backend', title: 'Backend/API' },
        { kind: 'service', title: 'Services' },
        { kind: 'datastore', title: 'Data Store' },
        { kind: 'external', title: 'External' },
        { kind: 'unknown', title: 'Other' },
    ];

    for (const sec of sections) {
        const secNodes = byKind.get(sec.kind) || [];
        if (secNodes.length === 0) continue;
        lines.push(`  subgraph ${toMermaidId(sec.title)}[${escapeMermaidLabel(sec.title)}]`);
        for (const n of secNodes) {
            lines.push(`    ${n.id}[${escapeMermaidLabel(n.label)}]`);
        }
        lines.push('  end');
    }

    for (const e of scan.edges) {
        const lbl = e.label ? `|${escapeMermaidLabel(e.label)}|` : '';
        lines.push(`  ${e.from} -->${lbl} ${e.to}`);
    }

    if (scan.notes.length) {
        lines.push('');
        for (const note of scan.notes) lines.push(`%% Note: ${note}`);
    }

    return lines.join('\n');
}

function buildPreviewFromScan(scan: WorkspaceScan): MermaidPreview {
    const views: Record<string, string> = {};
    const navByViewId: Record<string, Record<string, string>> = {};
    const openByViewId: MermaidPreview["openByViewId"] = {};

    // Overview: keep it intentionally high-level for readability, with drill-down navigation.
    const overviewNodes: Array<{ id: string; label: string }> = [
        // Avoid punctuation like parentheses/brackets which can trip Mermaid's parser in node labels.
        { id: 'Frontend', label: `Frontend: ${scan.detailsByKind.frontend.length}` },
        { id: 'Backend', label: `Backend API: ${scan.detailsByKind.backend.length}` },
        { id: 'DataStore', label: `Data Store: ${scan.detailsByKind.datastore.length}` },
        { id: 'External', label: `External: ${scan.detailsByKind.external.length}` },
    ];

    const hasFrontend = scan.nodes.some((n) => n.kind === 'frontend');
    const hasBackend = scan.nodes.some((n) => n.kind === 'backend');
    const hasDataStore = scan.nodes.some((n) => n.kind === 'datastore');
    const hasExternal = scan.nodes.some((n) => n.kind === 'external');

    const overviewLines: string[] = [];
    overviewLines.push('flowchart TD');
    for (const n of overviewNodes) {
        overviewLines.push(`  ${n.id}[${escapeMermaidLabel(n.label)}]`);
    }

    // Simple relations inferred from scan edges.
    if (hasFrontend && hasBackend) overviewLines.push('  Frontend -->|HTTP| Backend');
    if (hasBackend && hasDataStore) overviewLines.push('  Backend --> DataStore');
    if (hasBackend && hasExternal) overviewLines.push('  Backend --> External');

    // If no backend was detected, connect frontend directly to resources.
    if (!hasBackend && hasFrontend && hasDataStore) overviewLines.push('  Frontend --> DataStore');
    if (!hasBackend && hasFrontend && hasExternal) overviewLines.push('  Frontend --> External');

    // If we can't infer anything, at least show the scan found something.
    if (!hasFrontend && !hasBackend && !hasDataStore && !hasExternal) {
        overviewLines.push('  Other[Other]');
        overviewLines.push('  Other --> Frontend');
    }

    views.overview = addClassStyling(overviewLines.join('\n'));

    const nav: Record<string, string> = {};
    if (scan.detailsByKind.frontend.length) nav.Frontend = 'frontend';
    if (scan.detailsByKind.backend.length) nav.Backend = 'backend';
    if (scan.detailsByKind.datastore.length) nav.DataStore = 'datastore';
    if (scan.detailsByKind.external.length) nav.External = 'external';
    navByViewId.overview = nav;
    openByViewId.overview = {};

    // Drill-down views: show the concrete nodes found for each section.
    views.frontend = addClassStyling(buildSectionView(scan, 'frontend', 'Frontend', 'Frontend', 'UI:'));
    views.backend = addClassStyling(buildSectionView(scan, 'backend', 'Backend/API', 'Backend', 'API:'));
    views.datastore = addClassStyling(buildSectionView(scan, 'datastore', 'Data Store', 'DataStore', 'DB:'));
    views.external = addClassStyling(buildSectionView(scan, 'external', 'External', 'External', 'EXT:'));

    // No special navigation inside section views for now.
    navByViewId.frontend = buildSymbolsNav(scan, 'frontend');
    navByViewId.backend = buildSymbolsNav(scan, 'backend');
    navByViewId.datastore = buildSymbolsNav(scan, 'datastore');
    navByViewId.external = buildSymbolsNav(scan, 'external');

    openByViewId.frontend = buildOpenMapForDetails(scan, 'frontend');
    openByViewId.backend = buildOpenMapForDetails(scan, 'backend');
    openByViewId.datastore = buildOpenMapForDetails(scan, 'datastore');
    openByViewId.external = buildOpenMapForDetails(scan, 'external');

    // Symbols views per section (click "Objects" to navigate).
    addSymbolsViews(views, navByViewId, openByViewId, scan, 'frontend', 'UI');
    addSymbolsViews(views, navByViewId, openByViewId, scan, 'backend', 'API');
    addSymbolsViews(views, navByViewId, openByViewId, scan, 'datastore', 'DB');
    addSymbolsViews(views, navByViewId, openByViewId, scan, 'external', 'EXT');

    return { startViewId: 'overview', views, navByViewId, openByViewId };
}

function buildSectionView(scan: WorkspaceScan, kind: ScanNodeKind, title: string, rootId: string, labelPrefix: string): string {
    const lines: string[] = [];
    lines.push('flowchart TB');
    lines.push(`  ${rootId}[${escapeMermaidLabel(title)}]`);

    const details = scan.detailsByKind[kind] || [];
    if (details.length === 0) {
        lines.push(`  ${rootId} --> Empty[No ${escapeMermaidLabel(title)} items detected]`);
        return lines.join('\n');
    }

    // Add an "Objects" entrypoint for symbol-level drill-down.
    const objectsId = toMermaidId(`${rootId}_Objects`);
    lines.push(`  ${objectsId}[Objects: where defined and used]`);
    lines.push(`  ${rootId} --> ${objectsId}`);

    // Group by top-level directory to avoid one gigantic horizontal row.
    const groups = new Map<string, string[]>();
    for (const d of details) {
        const rel = d.label.replace(/\\/g, '/');
        const top = rel.includes('/') ? rel.split('/')[0] : '(root)';
        const list = groups.get(top) || [];
        list.push(rel);
        groups.set(top, list);
    }

    const groupNames = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
    const maxGroups = 10;
    const shownGroups = groupNames.slice(0, maxGroups);
    const hiddenGroups = groupNames.length - shownGroups.length;

    let groupIndex = 0;
    for (const groupName of shownGroups) {
        groupIndex++;
        const groupId = toMermaidId(`${rootId}_grp_${groupIndex}`);
        lines.push(`  ${rootId} --> ${groupId}`);
        lines.push(`  subgraph ${groupId}[${escapeMermaidLabel(groupName)}]`);
        lines.push('    direction TB');

        const items = (groups.get(groupName) || []).slice(0, 25);
        for (let i = 0; i < items.length; i++) {
            const id = toMermaidId(`${rootId}_${groupIndex}_${i + 1}`);
            const label = `${labelPrefix} ${items[i]}`.trim();
            lines.push(`    ${id}[${escapeMermaidLabel(label)}]`);
        }

        const extra = (groups.get(groupName) || []).length - items.length;
        if (extra > 0) {
            const moreId = toMermaidId(`${rootId}_${groupIndex}_more`);
            lines.push(`    ${moreId}[${escapeMermaidLabel(`${extra} more...`)}]`);
        }

        lines.push('  end');
    }

    if (hiddenGroups > 0) {
        const moreGroupsId = toMermaidId(`${rootId}_more_groups`);
        lines.push(`  ${rootId} --> ${moreGroupsId}[${escapeMermaidLabel(`${hiddenGroups} more groups...`)}]`);
    }

    return lines.join('\n');
}

function toMermaidId(input: string): string {
    const cleaned = input.replace(/[^A-Za-z0-9_]/g, '_');
    const safe = cleaned.length ? cleaned : 'Node';
    return /^[A-Za-z_]/.test(safe) ? safe : `N_${safe}`;
}

function prettyLabel(input: string): string {
    return input.replace(/[-_]+/g, ' ').trim() || input;
}

function escapeMermaidLabel(label: string): string {
    // Mermaid node labels are sensitive to some punctuation. Keep them simple and single-line.
    return label
        .replace(/\r?\n/g, ' ')
        .replace(/[\[\]\{\}]/g, ' ')
        .replace(/[<>`]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function addClassStyling(mermaidCode: string): string {
    // If the AI already provided styling, don't try to restyle it.
    if (/\bclassDef\b/.test(mermaidCode)) return mermaidCode;

    const lines = mermaidCode.replace(/\r\n/g, '\n').split('\n');
    const nodeLabelById = extractNodeLabels(lines);

    const buckets: Record<string, string[]> = {
        db: [],
        cache: [],
        service: [],
        frontend: [],
        external: [],
    };

    for (const [id, label] of nodeLabelById.entries()) {
        const category = categorizeNode(id, label);
        if (category) buckets[category].push(id);
    }

    const classLines: string[] = [];
    for (const [className, ids] of Object.entries(buckets)) {
        if (ids.length === 0) continue;
        classLines.push(`class ${ids.join(',')} ${className};`);
    }

    if (classLines.length === 0) return mermaidCode;

    const defs = [
        '',
        '%% Styling injected by @mapper',
        'classDef frontend fill:#dcfce7,stroke:#16a34a,stroke-width:1px,color:#052e16;',
        'classDef service fill:#ede9fe,stroke:#7c3aed,stroke-width:1px,color:#2e1065;',
        'classDef db fill:#e0f2fe,stroke:#0284c7,stroke-width:1px,color:#0c4a6e;',
        'classDef cache fill:#fef9c3,stroke:#ca8a04,stroke-width:1px,color:#713f12;',
        'classDef external fill:#ffe4e6,stroke:#e11d48,stroke-width:1px,color:#881337,stroke-dasharray: 4 3;',
        ...classLines,
    ];

    return `${mermaidCode.trim()}\n${defs.join('\n')}\n`;
}

function extractNodeLabels(lines: string[]): Map<string, string> {
    const map = new Map<string, string>();

    for (const line of lines) {
        // Match node definitions like:
        //   A[Label]
        //   B(Label)
        //   C{Label}
        //   D[(DB Label)]
        //   E((Circle))
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*(\[\(.*\)\]|\[\s*.*\s*\]|\(\s*.*\s*\)|\{\s*.*\s*\})/);
        if (!m) continue;
        const id = m[1];
        const raw = m[2];

        // Strip brackets/parens/braces and common Mermaid DB wrapper [(...)]
        const label = raw
            .replace(/^\[\(/, '')
            .replace(/\)\]$/, '')
            .replace(/^[\[\(\{]\s*/, '')
            .replace(/\s*[\]\)\}]$/, '')
            .trim();

        if (label) map.set(id, label);
    }

    return map;
}

function categorizeNode(id: string, label: string): 'db' | 'cache' | 'service' | 'frontend' | 'external' | null {
    const haystack = `${id} ${label}`.toLowerCase();

    // Database / persistent stores
    if (/\b(postgres|postgresql|mongo|mongodb|mysql|sqlite|dynamo|dynamodb|nosql|relational|database|db)\b/.test(haystack)) {
        return 'db';
    }

    // Cache / in-memory / session stores
    if (/\b(cache|redis|memcache|session|in-?memory)\b/.test(haystack)) {
        return 'cache';
    }

    // External services/providers
    if (/\b(external|provider|payment|stripe|razorpay|openai|supabase|firebase|cdn|vercel|render|twilio|sendgrid)\b/.test(haystack)) {
        return 'external';
    }

    // Frontend clients
    if (/\b(frontend|web|browser|mobile|ui|extension|client|next\.?js|react|streamlit)\b/.test(haystack)) {
        return 'frontend';
    }

    // Backend services (APIs, gateways, auth, etc.)
    if (/\b(service|api|gateway|auth|authentication|notification|sync|worker)\b/.test(haystack)) {
        return 'service';
    }

    return null;
}

// Replace your existing openMermaidPreview with this "Bulletproof" version
function openMermaidPreview(preview: MermaidPreview) {
    const panel = vscode.window.createWebviewPanel(
        'mermaidPreview', 'Architecture Map', vscode.ViewColumn.Two, { enableScripts: true }
    );

    const base64Payload = Buffer.from(JSON.stringify(preview)).toString('base64');
    const nonce = getNonce();

    panel.webview.onDidReceiveMessage(async (message) => {
        if (!message || typeof message !== 'object') return;
        if (message.type === 'open' && message.filePath) {
            try {
                const fileUri = vscode.Uri.file(String(message.filePath));
                const doc = await vscode.workspace.openTextDocument(fileUri);
                const line = Math.max(0, Number(message.line || 1) - 1);
                const pos = new vscode.Position(line, 0);
                await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) });
            } catch (err: any) {
                vscode.window.showErrorMessage(`@mapper: Could not open file: ${err?.message || String(err)}`);
            }
        }
    });

    panel.webview.html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net;">
            <style>
                body { background: #ffffff; margin: 0; padding: 0; overflow: hidden; height: 100vh; width: 100vw; font-family: sans-serif; }
                #controls { position: absolute; top: 10px; left: 10px; z-index: 100; background: white; padding: 10px; border: 1px solid #ccc; border-radius: 4px; display: flex; gap: 8px; align-items: center; }
                #backBtn { border: 1px solid #ccc; background: #f8fafc; padding: 6px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
                #backBtn[disabled] { opacity: 0.5; cursor: default; }
                #title { font-weight: 700; font-size: 12px; }
                #hint { font-size: 12px; color: #475569; }
                #diagram-container { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
                svg { width: 100% !important; height: 100% !important; }
                .clickable { cursor: pointer; }
            </style>
        </head>
        <body>
            <div id="controls">
                <button id="backBtn" disabled>Back</button>
                <div>
                    <div id="title">@mapper Visualizer</div>
                    <div id="hint">Click a section to expand. Scroll to Zoom. Drag to Pan.</div>
                </div>
            </div>
            <div id="diagram-container">
                <div id="status">⌛ Preparing Canvas...</div>
            </div>

            <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.1/dist/svg-pan-zoom.min.js"></script>
            <script nonce="${nonce}" type="module">
                const container = document.getElementById('diagram-container');
                const backBtn = document.getElementById('backBtn');
                const titleEl = document.getElementById('title');
                const hintEl = document.getElementById('hint');
                const vscode = acquireVsCodeApi();

                function showError(message) {
                    container.innerHTML = "<div style='color:red; padding:20px; max-width: 900px;'><b>Render Error:</b><br/>" + message + "</div>";
                }

                (async () => {
                    try {
                        // Dynamic import so we can surface module-load errors in the UI.
                        const mod = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs');
                        const mermaid = mod.default ?? mod;
                        mermaid.initialize({ startOnLoad: false, theme: 'neutral' });

                        const payload = JSON.parse(atob('${base64Payload}'));
                        const views = payload.views || {};
                        const navByViewId = payload.navByViewId || {};
                        const openByViewId = payload.openByViewId || {};
                        let currentViewId = payload.startViewId || 'overview';
                        const stack = [];
                        let panZoomInstance = null;

                        async function renderView(viewId, pushStack) {
                            const code = views[viewId];
                            if (!code) throw new Error("Missing Mermaid view: " + viewId);

                            if (pushStack) stack.push(currentViewId);
                            currentViewId = viewId;

                            backBtn.disabled = stack.length === 0;
                            titleEl.textContent = viewId === 'overview' ? '@mapper Visualizer' : ('@mapper: ' + viewId);

                            // Render fresh SVG.
                            const { svg } = await mermaid.render('mermaid-svg', code);
                            container.innerHTML = svg;

                            const svgElement = container.querySelector('svg');
                            const panZoom = window.svgPanZoom;
                            if (!svgElement) throw new Error("Mermaid rendered no SVG output.");
                            if (typeof panZoom !== 'function') throw new Error("svg-pan-zoom failed to load.");

                            // Reset pan/zoom instance per render.
                            try { panZoomInstance && panZoomInstance.destroy && panZoomInstance.destroy(); } catch {}
                            panZoomInstance = panZoom(svgElement, { zoomEnabled: true, controlIconsEnabled: true, fit: true, center: true });

                            // Wire navigation clicks for this view (based on visible node labels).
                            const nav = navByViewId[viewId] || {};
                            const openMap = openByViewId[viewId] || {};
                            const clickableCount = wireClickableNodes(svgElement, nav, openMap);
                            if (viewId === 'overview') {
                                hintEl.textContent = clickableCount > 0
                                    ? 'Click a section to expand. Scroll to Zoom. Drag to Pan.'
                                    : ('No clickable sections detected in this view. Detected nodes: ' + Array.from(svgElement.querySelectorAll('g.node, g[class*="node"]')).slice(0, 6).map((g) => (g.querySelector('title')?.textContent || g.id || '(no id)')).join(', '));
                            }
                        }

                        function readNodeLabel(nodeGroup) {
                            const texts = nodeGroup.querySelectorAll('text tspan, text');
                            let out = '';
                            texts.forEach((t) => {
                                const s = (t.textContent || '').trim();
                                if (s) out += (out ? ' ' : '') + s;
                            });
                            return out.trim();
                        }

                        function readNodeTitle(nodeGroup) {
                            const title = nodeGroup.querySelector('title');
                            return (title?.textContent || '').trim();
                        }

                        function normKey(input) {
                            return String(input || '')
                                .toLowerCase()
                                .replace(/[^a-z0-9]+/g, '');
                        }

                        function wireClickableNodes(svgElement, nav, openMap) {
                            const hasNav = nav && Object.keys(nav).length > 0;
                            const hasOpen = openMap && Object.keys(openMap).length > 0;
                            if (!hasNav && !hasOpen) return 0;

                            const normNav = {};
                            if (hasNav) {
                                Object.keys(nav).forEach((k) => {
                                    normNav[normKey(k)] = nav[k];
                                });
                            }

                            const normOpen = {};
                            if (hasOpen) {
                                Object.keys(openMap).forEach((k) => {
                                    normOpen[normKey(k)] = openMap[k];
                                });
                            }

                            let wired = 0;
                            const nodes = svgElement.querySelectorAll('g.node, g[class*="node"]');
                            nodes.forEach((g) => {
                                const label = readNodeLabel(g);
                                const title = readNodeTitle(g);

                                const candidates = [title, label, g.id || ''];
                                let target = null;
                                let openTarget = null;
                                for (const c of candidates) {
                                    const nk = normKey(c);

                                    const ot = normOpen[nk];
                                    if (ot) { openTarget = ot; break; }

                                    const t = normNav[nk];
                                    if (t) { target = t; break; }

                                    // Prefix match (e.g. "Frontend: 12" should match nav key "Frontend").
                                    for (const key of Object.keys(normOpen)) {
                                        if (key && nk.startsWith(key)) {
                                            openTarget = normOpen[key];
                                            break;
                                        }
                                    }

                                    if (!openTarget) {
                                        for (const key of Object.keys(normNav)) {
                                            if (key && nk.startsWith(key)) {
                                                target = normNav[key];
                                                break;
                                            }
                                        }
                                    }

                                    if (openTarget || target) break;
                                }

                                // Fallback: match by SVG group id containing the key (Mermaid often encodes ids like "flowchart-Frontend-0").
                                if (!openTarget && !target && g.id) {
                                    const nid = normKey(g.id);
                                    for (const key of Object.keys(normOpen)) {
                                        if (key && nid.includes(key)) { openTarget = normOpen[key]; break; }
                                    }
                                    if (!openTarget) {
                                        for (const key of Object.keys(normNav)) {
                                            if (key && nid.includes(key)) { target = normNav[key]; break; }
                                        }
                                    }
                                }
                                if (!openTarget && !target) return;

                                g.classList.add('clickable');
                                g.addEventListener('click', (e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    if (openTarget && openTarget.filePath) {
                                        vscode.postMessage({ type: 'open', filePath: openTarget.filePath, line: openTarget.line || 1 });
                                        return;
                                    }
                                    if (target) {
                                        renderView(target, true).catch((err) => showError(err.message || String(err)));
                                    }
                                });
                                wired++;
                            });

                            return wired;
                        }

                        backBtn.addEventListener('click', () => {
                            if (stack.length === 0) return;
                            const prev = stack.pop();
                            renderView(prev, false).catch((err) => showError(err.message || String(err)));
                        });

                        await renderView(currentViewId, false);
                    } catch (e) {
                        showError(e?.message || String(e));
                    }
                })();
            </script>
        </body>
        </html>
    `;
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

// --- ESSENTIAL HELPERS (Do not delete these!) ---

async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
    let apiKey = await context.secrets.get("GEMINI_API_KEY");
    if (!apiKey) {
        apiKey = await vscode.window.showInputBox({ prompt: "Enter Gemini API Key", password: true });
        if (apiKey) await context.secrets.store("GEMINI_API_KEY", apiKey);
    }
    return apiKey;
}

async function getFileTree(dir: string, depth = 0): Promise<string> {
    if (depth > 1) return ""; 
    try {
        const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
        let tree = "";
        for (const [name, type] of entries) {
            if (['node_modules', '.git', 'dist'].includes(name)) continue;
            tree += "${'  '.repeat(depth)}${name}\\n";
            if (type === vscode.FileType.Directory) tree += await getFileTree(path.join(dir, name), depth + 1);
        }
        return tree;
    } catch { return ""; }
}

export function deactivate() {}
