import * as vscode from 'vscode';
import * as path from 'path';
import { getCachedScan, setCachedScan, invalidateCache, initCacheWatcher } from './scanCache';
import { getSymbolsForFile, getReferencesForSymbol, getDefinitionLocation } from './symbolIndex';
import { detectFrameworkRegistrations, detectActiveFrameworks, FrameworkRegistration } from './frameworkDetectors';
import { buildModuleGraph, buildModuleGraphMermaid } from './moduleGraph';
import * as fs from 'fs';
import { execSync } from 'child_process';

// ─────────────────────────────────────────────────────────────────
// Scrum Goals Backend
// ─────────────────────────────────────────────────────────────────
export interface ScrumGoal {
    id: string;
    title: string;
    completed: boolean;
    completedBy?: string;
    commitHash?: string;
    createdAt: string;
}

export function getScrumGoals(rootPath: string): ScrumGoal[] {
    const scrumPath = path.join(rootPath, '.mapper', 'scrum.json');
    if (!fs.existsSync(scrumPath)) return [];
    try { return JSON.parse(fs.readFileSync(scrumPath, 'utf8')); } catch { return []; }
}

export function saveScrumGoals(rootPath: string, goals: ScrumGoal[]) {
    const mapperDir = path.join(rootPath, '.mapper');
    if (!fs.existsSync(mapperDir)) fs.mkdirSync(mapperDir, { recursive: true });
    fs.writeFileSync(path.join(mapperDir, 'scrum.json'), JSON.stringify(goals, null, 2), 'utf8');
}

export async function detectScrumCompletions(rootPath: string) {
    const goals = getScrumGoals(rootPath);
    const openGoals = goals.filter(g => !g.completed);
    if (openGoals.length === 0) return;

    let rawLog = '';
    try { rawLog = execSync('git log -n 30 --pretty=format:"%H|%an|%s" --date=short', { cwd: rootPath, encoding: 'utf8' }).trim(); } catch { return; }
    if (!rawLog) return;

    const commits = rawLog.split('\n').filter(Boolean).map(line => {
        const parts = line.split('|');
        return { hash: parts[0], author: parts[1], msg: parts.slice(2).join('|') };
    });

    try {
        const models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
        if (!models || models.length === 0) return;
        const model = models[0];

        const prompt = `You are a Scrum Master AI. Evaluate these Recent Commits against the Open Goals to see if any commits completely fulfill a goal.
Open Goals: ${JSON.stringify(openGoals)}
Recent Commits: ${JSON.stringify(commits)}

Return ONLY a valid JSON array mapping the goal ID to the commit Hash and Author that completed it. Example: [{"goalId":"123","commitHash":"abc1234","author":"John Doe"}]
If no commit strongly matches a goal, return []. Do not add any markdown formatting or text outside JSON.`;

        const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, new vscode.CancellationTokenSource().token);
        let responseText = '';
        for await (const chunk of response.text) responseText += chunk;
        const jsonStr = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        const matches = JSON.parse(jsonStr) as Array<{ goalId: string; commitHash: string; author: string }>;

        let updated = false;
        for (const match of matches) {
            const goal = goals.find(g => g.id === match.goalId);
            if (goal && !goal.completed) {
                goal.completed = true;
                goal.completedBy = match.author;
                goal.commitHash = match.commitHash;
                updated = true;
            }
        }
        if (updated) saveScrumGoals(rootPath, goals);
    } catch (e) {
        console.error("Scrum LLM mapping failed", e);
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('@mapper is now active!');

    // Initialize scan cache file watcher.
    context.subscriptions.push(initCacheWatcher());

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

            try {
                // Use cached scan if available, otherwise scan fresh.
                let scan = getCachedScan(rootPath);
                if (!scan) {
                    scan = await scanWorkspace(rootPath);
                    setCachedScan(rootPath, scan);
                }
                const preview = await buildPreviewFromScan(scan);
                openMermaidPreview(preview, rootPath);

            } catch (err: any) {
                response.markdown(`❌ **Scan Error:** ${err.message}`);
            }
            return;
        }

        if (request.command === 'trace') {
            const symbolName = (request.prompt || '').trim();
            if (!symbolName) {
                response.markdown('Usage: `@mapper /trace <symbolName>` — traces where a symbol is defined and referenced.');
                return;
            }
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) return;
            const rootPath = workspaceFolders[0].uri.fsPath;

            response.markdown(`🔍 Tracing **${symbolName}**...\n\n`);
            try {
                let scan = getCachedScan(rootPath);
                if (!scan) {
                    scan = await scanWorkspace(rootPath);
                    setCachedScan(rootPath, scan);
                }
                // Find symbol in scan results.
                const sym = scan.symbols.find((s: any) => s.name === symbolName);
                if (!sym) {
                    response.markdown(`⚠️ Symbol **${symbolName}** not found in the current scan. Run \`/draw\` first, then try again.`);
                    return;
                }
                const refs = await getReferencesForSymbol(rootPath, sym.filePath, sym.line, 0);
                response.markdown(`📌 **Defined in:** \`${sym.relPath}:${sym.line}\`\n\n`);
                if (refs.length === 0) {
                    response.markdown('No cross-file references found.');
                } else {
                    response.markdown(`**Referenced in ${refs.length} location(s):**\n`);
                    for (const r of refs) {
                        response.markdown(`- \`${r.relPath}:${r.line}\` ${r.note || ''}\n`);
                    }
                }
            } catch (err: any) {
                response.markdown(`❌ Error: ${err.message}`);
            }
            return;
        }

        if (request.command === 'path') {
            const routeQuery = (request.prompt || '').trim();
            if (!routeQuery) {
                response.markdown('Usage: `@mapper /path <route>` — traces a request from route decorator to handler to DB/external calls.\n\nExample: `@mapper /path /api/users`');
                return;
            }
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) return;
            const rootPath = workspaceFolders[0].uri.fsPath;

            response.markdown(`🛤️ Tracing request path for **${routeQuery}**...\n\n`);
            try {
                let scan = getCachedScan(rootPath);
                if (!scan) {
                    scan = await scanWorkspace(rootPath);
                    setCachedScan(rootPath, scan);
                }
                const regs: FrameworkRegistration[] = scan.frameworkRegistrations || [];
                const matching = regs.filter(r => r.kind === 'route' && r.name.toLowerCase().includes(routeQuery.toLowerCase()));
                if (matching.length === 0) {
                    response.markdown(`⚠️ No routes matching **${routeQuery}** found. Make sure the project has been scanned with \`/draw\` first.`);
                    return;
                }
                for (const route of matching) {
                    response.markdown(`### ${route.name}\n`);
                    response.markdown(`📍 **Defined in:** \`${route.relPath}:${route.line}\`\n`);
                    if (route.meta) response.markdown(`🏷️ Method: \`${route.meta}\`\n`);
                    // Try to trace deeper: find the handler function and its dependencies.
                    const refs = await getReferencesForSymbol(rootPath, route.filePath, route.line, 0);
                    if (refs.length > 0) {
                        response.markdown(`\n**Calls / References:**\n`);
                        for (const r of refs.slice(0, 10)) {
                            response.markdown(`- \`${r.relPath}:${r.line}\`\n`);
                        }
                    }
                    response.markdown('\n---\n');
                }
            } catch (err: any) {
                response.markdown(`❌ Error: ${err.message}`);
            }
            return;
        }

        if (request.command === 'config') {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) return;
            const rootPath = workspaceFolders[0].uri.fsPath;

            response.markdown('🔧 **Configuration Flow Analysis**\n\n');
            try {
                // Find .env files.
                const envUris = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(rootPath, '**/.env*'),
                    '**/node_modules/**',
                    10
                );
                if (envUris.length === 0) {
                    response.markdown('No `.env` files found in the workspace.');
                    return;
                }
                for (const uri of envUris) {
                    const rel = path.relative(rootPath, uri.fsPath).replace(/\\/g, '/');
                    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
                    const keys = parseDotEnvKeys(text);
                    response.markdown(`### ${rel}\n`);
                    response.markdown(`Found **${keys.length}** env key(s):\n`);
                    for (const k of keys.slice(0, 30)) {
                        response.markdown(`- \`${k}\`\n`);
                    }
                    response.markdown('\n');
                }
            } catch (err: any) {
                response.markdown(`❌ Error: ${err.message}`);
            }
            return;
        }

        if (request.command === 'export') {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) return;
            const rootPath = workspaceFolders[0].uri.fsPath;

            response.markdown('📄 **Generating `ARCHITECTURE.md`...**\n\n');
            try {
                let scan = getCachedScan(rootPath);
                if (!scan) {
                    scan = await scanWorkspace(rootPath);
                    setCachedScan(rootPath, scan);
                }

                const lines: string[] = [];
                const projectName = path.basename(rootPath);
                const now = new Date().toISOString().split('T')[0];
                lines.push(`# ${projectName} — Architecture Overview`);
                lines.push('');
                lines.push(`> Auto-generated by **@mapper** on ${now}`);
                lines.push('');

                // Overview diagram.
                lines.push('## Architecture Diagram');
                lines.push('');
                const mermaidCode = buildMermaidFromScan(scan);
                lines.push('```mermaid');
                lines.push(mermaidCode);
                lines.push('```');
                lines.push('');

                // File listing by section.
                lines.push('## Project Structure');
                lines.push('');
                lines.push('```text');
                const sectionNames: Record<string, string> = { frontend: 'Frontend', backend: 'Backend / API', datastore: 'Data Store', external: 'External' };
                for (const [kind, title] of Object.entries(sectionNames)) {
                    const files = scan.detailsByKind[kind as ScanNodeKind] || [];
                    if (files.length === 0) continue;
                    lines.push(`${title}`);
                    for (const f of files) {
                        lines.push(`  - ${f.relPath || f.label}`);
                    }
                    lines.push('');
                }
                lines.push('```');
                lines.push('');

                // Route table.
                const routes = (scan.frameworkRegistrations || []).filter((r: FrameworkRegistration) => r.kind === 'route' || r.kind === 'urlpattern');
                if (routes.length > 0) {
                    lines.push('## API Routes');
                    lines.push('');
                    lines.push('| Method | Path | Handler | File |');
                    lines.push('|--------|------|---------|------|');
                    for (const r of routes) {
                        const method = (r.meta || 'GET').toUpperCase();
                        const handler = r.handlerName || '—';
                        lines.push(`| \`${method}\` | \`${r.name}\` | \`${handler}\` | \`${r.relPath}:${r.line}\` |`);
                    }
                    lines.push('');
                }

                // Symbol summary.
                const totalSymbols = scan.symbols.length;
                const classes = scan.symbols.filter((s: any) => s.kind === 'class').length;
                const functions = scan.symbols.filter((s: any) => s.kind === 'function').length;
                lines.push('## Symbols');
                lines.push('');
                lines.push(`- **${totalSymbols}** total symbols`);
                lines.push(`- **${classes}** classes`);
                lines.push(`- **${functions}** functions`);
                lines.push('');

                // Dead code.
                const dead = findDeadCode(scan);
                if (dead.length > 0) {
                    lines.push('## Dead Code');
                    lines.push('');
                    lines.push(`Found **${dead.length}** unreferenced symbol(s):`);
                    lines.push('');
                    for (const d of dead.slice(0, 20)) {
                        lines.push(`- \`${d.kind}\` **${d.name}** in \`${d.relPath}:${d.line}\``);
                    }
                    if (dead.length > 20) lines.push(`- ...and ${dead.length - 20} more`);
                    lines.push('');
                }

                const content = lines.join('\n');
                const filePath = path.join(rootPath, 'ARCHITECTURE.md');
                const fileUri = vscode.Uri.file(filePath);
                await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
                const doc = await vscode.workspace.openTextDocument(fileUri);
                await vscode.window.showTextDocument(doc);
                response.markdown(`✅ **Created** \`ARCHITECTURE.md\` (${lines.length} lines)`);
            } catch (err: any) {
                response.markdown(`❌ Error: ${err.message}`);
            }
            return;
        }

        if (request.command === 'explain') {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                response.markdown('⚠️ No file is currently open. Open a file and try again.');
                return;
            }
            const filePath = editor.document.uri.fsPath;
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const rootPath = workspaceFolders?.[0]?.uri.fsPath || '';
            const relPath = rootPath ? path.relative(rootPath, filePath).replace(/\\/g, '/') : path.basename(filePath);
            const ext = path.extname(filePath).toLowerCase();
            const text = editor.document.getText();
            const lines = text.split('\n');

            response.markdown(`## 📄 File: \`${relPath}\`\n\n`);

            // Detect language & framework signals.
            const lower = text.toLowerCase();
            const roles: string[] = [];
            const details: string[] = [];

            if (ext === '.py') {
                const isFastAPI = /\bfrom\s+fastapi\b|\bimport\s+fastapi\b/.test(lower);
                const isFlask   = /\bfrom\s+flask\b|\bimport\s+flask\b/.test(lower);
                const isDjango  = /\bdjango\b/.test(lower);
                const isStreamlit = /\bimport\s+streamlit\b|\bfrom\s+streamlit\b|\bst\./.test(lower);

                if (isFastAPI)   roles.push('**FastAPI** backend/router');
                if (isFlask)     roles.push('**Flask** backend/router');
                if (isDjango)    roles.push('**Django** component');
                if (isStreamlit) roles.push('**Streamlit** UI page');
                if (roles.length === 0) roles.push('Python module');

                // Count routes / endpoints.
                const routeLines = lines.filter(l => /@\w+\.(get|post|put|delete|patch)\s*\(/i.test(l));
                if (routeLines.length > 0) {
                    details.push(`🛤️ **${routeLines.length} route(s) registered:**`);
                    for (const rl of routeLines.slice(0, 10)) {
                        const m = rl.match(/@(\w+)\.(get|post|put|delete|patch)\s*\(\s*["']([^"']+)/i);
                        if (m) details.push(`  - \`${m[2].toUpperCase()} ${m[3]}\``);
                    }
                }

                // Imports.
                const importLines = lines.filter(l => /^\s*(import|from)\s/.test(l)).slice(0, 15);
                if (importLines.length > 0) {
                    details.push(`📦 **Imports (${importLines.length}):**`);
                    for (const il of importLines) details.push(`  - \`${il.trim()}\``);
                }

                // Top-level symbols.
                const defs = lines.filter(l => /^\s*(def|class)\s+\w/.test(l)).slice(0, 20);
                if (defs.length > 0) {
                    details.push(`🔣 **Defines ${defs.length} symbol(s):**`);
                    for (const d of defs) {
                        const m = d.match(/^\s*(def|class)\s+(\w+)/);
                        if (m) details.push(`  - \`${m[1]} ${m[2]}\``);
                    }
                }

            } else if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
                const isReact  = /\bfrom\s+['"]react['"]/i.test(lower) || /\bimport\s+react\b/i.test(lower);
                const isNext   = /\bfrom\s+['"]next\b/i.test(lower) || /(^|\/)pages\//.test(relPath) || /(^|\/)app\//.test(relPath);
                const isExpress = /\brequire\s*\(\s*['"]express['"]\)|\bfrom\s+['"]express['"]/i.test(lower);
                const isFastify = /\brequire\s*\(\s*['"]fastify['"]\)|\bfrom\s+['"]fastify['"]/i.test(lower);
                const isNest   = /\bfrom\s+['"]@nestjs\b/i.test(lower);

                if (isNext)    roles.push('**Next.js** page/route');
                else if (isReact) roles.push('**React** component');
                if (isExpress) roles.push('**Express.js** router/server');
                if (isFastify) roles.push('**Fastify** router/server');
                if (isNest)    roles.push('**NestJS** module/controller');
                if (roles.length === 0) roles.push('TypeScript/JavaScript module');

                // Route registrations.
                const routeLines = lines.filter(l => /\.(get|post|put|delete|patch)\s*\(\s*['"`]/i.test(l));
                if (routeLines.length > 0) {
                    details.push(`🛤️ **${routeLines.length} route(s) registered:**`);
                    for (const rl of routeLines.slice(0, 10)) {
                        const m = rl.match(/\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)/i);
                        if (m) details.push(`  - \`${m[1].toUpperCase()} ${m[2]}\``);
                    }
                }

                // Imports.
                const importLines = lines.filter(l => /^\s*(import|const\s+\w+\s*=\s*require)/.test(l)).slice(0, 15);
                if (importLines.length > 0) {
                    details.push(`📦 **Imports (${importLines.length}):**`);
                    for (const il of importLines) details.push(`  - \`${il.trim()}\``);
                }

                // Exported symbols.
                const exportedLines = lines.filter(l => /^\s*export\s+(default\s+)?(function|class|const|async function)/.test(l)).slice(0, 20);
                if (exportedLines.length > 0) {
                    details.push(`🔣 **Exports ${exportedLines.length} symbol(s):**`);
                    for (const d of exportedLines) {
                        const m = d.match(/export\s+(?:default\s+)?(?:async\s+)?(function|class|const)\s+(\w+)/);
                        if (m) details.push(`  - \`${m[1]} ${m[2]}\``);
                    }
                }
            } else {
                roles.push(`\`${ext}\` file`);
            }

            // Check for DB patterns.
            const dbHints: string[] = [];
            if (/\b(sqlalchemy|create_engine|sessionmaker|declarative_base)\b/.test(lower)) dbHints.push('SQLAlchemy ORM');
            if (/\b(psycopg2|asyncpg)\b/.test(lower)) dbHints.push('PostgreSQL driver');
            if (/\b(pymongo|motor)\b/.test(lower)) dbHints.push('MongoDB driver');
            if (/\b(redis)\b/.test(lower)) dbHints.push('Redis client');
            if (/\b(mongoose|typeorm|prisma|sequelize)\b/.test(lower)) dbHints.push('DB ORM/client');
            if (dbHints.length > 0) details.push(`🗄️ **Database usage:** ${dbHints.join(', ')}`);

            // External API patterns.
            const extHints: string[] = [];
            if (/\bopenai\b/.test(lower)) extHints.push('OpenAI API');
            if (/\bsupabase\b/.test(lower)) extHints.push('Supabase');
            if (/\bfirebase\b/.test(lower)) extHints.push('Firebase');
            if (/\b(requests|httpx|aiohttp|axios)\b/.test(lower)) extHints.push('HTTP client calls');
            if (extHints.length > 0) details.push(`🌐 **External calls:** ${extHints.join(', ')}`);

            // TODOs in this file.
            const todos = lines.filter(l => /\b(TODO|FIXME|HACK|XXX)\b/.test(l));
            if (todos.length > 0) details.push(`⚠️ **${todos.length} TODO/FIXME comment(s) in this file**`);

            response.markdown(`**Role:** ${roles.join(', ')}\n\n`);
            response.markdown(`**Size:** ${lines.length} lines\n\n`);
            for (const d of details) response.markdown(d + '\n');

            if (details.length === 0) {
                response.markdown('_No specific framework signals detected. This appears to be a utility or configuration file._\n');
            }
            return;
        }

        if (request.command === 'summary') {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) {
                response.markdown('⚠️ No workspace folder open.');
                return;
            }
            const rootPath = workspaceFolders[0].uri.fsPath;
            response.markdown('📋 **Generating Daily Standup Summary...**\n\n');

            try {
                const { execSync } = require('child_process') as typeof import('child_process');

                // Get author email from git config.
                let authorEmail = '';
                try {
                    authorEmail = execSync('git config user.email', { cwd: rootPath, encoding: 'utf8' }).trim();
                } catch { /* no git config — will fetch all authors */ }

                // Fetch commits from the last 7 days.
                const sinceArg = '--since="7 days ago"';
                const authorArg = authorEmail ? `--author="${authorEmail}"` : '';
                const logCmd = `git log ${sinceArg} ${authorArg} --pretty=format:"%ad|%s|%H" --date=short`;

                let rawLog = '';
                try {
                    rawLog = execSync(logCmd, { cwd: rootPath, encoding: 'utf8' }).trim();
                } catch {
                    response.markdown('⚠️ Could not read git log. Make sure this is a git repository.');
                    return;
                }

                if (!rawLog) {
                    response.markdown('_No commits found in the last 7 days._\n');
                    return;
                }

                // Group commits by date.
                const byDate: Record<string, string[]> = {};
                for (const line of rawLog.split('\n')) {
                    const parts = line.split('|');
                    if (parts.length < 2) continue;
                    const date = parts[0].trim();
                    const subject = parts[1].trim();
                    if (!byDate[date]) byDate[date] = [];
                    byDate[date].push(subject);
                }

                const today = new Date().toISOString().split('T')[0];
                const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

                for (const [date, commits] of Object.entries(byDate).sort((a, b) => b[0].localeCompare(a[0]))) {
                    const label = date === today ? '🟢 Today' : date === yesterday ? '🟡 Yesterday' : `📅 ${date}`;
                    response.markdown(`### ${label}\n`);
                    for (const c of commits) response.markdown(`- ${c}\n`);
                    response.markdown('\n');
                }

                if (authorEmail) {
                    response.markdown(`\n_Showing commits by **${authorEmail}**. Use \`mapper.resetApiKey\` or switch git user to change._\n`);
                }
            } catch (err: any) {
                response.markdown(`❌ Error: ${err.message}`);
            }
            return;
        }

        if (request.command === 'audit') {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) { response.markdown('⚠️ No workspace folder open.'); return; }
            const rootPath = workspaceFolders[0].uri.fsPath;
            response.markdown('🔍 **Running Code Health Audit...**\n\n');

            try {
                let scan = getCachedScan(rootPath);
                if (!scan) {
                    scan = await scanWorkspace(rootPath);
                    setCachedScan(rootPath, scan);
                }

                // ── 1. Dead code (symbols with no recorded uses) ──
                const dead: SymbolDef[] = [];
                for (const sym of scan.symbols) {
                    const key = `${sym.kind}:${sym.name}:${sym.relPath}:${sym.line}`;
                    const uses = scan.symbolUses[key] || [];
                    if (uses.length === 0 && sym.kind !== 'variable') dead.push(sym);
                }

                // ── 2. TODO / FIXME / HACK scan ──
                const todoFiles = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(rootPath, '**/*.{py,ts,tsx,js,jsx,java,go,rs}'),
                    '**/{node_modules,dist,out,.next,build,coverage,.turbo,venv,.venv,__pycache__,.history,.git}/**',
                    300
                );
                let totalTodos = 0;
                const todoHotspots: Array<{ relPath: string; count: number }> = [];
                for (const uri of todoFiles.slice(0, 100)) {
                    const text = await readTextFile(uri);
                    if (!text) continue;
                    const count = (text.match(/\b(TODO|FIXME|HACK|XXX)\b/g) || []).length;
                    if (count > 0) {
                        totalTodos += count;
                        const rel = path.relative(rootPath, uri.fsPath).replace(/\\/g, '/');
                        todoHotspots.push({ relPath: rel, count });
                    }
                }
                todoHotspots.sort((a, b) => b.count - a.count);

                // ── 3. Large files ──
                const allSourceFiles = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(rootPath, '**/*.{py,ts,tsx,js,jsx,java,go,rs}'),
                    '**/{node_modules,dist,out,.next,build,coverage,.turbo,venv,.venv,__pycache__,.history,.git}/**',
                    300
                );
                const largeFiles: Array<{ relPath: string; lines: number }> = [];
                for (const uri of allSourceFiles.slice(0, 100)) {
                    const text = await readTextFile(uri);
                    if (!text) continue;
                    const lineCount = text.split('\n').length;
                    if (lineCount > 500) {
                        const rel = path.relative(rootPath, uri.fsPath).replace(/\\/g, '/');
                        largeFiles.push({ relPath: rel, lines: lineCount });
                    }
                }
                largeFiles.sort((a, b) => b.lines - a.lines);

                // ── 4. Missing env keys ──
                const envUris = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(rootPath, '**/.env*'),
                    '**/node_modules/**', 10
                );
                const definedKeys = new Set<string>();
                for (const uri of envUris) {
                    const text = await readTextFile(uri);
                    if (!text) continue;
                    for (const k of parseDotEnvKeys(text)) definedKeys.add(k);
                }
                const usedKeyMatches: string[] = [];
                for (const uri of allSourceFiles.slice(0, 80)) {
                    const text = await readTextFile(uri);
                    if (!text) continue;
                    const matches = text.match(/\bprocess\.env\.([A-Z_][A-Z0-9_]+)|\bos\.(?:environ|getenv)\s*[\[("']+([A-Z_][A-Z0-9_]+)/g) || [];
                    for (const m of matches) {
                        const key = (m.match(/([A-Z_][A-Z0-9_]+)$/) || [])[1];
                        if (key && !definedKeys.has(key)) usedKeyMatches.push(key);
                    }
                }
                const missingKeys = [...new Set(usedKeyMatches)];

                // ── Report ──
                const issueCount = dead.length + (totalTodos > 0 ? 1 : 0) + largeFiles.length + missingKeys.length;
                response.markdown(`### 📊 Health Summary — **${issueCount} issue type(s) found**\n\n`);

                // Dead code.
                if (dead.length > 0) {
                    response.markdown(`#### 🪦 Dead Code — ${dead.length} unreferenced symbol(s)\n`);
                    for (const d of dead.slice(0, 15)) {
                        response.markdown(`- \`${d.kind}\` **${d.name}** — \`${d.relPath}:${d.line}\`\n`);
                    }
                    if (dead.length > 15) response.markdown(`- _...and ${dead.length - 15} more_\n`);
                    response.markdown('\n');
                } else {
                    response.markdown('✅ **No dead code detected.**\n\n');
                }

                // TODOs.
                if (totalTodos > 0) {
                    response.markdown(`#### ⚠️ TODOs & FIXMEs — ${totalTodos} comment(s) in ${todoHotspots.length} file(s)\n`);
                    for (const h of todoHotspots.slice(0, 10)) {
                        response.markdown(`- \`${h.relPath}\` — **${h.count}** comment(s)\n`);
                    }
                    response.markdown('\n');
                } else {
                    response.markdown('✅ **No TODO/FIXME comments found.**\n\n');
                }

                // Large files.
                if (largeFiles.length > 0) {
                    response.markdown(`#### 📏 Large Files (>500 lines) — ${largeFiles.length} file(s)\n`);
                    for (const f of largeFiles.slice(0, 10)) {
                        response.markdown(`- \`${f.relPath}\` — **${f.lines}** lines\n`);
                    }
                    response.markdown('\n');
                } else {
                    response.markdown('✅ **No oversized files detected.**\n\n');
                }

                // Missing env keys.
                if (missingKeys.length > 0) {
                    response.markdown(`#### 🔑 Missing Env Keys — ${missingKeys.length} key(s) used in code but not in .env\n`);
                    for (const k of missingKeys.slice(0, 15)) response.markdown(`- \`${k}\`\n`);
                    response.markdown('\n');
                } else {
                    response.markdown('✅ **All env keys are defined.**\n\n');
                }

            } catch (err: any) {
                response.markdown(`❌ Error: ${err.message}`);
            }
            return;
        }

        if (request.command === 'glossary') {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) { response.markdown('⚠️ No workspace folder open.'); return; }
            const rootPath = workspaceFolders[0].uri.fsPath;
            response.markdown('📖 **Building Project Glossary...**\n\n');

            try {
                let scan = getCachedScan(rootPath);
                if (!scan) {
                    scan = await scanWorkspace(rootPath);
                    setCachedScan(rootPath, scan);
                }

                const symbols = scan.symbols;
                if (symbols.length === 0) {
                    response.markdown('_No symbols found. Try running `@mapper /draw` first to scan the workspace._\n');
                    return;
                }

                // Group symbols by file.
                const byFile = new Map<string, SymbolDef[]>();
                for (const sym of symbols) {
                    const existing = byFile.get(sym.relPath) || [];
                    existing.push(sym);
                    byFile.set(sym.relPath, existing);
                }

                const classes = symbols.filter((s: SymbolDef) => s.kind === 'class').length;
                const funcs = symbols.filter((s: SymbolDef) => s.kind === 'function').length;
                const vars = symbols.filter((s: SymbolDef) => s.kind === 'variable').length;

                response.markdown(`**${symbols.length} total symbols** across **${byFile.size} file(s)** — ${classes} classes · ${funcs} functions · ${vars} variables\n\n---\n\n`);

                for (const [relPath, syms] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
                    response.markdown(`### 📄 \`${relPath}\`\n`);

                    const groups: Record<string, SymbolDef[]> = { class: [], function: [], variable: [] };
                    for (const s of syms) groups[s.kind]?.push(s);

                    if (groups.class.length > 0) {
                        response.markdown(`**Classes:** `);
                        response.markdown(groups.class.map(s => `\`${s.name}\` (line ${s.line})`).join(' · ') + '\n');
                    }
                    if (groups.function.length > 0) {
                        response.markdown(`**Functions:** `);
                        response.markdown(groups.function.map(s => `\`${s.name}\` (line ${s.line})`).join(' · ') + '\n');
                    }
                    if (groups.variable.length > 0) {
                        response.markdown(`**Variables:** `);
                        response.markdown(groups.variable.map(s => `\`${s.name}\` (line ${s.line})`).join(' · ') + '\n');
                    }
                    response.markdown('\n');
                }

            } catch (err: any) {
                response.markdown(`❌ Error: ${err.message}`);
            }
            return;
        }

        response.markdown("👋 I am **@mapper**. Try `/draw`, `/trace <symbol>`, `/path <route>`, `/config`, `/export`, `/explain`, `/summary`, `/audit`, or `/glossary`!");
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
    decorators?: Array<{ line: number; text: string }>; // module-level decorators above def/class
}

interface SymbolUse {
    filePath: string; // absolute
    relPath: string;  // workspace-relative
    line: number;     // 1-based
    note?: string;
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
    symbolUses: Record<string, SymbolUse[]>; // key = stable symbol key
    frameworkRegistrations: FrameworkRegistration[];
}

interface MermaidPreview {
    startViewId: string;
    views: Record<string, string>;
    navByViewId: Record<string, Record<string, string>>;
    openByViewId: Record<string, Record<string, { filePath: string; line: number }>>;
    catalog: {
        files: Array<{ relPath: string; filePath: string; classCount: number; functionCount: number; variableCount: number }>;
        symbolsByFile: Record<string, Array<{ kind: SymbolKind; name: string; viewId: string; defFilePath: string; defLine: number; stableKey: string }>>;
    };
    dataFlowMeta?: Record<string, { filePath: string; handlerName: string; routeLabel: string; handlerLine: number }>;
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

        const scorePyPath = (relPath: string): number => {
            const r = relPath.toLowerCase();
            let score = 0;

            // Entrypoints and common app files.
            if (/(^|\/)(app|main|server|run|streamlit_app)\.py$/.test(r)) score += 60;
            if (r.endsWith('/app.py') || r.endsWith('/main.py')) score += 30;
            if (r === 'app.py' || r === 'main.py') score += 40;

            // High-signal folders for frameworks.
            if (/(^|\/)(api|routes|routers|router|controllers|backend|server)(\/|$)/.test(r)) score += 25;
            if (/(^|\/)(pages)(\/|$)/.test(r)) score += 15; // Streamlit multipage
            if (/(^|\/)(frontend|ui|views|templates|static)(\/|$)/.test(r)) score += 10;

            // Deprioritize noise.
            if (/(^|\/)tests?(\/|$)/.test(r)) score -= 30;
            if (r.endsWith('__init__.py')) score -= 10;
            if (r.startsWith('.history/')) score -= 100;

            return score;
        };

        const pyUrisSorted = pyUris
            .slice()
            .sort((a, b) => {
                const ar = path.relative(rootPath, a.fsPath).replace(/\\/g, '/');
                const br = path.relative(rootPath, b.fsPath).replace(/\\/g, '/');
                return scorePyPath(br) - scorePyPath(ar);
            });

        // Cap reads to keep scanning quick.
        const maxFilesToRead = Math.min(pyUrisSorted.length, 120);
        for (let i = 0; i < maxFilesToRead; i++) {
            const uri = pyUrisSorted[i];
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

        notes.push(`Python file scan: ${Math.min(pyUris.length, 250)} file(s) discovered; ${Math.min(pyUrisSorted.length, 120)} inspected.`);
    }

    // TypeScript / JavaScript file scanning (analogous to the Python scan above).
    {
        const tsJsUris = await vscode.workspace.findFiles(
            new vscode.RelativePattern(rootPath, '**/*.{ts,tsx,js,jsx}'),
            '**/{node_modules,dist,out,.next,build,coverage,.turbo,.history,.git}/**',
            250
        );

        const scoreTsJsPath = (relPath: string): number => {
            const r = relPath.toLowerCase();
            let score = 0;
            if (/(^|\/)(?:app|main|server|index)\.(ts|tsx|js|jsx)$/.test(r)) score += 60;
            if (/(^|\/)(api|routes|routers|router|controllers|backend|server|src)(\/|$)/.test(r)) score += 25;
            if (/(^|\/)(pages|components|frontend|ui|views)(\/|$)/.test(r)) score += 15;
            if (/(^|\/)tests?(\/|$)/.test(r)) score -= 30;
            if (/\.test\.(ts|tsx|js|jsx)$/.test(r)) score -= 40;
            if (/\.spec\.(ts|tsx|js|jsx)$/.test(r)) score -= 40;
            if (/\.d\.ts$/.test(r)) score -= 20;
            if (r.startsWith('.history/')) score -= 100;
            return score;
        };

        const tsSorted = tsJsUris
            .slice()
            .sort((a, b) => {
                const ar = path.relative(rootPath, a.fsPath).replace(/\\\\/g, '/');
                const br = path.relative(rootPath, b.fsPath).replace(/\\\\/g, '/');
                return scoreTsJsPath(br) - scoreTsJsPath(ar);
            });

        const maxTsFiles = Math.min(tsSorted.length, 120);
        for (let i = 0; i < maxTsFiles; i++) {
            const uri = tsSorted[i];
            const rel = path.relative(rootPath, uri.fsPath).replace(/\\\\/g, '/');
            if (rel.startsWith('.history/') || rel.startsWith('.git/')) continue;
            if (inspectedSourceFiles.has(uri.fsPath)) continue;
            const text = await readTextFile(uri);
            inspectedSourceFiles.add(uri.fsPath);
            const lower = (text || '').toLowerCase();

            const isReactFile = /\bfrom\s+['"]react['"]/i.test(lower) || /\bimport\s+react\b/i.test(lower) || /\bjsx\b/.test(lower);
            const isNextFile = /\bfrom\s+['"]next\b/i.test(lower) || /(^|\/)pages\//.test(rel) || /(^|\/)app\//.test(rel);
            const isExpressFile = /\bfrom\s+['"]express['"]/i.test(lower) || /\brequire\s*\(\s*['"]express['"]/.test(lower);
            const isFastifyFile = /\bfrom\s+['"]fastify['"]/i.test(lower) || /\brequire\s*\(\s*['"]fastify['"]/.test(lower);
            const isNestFile = /\bfrom\s+['"]@nestjs\b/i.test(lower);

            const usesDb = /\bmongoose\b|\bmongodb\b|\bprisma\b|\btypeorm\b|\bsequelize\b|\bknex\b|\bpg\b/.test(lower);
            const usesExternal = /\bopenai\b|\bsupabase\b|\bfirebase\b|\bstripe\b|\baxios\b/.test(lower);

            if (isReactFile || isNextFile) {
                detailsByKind.frontend.push({ label: rel, relPath: rel, filePath: uri.fsPath });
                collectTsJsSymbols(rootPath, uri.fsPath, rel, text || '', symbols);
                continue;
            }

            if (isExpressFile || isFastifyFile || isNestFile) {
                detailsByKind.backend.push({ label: rel, relPath: rel, filePath: uri.fsPath });
                collectTsJsSymbols(rootPath, uri.fsPath, rel, text || '', symbols);
                continue;
            }

            if (usesDb) {
                detailsByKind.datastore.push({ label: rel, relPath: rel, filePath: uri.fsPath });
                collectTsJsSymbols(rootPath, uri.fsPath, rel, text || '', symbols);
                continue;
            }

            if (usesExternal) {
                detailsByKind.external.push({ label: rel, relPath: rel, filePath: uri.fsPath });
                collectTsJsSymbols(rootPath, uri.fsPath, rel, text || '', symbols);
                continue;
            }

            // Heuristic by folder name.
            if (/(^|\/)(api|routes|router|controllers|server)(\/|$)/.test(rel)) {
                detailsByKind.backend.push({ label: rel, relPath: rel, filePath: uri.fsPath });
            } else if (/(^|\/)(components|pages|ui|views|frontend)(\/|$)/.test(rel)) {
                detailsByKind.frontend.push({ label: rel, relPath: rel, filePath: uri.fsPath });
            } else {
                detailsByKind.unknown.push({ label: rel, relPath: rel, filePath: uri.fsPath });
            }
            collectTsJsSymbols(rootPath, uri.fsPath, rel, text || '', symbols);
        }

        if (tsSorted.length > 0) {
            notes.push(`TS/JS file scan: ${Math.min(tsJsUris.length, 250)} file(s) discovered; ${maxTsFiles} inspected.`);
        }
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

    // Detect transport protocol for frontend->backend edges.
    const hasGraphQL = hasAny(depHints, ['graphql', 'apollo-server', '@apollo/client', 'graphene', 'ariadne', 'strawberry']);
    const hasGRPC = hasAny(depHints, ['grpc', '@grpc/grpc-js', 'grpcio']);
    const transportLabel = hasGraphQL ? 'GraphQL' : hasGRPC ? 'gRPC' : hasHttpClient ? 'REST / HTTP' : 'API calls';

    // Frontends -> backend edges.
    if (effectiveBackendId) {
        for (const n of nodes) {
            if (n.id === effectiveBackendId) continue;
            if (n.kind === 'frontend') {
                edges.push({ from: n.id, to: effectiveBackendId, label: transportLabel });
            }
        }
    }

    // Build specific edge labels for datastores/external services.
    const datastoreEdgeLabels: Record<string, string> = {};
    if (hasMongo) datastoreEdgeLabels['MongoDB'] = hasAny(depHints, ['mongoose']) ? 'mongoose' : hasAny(depHints, ['pymongo']) ? 'pymongo' : 'driver';
    if (hasPostgres) datastoreEdgeLabels['Postgres'] = hasAny(depHints, ['sqlalchemy']) ? 'SQLAlchemy' : hasAny(depHints, ['psycopg2', 'psycopg']) ? 'psycopg' : hasAny(depHints, ['asyncpg']) ? 'asyncpg' : 'pg driver';
    if (hasRedis) datastoreEdgeLabels['Redis'] = hasAny(depHints, ['ioredis']) ? 'ioredis' : 'redis client';
    if (hasSupabase) datastoreEdgeLabels['Supabase'] = 'supabase-js';
    if (hasFirebase) datastoreEdgeLabels['Firebase'] = 'firebase-admin';
    if (hasOpenAI) datastoreEdgeLabels['OpenAI'] = 'openai SDK';

    // Backend -> datastores/external edges.
    if (effectiveBackendId) {
        for (const n of nodes) {
            if (n.id === effectiveBackendId) continue;
            if (n.kind === 'datastore' || n.kind === 'external') {
                const edgeLabel = datastoreEdgeLabels[n.id] || undefined;
                edges.push({ from: effectiveBackendId, to: n.id, label: edgeLabel });
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
                    const edgeLabel = datastoreEdgeLabels[n.id] || undefined;
                    edges.push({ from: appNodeId, to: n.id, label: edgeLabel });
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

    // Symbol tracing is handled lazily via VS Code's reference provider in the webview.

    // Framework-specific registration detection.
    const activeFrameworks = detectActiveFrameworks(depHints);
    let frameworkRegistrations: FrameworkRegistration[] = [];
    if (activeFrameworks.size > 0) {
        // Collect all scanned source file URIs for framework detection.
        const allSourceUris = await vscode.workspace.findFiles(
            new vscode.RelativePattern(rootPath, '**/*.{py,ts,tsx,js,jsx}'),
            '**/{node_modules,dist,out,.next,build,coverage,.turbo,venv,.venv,__pycache__,.history,.git}/**',
            300
        );
        frameworkRegistrations = await detectFrameworkRegistrations(rootPath, allSourceUris, activeFrameworks);
        notes.push(`Framework detection found ${frameworkRegistrations.length} registrations across ${activeFrameworks.size} framework(s): ${Array.from(activeFrameworks).join(', ')}.`);
    }

    return { nodes, edges, notes, detailsByKind, symbols, symbolUses, frameworkRegistrations };
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

    const collectDecoratorsAbove = (defLineIdx: number): Array<{ line: number; text: string }> => {
        // Collect contiguous top-level decorators immediately above the def/class line.
        // We stop at the first blank line or non-decorator (comments are skipped).
        const decorators: Array<{ line: number; text: string }> = [];
        for (let j = defLineIdx - 1; j >= 0; j--) {
            const raw = lines[j] ?? '';
            const trimmed = raw.trim();
            if (!trimmed) break;
            if (trimmed.startsWith('#')) continue;
            if (/^\s+/.test(raw)) break; // nested / indented
            const m = raw.match(/^\s*@\s*(.+)\s*$/);
            if (!m) break;
            decorators.push({ line: j + 1, text: `@${m[1].trim()}` });
        }
        decorators.reverse();
        return decorators;
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        if (/^\s+/.test(line)) continue; // skip indented (nested) for now
        if (/^\s*#/.test(line)) continue;

        const defMatch = line.match(/^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
        if (defMatch) {
            const decorators = collectDecoratorsAbove(i);
            out.push({ name: defMatch[1], kind: 'function', filePath, relPath, line: i + 1, decorators: decorators.length ? decorators : undefined });
            added++;
            if (added >= maxSymbolsPerFile) return;
            continue;
        }

        const classMatch = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\(|:)/);
        if (classMatch) {
            const decorators = collectDecoratorsAbove(i);
            out.push({ name: classMatch[1], kind: 'class', filePath, relPath, line: i + 1, decorators: decorators.length ? decorators : undefined });
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

function collectTsJsSymbols(rootPath: string, filePath: string, relPath: string, text: string, out: SymbolDef[]) {
    // Lightweight TypeScript / JavaScript symbol extraction (top-level exports, functions, classes, constants).
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const maxSymbolsPerFile = 30;
    let added = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        if (/^\s+/.test(line) && !/^\s*(export\s+)/.test(line)) continue; // skip deeply indented unless export
        if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue; // skip comments

        // export function foo(... / export default function foo(... / function foo(...
        const funcMatch = line.match(/^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[\(<]/);
        if (funcMatch) {
            out.push({ name: funcMatch[1], kind: 'function', filePath, relPath, line: i + 1 });
            added++;
            if (added >= maxSymbolsPerFile) return;
            continue;
        }

        // Arrow functions: export const foo = (...) => / export const foo = async (...) =>
        const arrowMatch = line.match(/^(?:export\s+(?:default\s+)?)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/);
        if (arrowMatch) {
            out.push({ name: arrowMatch[1], kind: 'function', filePath, relPath, line: i + 1 });
            added++;
            if (added >= maxSymbolsPerFile) return;
            continue;
        }

        // export class Foo / class Foo
        const classMatch = line.match(/^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+|{|<)/);
        if (classMatch) {
            out.push({ name: classMatch[1], kind: 'class', filePath, relPath, line: i + 1 });
            added++;
            if (added >= maxSymbolsPerFile) return;
            continue;
        }

        // export interface Foo / interface Foo (treat as class for diagram purposes)
        const ifaceMatch = line.match(/^(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+|{|<)/);
        if (ifaceMatch) {
            out.push({ name: ifaceMatch[1], kind: 'class', filePath, relPath, line: i + 1 });
            added++;
            if (added >= maxSymbolsPerFile) return;
            continue;
        }

        // export type Foo = ... (treat as class for diagram purposes)
        const typeMatch = line.match(/^(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[=<]/);
        if (typeMatch) {
            out.push({ name: typeMatch[1], kind: 'class', filePath, relPath, line: i + 1 });
            added++;
            if (added >= maxSymbolsPerFile) return;
            continue;
        }

        // export const UPPER_CASE = ... (likely config/constants)
        const constMatch = line.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Z0-9_]{2,})\s*=/);
        if (constMatch) {
            out.push({ name: constMatch[1], kind: 'variable', filePath, relPath, line: i + 1 });
            added++;
            if (added >= maxSymbolsPerFile) return;
            continue;
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

    const stableKeyFor = (s: SymbolDef): string => `${s.kind}:${s.name}:${s.relPath}:${s.line}`;

    const unique: SymbolDef[] = [];
    const seen = new Set<string>();

    for (const s of symbols) {
        if (!s.name || s.name.length < 3) continue;
        const key = stableKeyFor(s);
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
        const key = stableKeyFor(sym);
        const uses: SymbolUse[] = [];
        const re = new RegExp(`\\\\b${escapeRegex(sym.name)}\\\\b`);

        const pushUse = (u: SymbolUse) => {
            if (uses.some((x) => x.filePath === u.filePath && x.line === u.line)) return;
            uses.push(u);
        };

        // Framework "implicit usage" patterns where a function is registered but never referenced by name.
        // Example: FastAPI/Flask route handlers via decorators, Streamlit cached functions via decorators.
        if (sym.decorators && sym.decorators.length) {
            for (const d of sym.decorators) {
                const t = (d.text || '').toLowerCase();
                let note: string | undefined;
                if (/\.(get|post|put|delete|patch|options|head|trace|route|websocket)\b/.test(t) && /@[\w.]+\./.test(t)) {
                    note = 'Route decorator';
                } else if (/\.(middleware|exception_handler|on_event)\b/.test(t) && /@[\w.]+\./.test(t)) {
                    note = 'Framework hook';
                } else if (/\bst\.(cache_data|cache_resource|cache|experimental_memo|experimental_singleton|fragment|dialog)\b/.test(t)) {
                    note = 'Streamlit decorator';
                }
                if (note) {
                    pushUse({ filePath: sym.filePath, relPath: sym.relPath, line: d.line, note });
                }
            }
        }

        for (const fp of files) {
            const text = fileTextByPath.get(fp);
            if (!text) continue;
            const rel = path.relative(rootPath, fp).replace(/\\/g, '/');
            const lines = text.replace(/\r\n/g, '\n').split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (fp === sym.filePath && i + 1 === sym.line) continue; // skip definition line
                if (!re.test(lines[i])) continue;

                const raw = lines[i] || '';
                const lower = raw.toLowerCase();
                let note: string | undefined;

                // Common FastAPI patterns.
                if (/\bdepends\s*\(\s*/.test(lower)) note = 'FastAPI Depends';
                if (/\badd_api_route\s*\(/.test(lower)) note = 'FastAPI add_api_route';

                // Common Streamlit callback patterns.
                if (/\bon_(click|change)\s*=\s*/.test(lower)) note = 'Streamlit callback';
                if (/\bst\.(button|checkbox|radio|selectbox|multiselect|slider|text_input|text_area|number_input|date_input|time_input|file_uploader|form_submit_button)\s*\(/.test(lower) &&
                    /\bon_(click|change)\s*=/.test(lower)) {
                    note = 'Streamlit callback';
                }

                pushUse({ filePath: fp, relPath: rel, line: i + 1, note });
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
    lines.push(`  Root[🔍 Symbols in ${escapeMermaidLabel(sectionKind)}]`);

    const sectionFiles = new Set((scan.detailsByKind[sectionKind] || []).map((d) => d.filePath).filter(Boolean) as string[]);
    const sectionSymbols = scan.symbols
        .filter((s) => sectionFiles.size === 0 ? true : sectionFiles.has(s.filePath))
        .sort((a, b) => {
            const kindOrder = (k: SymbolKind) => (k === 'class' ? 0 : k === 'function' ? 1 : 2);
            const ko = kindOrder(a.kind) - kindOrder(b.kind);
            if (ko !== 0) return ko;
            return a.name.localeCompare(b.name);
        })
        .slice(0, 40);

    if (sectionSymbols.length === 0) {
        lines.push('  Root --> Empty[No symbols detected]');
        views[viewId] = addClassStyling(lines.join('\n'));
        navByViewId[viewId] = {};
        openByViewId[viewId] = {};
        return;
    }

    const nav: Record<string, string> = {};
    const open: Record<string, { filePath: string; line: number }> = {};

    // Group symbols by file for organized display.
    const byFile = new Map<string, SymbolDef[]>();
    for (const s of sectionSymbols) {
        const arr = byFile.get(s.relPath) || [];
        arr.push(s);
        byFile.set(s.relPath, arr);
    }

    const files = Array.from(byFile.keys()).sort((a, b) => a.localeCompare(b)).slice(0, 12);

    let fileIdx = 0;
    for (const relPath of files) {
        fileIdx++;
        const defs = byFile.get(relPath) || [];
        const fileName = relPath.includes('/') ? relPath.split('/').pop() || relPath : relPath;
        const fileSubgraphId = toMermaidId(`ObjFile_${fileIdx}`);

        lines.push(`  subgraph ${fileSubgraphId}[📄 ${escapeMermaidLabel(fileName)}]`);
        lines.push('    direction TB');

        const shownDefs = defs.slice(0, 10);
        const symNodeIds: string[] = [];
        for (let i = 0; i < shownDefs.length; i++) {
            const s = shownDefs[i];
            const icon = s.kind === 'class' ? '🏷️' : s.kind === 'function' ? '⚡' : '📦';
            const nodeId = toMermaidId(`Obj_${fileIdx}_${i + 1}`);
            symNodeIds.push(nodeId);
            lines.push(`    ${nodeId}[${escapeMermaidLabel(`${icon} ${s.name}`)}]`);

            // Make each symbol clickable to trace.
            const fileViewId = `file_${hashString(`${sectionKind}:${relPath}`)}`;
            nav[`${icon} ${s.name}`] = fileViewId;
            open[`${icon} ${s.name}`] = { filePath: s.filePath, line: s.line };
        }

        // Chain symbols vertically.
        for (let i = 0; i < symNodeIds.length - 1; i++) {
            lines.push(`    ${symNodeIds[i]} --> ${symNodeIds[i + 1]}`);
        }

        if (defs.length > shownDefs.length) {
            const moreId = toMermaidId(`ObjMore_${fileIdx}`);
            lines.push(`    ${moreId}[+${defs.length - shownDefs.length} more]`);
            lines.push(`    style ${moreId} fill:none,stroke:none,color:#64748b,font-size:11px`);
        }

        lines.push('  end');
        lines.push(`  Root --> ${fileSubgraphId}`);

        // Build per-file view.
        const fileViewId = `file_${hashString(`${sectionKind}:${relPath}`)}`;
        buildFileSymbolsView(views, navByViewId, openByViewId, scan, sectionKind, prefix, relPath, defs, fileViewId);
    }

    if (byFile.size > files.length) {
        const moreFilesId = toMermaidId(`ObjMoreFiles`);
        lines.push(`  ${moreFilesId}[+${byFile.size - files.length} more files]`);
        lines.push(`  Root --> ${moreFilesId}`);
        lines.push(`  style ${moreFilesId} fill:none,stroke:none,color:#64748b,font-size:11px`);
    }

    views[viewId] = addClassStyling(lines.join('\n'));
    navByViewId[viewId] = nav;
    openByViewId[viewId] = open;

    // Symbol trace views are lazy-loaded using VS Code's reference provider.
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

function isLikelyPublicVariable(name: string, relPath: string): boolean {
    if (!name) return false;
    if (/^[A-Z][A-Z0-9_]*$/.test(name)) return true;
    const r = (relPath || '').toLowerCase();
    if (/(^|\/)(config|settings|constants|consts|env|secrets)(\/|$)/.test(r)) return true;
    if (/(config|settings|constants|consts|env|secrets)/.test(r)) return true;
    return false;
}

function toSymbolKindFromVscodeKind(k: vscode.SymbolKind): SymbolKind | null {
    if (k === vscode.SymbolKind.Class) return 'class';
    if (k === vscode.SymbolKind.Function || k === vscode.SymbolKind.Method || k === vscode.SymbolKind.Constructor) return 'function';
    if (
        k === vscode.SymbolKind.Variable ||
        k === vscode.SymbolKind.Constant ||
        k === vscode.SymbolKind.Property ||
        k === vscode.SymbolKind.Field
    ) return 'variable';
    return null;
}

async function getTopLevelSymbolsForFile(rootPath: string, filePath: string): Promise<Array<{
    kind: SymbolKind;
    name: string;
    stableKey: string;
    viewId: string;
    defFilePath: string;
    defLine: number;
    defChar: number;
}>> {
    const uri = vscode.Uri.file(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);

    const provided = await vscode.commands.executeCommand<any>('vscode.executeDocumentSymbolProvider', uri);
    const relPath = path.relative(rootPath, filePath).replace(/\\/g, '/');

    const out: Array<{
        kind: SymbolKind;
        name: string;
        stableKey: string;
        viewId: string;
        defFilePath: string;
        defLine: number;
        defChar: number;
    }> = [];

    const pushItem = (kind: SymbolKind, name: string, line: number, ch: number) => {
        if (!name) return;
        if (kind === 'variable' && !isLikelyPublicVariable(name, relPath)) return;
        if ((kind === 'function' || kind === 'class') && name.startsWith('_')) return;
        const stableKey = `${kind}:${name}:${relPath}:${line}`;
        out.push({
            kind,
            name,
            stableKey,
            viewId: `symbol_${hashString(stableKey)}`,
            defFilePath: filePath,
            defLine: line,
            defChar: ch,
        });
    };

    if (Array.isArray(provided) && provided.length && provided[0] && typeof provided[0] === 'object' && 'range' in provided[0]) {
        const list = provided as vscode.DocumentSymbol[];
        for (const s of list) {
            const kind = toSymbolKindFromVscodeKind(s.kind);
            if (!kind) continue;
            const line = (s.selectionRange?.start?.line ?? s.range.start.line) + 1;
            const ch = (s.selectionRange?.start?.character ?? s.range.start.character) || 0;
            pushItem(kind, s.name, line, ch);
        }
        return out.slice(0, 220);
    }

    if (Array.isArray(provided)) {
        const list = provided as Array<{ name: string; kind: vscode.SymbolKind; location: vscode.Location }>;
        for (const s of list) {
            const kind = toSymbolKindFromVscodeKind(s.kind);
            if (!kind) continue;
            const line = (s.location?.range?.start?.line ?? 0) + 1;
            const ch = (s.location?.range?.start?.character ?? 0);
            pushItem(kind, s.name, line, ch);
        }
        return out.slice(0, 220);
    }

    // Heuristic fallback for repos without symbol providers.
    const text = doc.getText();
    const tmp: SymbolDef[] = [];
    collectPythonSymbols(rootPath, filePath, relPath, text, tmp);
    for (const s of tmp) {
        if (s.kind === 'variable' && !isLikelyPublicVariable(s.name, relPath)) continue;
        const stableKey = `${s.kind}:${s.name}:${relPath}:${s.line}`;
        out.push({
            kind: s.kind,
            name: s.name,
            stableKey,
            viewId: `symbol_${hashString(stableKey)}`,
            defFilePath: filePath,
            defLine: s.line,
            defChar: 0,
        });
    }

    return out.slice(0, 220);
}

function collectPythonDecoratorsFromText(text: string, defLine: number): Array<{ line: number; text: string; note?: string }> {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const idx = Math.max(0, Math.min(lines.length - 1, defLine - 1));
    const out: Array<{ line: number; text: string; note?: string }> = [];

    for (let j = idx - 1; j >= 0; j--) {
        const raw = lines[j] ?? '';
        const trimmed = raw.trim();
        if (!trimmed) break;
        if (trimmed.startsWith('#')) continue;
        if (/^\s+/.test(raw)) break;
        const m = raw.match(/^\s*@\s*(.+)\s*$/);
        if (!m) break;
        const dec = `@${m[1].trim()}`;
        const t = dec.toLowerCase();
        let note: string | undefined;
        if (/\.(get|post|put|delete|patch|options|head|trace|route|websocket)\b/.test(t) && /@[\w.]+\./.test(t)) note = 'Route decorator';
        else if (/\.(middleware|exception_handler|on_event)\b/.test(t) && /@[\w.]+\./.test(t)) note = 'Framework hook';
        else if (/\bst\.(cache_data|cache_resource|cache|experimental_memo|experimental_singleton|fragment|dialog)\b/.test(t)) note = 'Streamlit decorator';
        out.push({ line: j + 1, text: dec, note });
    }

    out.reverse();
    return out;
}

async function buildSymbolTraceViewFromPosition(
    rootPath: string,
    filePath: string,
    kind: SymbolKind,
    name: string,
    defLine: number,
    defChar: number
): Promise<{ viewId: string; mermaid: string; openMap: Record<string, { filePath: string; line: number }>; stableKey: string }> {
    const relPath = path.relative(rootPath, filePath).replace(/\\/g, '/');
    const stableKey = `${kind}:${name}:${relPath}:${defLine}`;
    const viewId = `symbol_${hashString(stableKey)}`;

    const uri = vscode.Uri.file(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const pos = new vscode.Position(Math.max(0, defLine - 1), Math.max(0, defChar || 0));

    let refs: vscode.Location[] = [];
    try {
        const res = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', uri, pos);
        if (Array.isArray(res)) refs = res;
    } catch {
        // ignore
    }

    const uses: Array<{ filePath: string; relPath: string; line: number; note?: string }> = [];
    const seen = new Set<string>();

    if (filePath.toLowerCase().endsWith('.py')) {
        const decs = collectPythonDecoratorsFromText(doc.getText(), defLine);
        for (const d of decs) {
            if (!d.note) continue;
            const k = `${filePath}:${d.line}`;
            if (seen.has(k)) continue;
            seen.add(k);
            uses.push({ filePath, relPath, line: d.line, note: d.note });
        }
    }

    for (const r of refs) {
        const fp = r.uri.fsPath;
        const rp = path.relative(rootPath, fp).replace(/\\/g, '/');
        const line = (r.range?.start?.line ?? 0) + 1;
        if (fp === filePath && line === defLine) continue;
        const k = `${fp}:${line}`;
        if (seen.has(k)) continue;
        seen.add(k);
        uses.push({ filePath: fp, relPath: rp, line, note: 'Reference' });
    }

    uses.sort((a, b) => {
        const rp = a.relPath.localeCompare(b.relPath);
        if (rp !== 0) return rp;
        return a.line - b.line;
    });

    const maxUses = 14;
    const trimmed = uses.slice(0, maxUses);

    const sameFileIds: string[] = [];
    const crossFileIds: string[] = [];

    const sv: string[] = [];
    sv.push('flowchart TB');
    sv.push(`  Sym[${escapeMermaidLabel(`${kind}: ${name}`)}]`);

    const defNode = toMermaidId(`Def_${hashString(`${relPath}:${defLine}`)}`);
    const defLabel = `Defined: ${relPath}:${defLine}`;
    sv.push(`  ${defNode}[${escapeMermaidLabel(defLabel)}]`);
    sv.push(`  Sym --> ${defNode}`);

    if (trimmed.length === 0) {
        const noneId = toMermaidId(`NoUses_${hashString(stableKey)}`);
        sv.push(`  ${noneId}[No usages indexed]`);
        sv.push(`  Sym --> ${noneId}`);
    } else {
        for (let i = 0; i < trimmed.length; i++) {
            const u = trimmed[i];
            const uid = toMermaidId(`Use_${i + 1}_${hashString(`${u.relPath}:${u.line}`)}`);
            const uLabel = u.note ? `Used: ${u.relPath}:${u.line} - ${u.note}` : `Used: ${u.relPath}:${u.line}`;
            sv.push(`  ${uid}[${escapeMermaidLabel(uLabel)}]`);
            sv.push(`  Sym --> ${uid}`);
            // Classify as same-file or cross-file.
            if (u.filePath === filePath) {
                sameFileIds.push(uid);
            } else {
                crossFileIds.push(uid);
            }
        }
    }

    // Color-coding styles.
    // Definition node: blue
    sv.push(`  style Sym fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#1e3a5f,font-weight:bold`);
    sv.push(`  style ${defNode} fill:#e0e7ff,stroke:#4f46e5,stroke-width:2px,color:#312e81`);
    // Same-file references: green
    for (const id of sameFileIds) {
        sv.push(`  style ${id} fill:#bbf7d0,stroke:#16a34a,stroke-width:2px,color:#064e3b`);
    }
    // Cross-file references: orange/amber
    for (const id of crossFileIds) {
        sv.push(`  style ${id} fill:#fed7aa,stroke:#ea580c,stroke-width:2px,color:#7c2d12`);
    }

    // Legend.
    sv.push(`  subgraph Legend[🎨 Legend]`);
    sv.push(`    direction LR`);
    sv.push(`    L1[Same-file reference]`);
    sv.push(`    L2[Cross-file reference]`);
    sv.push(`    L3[Definition]`);
    sv.push(`    style L1 fill:#bbf7d0,stroke:#16a34a,stroke-width:2px,color:#064e3b`);
    sv.push(`    style L2 fill:#fed7aa,stroke:#ea580c,stroke-width:2px,color:#7c2d12`);
    sv.push(`    style L3 fill:#e0e7ff,stroke:#4f46e5,stroke-width:2px,color:#312e81`);
    sv.push(`  end`);

    const openMap: Record<string, { filePath: string; line: number }> = {};
    openMap[defNode] = { filePath, line: defLine };
    openMap[defLabel] = { filePath, line: defLine };
    for (let i = 0; i < trimmed.length; i++) {
        const u = trimmed[i];
        const uid = toMermaidId(`Use_${i + 1}_${hashString(`${u.relPath}:${u.line}`)}`);
        const uLabel = u.note ? `Used: ${u.relPath}:${u.line} - ${u.note}` : `Used: ${u.relPath}:${u.line}`;
        openMap[uid] = { filePath: u.filePath, line: u.line };
        openMap[uLabel] = { filePath: u.filePath, line: u.line };
    }

    return { viewId, mermaid: addClassStyling(sv.join('\n')), openMap, stableKey };
}

async function buildModuleImportMapView(rootPath: string): Promise<{ viewId: string; mermaid: string; openMap: Record<string, { filePath: string; line: number }> }> {
    const viewId = 'modules';

    const sourceUris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(rootPath, '**/*.{py,ts,tsx,js,jsx}'),
        '**/{node_modules,dist,out,.next,build,coverage,.turbo,venv,.venv,__pycache__,.history,.git}/**',
        220
    );

    const relOf = (fsPath: string) => path.relative(rootPath, fsPath).replace(/\\/g, '/');

    const scoreRel = (rel: string): number => {
        const r = rel.toLowerCase();
        let score = 0;
        if (/(^|\/)(app|main|server|index|run|streamlit_app)\.(py|ts|tsx|js|jsx)$/.test(r)) score += 60;
        if (/(^|\/)(api|routes|routers|router|controllers|backend|server|src)(\/|$)/.test(r)) score += 25;
        if (/(^|\/)(frontend|ui|views|pages)(\/|$)/.test(r)) score += 15;
        if (/(^|\/)tests?(\/|$)/.test(r)) score -= 30;
        return score;
    };

    const sorted = sourceUris
        .slice()
        .sort((a, b) => scoreRel(relOf(b.fsPath)) - scoreRel(relOf(a.fsPath)));

    const files = sorted.slice(0, 90);
    const topFolders = new Set<string>();
    for (const u of files) {
        const rel = relOf(u.fsPath);
        const top = rel.includes('/') ? rel.split('/')[0] : 'root';
        topFolders.add(top);
    }

    const groupForRel = (rel: string): string => {
        const cleaned = rel.replace(/\\/g, '/');
        return cleaned.includes('/') ? cleaned.split('/')[0] : 'root';
    };

    const resolveRelative = (fromRel: string, target: string): string | null => {
        const baseDir = fromRel.includes('/') ? fromRel.split('/').slice(0, -1).join('/') : '';
        const joined = path.posix.normalize(path.posix.join(baseDir, target));
        if (!joined) return null;
        return joined;
    };

    const edgeCounts = new Map<string, number>(); // key = fromGroup->toGroup
    const fileCounts = new Map<string, number>();

    const bump = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) || 0) + by);

    for (const uri of files) {
        let text = '';
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            text = Buffer.from(bytes).toString('utf8');
        } catch {
            continue;
        }

        const rel = relOf(uri.fsPath);
        const fromGroup = groupForRel(rel);
        bump(fileCounts, fromGroup, 1);

        const lines = text.replace(/\r\n/g, '\n').split('\n');
        const maxLines = Math.min(lines.length, 220);

        for (let i = 0; i < maxLines; i++) {
            const line = lines[i] || '';
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

            // Python: from x.y import z / import x.y
            const pyFrom = trimmed.match(/^from\s+([A-Za-z0-9_\.]+)\s+import\b/);
            const pyImp = trimmed.match(/^import\s+([A-Za-z0-9_\.]+)/);
            if (pyFrom || pyImp) {
                const mod = (pyFrom ? pyFrom[1] : pyImp ? pyImp[1] : '') || '';
                if (!mod) continue;
                const root = mod.split('.')[0];
                if (topFolders.has(root)) {
                    const k = `${fromGroup}->${root}`;
                    bump(edgeCounts, k, 1);
                }
                continue;
            }

            // JS/TS: import ... from 'x' / require('x')
            const jsImp = trimmed.match(/\bfrom\s+['"]([^'"]+)['"]/);
            const jsReq = trimmed.match(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/);
            const target = (jsImp ? jsImp[1] : jsReq ? jsReq[1] : '') || '';
            if (!target) continue;

            if (target.startsWith('.') || target.startsWith('..')) {
                const resolved = resolveRelative(rel, target);
                if (!resolved) continue;
                const toGroup = groupForRel(resolved);
                if (toGroup && topFolders.has(toGroup)) {
                    const k = `${fromGroup}->${toGroup}`;
                    bump(edgeCounts, k, 1);
                }
                continue;
            }

            // Non-relative: treat first segment as workspace folder candidate.
            const first = target.split('/')[0];
            if (topFolders.has(first)) {
                const k = `${fromGroup}->${first}`;
                bump(edgeCounts, k, 1);
            }
        }
    }

    const groups = Array.from(fileCounts.keys()).sort((a, b) => a.localeCompare(b));
    const lines: string[] = [];
    lines.push('flowchart LR');

    const idByGroup = new Map<string, string>();
    for (const g of groups) {
        const id = toMermaidId(`M_${g}`);
        idByGroup.set(g, id);
        const cnt = fileCounts.get(g) || 0;
        // Avoid Mermaid shape edge-cases like `[(...)]` which triggers the "cylinder" node syntax.
        lines.push(`  ${id}[${escapeMermaidLabel(`${g}: ${cnt}`)}]`);
    }

    // Keep the graph readable: only show the top edges.
    const edges = Array.from(edgeCounts.entries())
        .map(([k, c]) => ({ k, c }))
        .sort((a, b) => b.c - a.c)
        .slice(0, 35);

    for (const e of edges) {
        const parts = e.k.split('->');
        const from = parts[0];
        const to = parts[1];
        if (!from || !to) continue;
        if (from === to) continue;
        const fromId = idByGroup.get(from);
        const toId = idByGroup.get(to);
        if (!fromId || !toId) continue;
        lines.push(`  ${fromId} -->|${e.c}| ${toId}`);
    }

    const mermaid = addClassStyling(lines.join('\n'));
    return { viewId, mermaid, openMap: {} };
}

function countKinds(defs: SymbolDef[]): { classCount: number; functionCount: number; variableCount: number } {
    let classCount = 0;
    let functionCount = 0;
    let variableCount = 0;
    for (const d of defs) {
        if (d.kind === 'class') classCount++;
        else if (d.kind === 'function') functionCount++;
        else if (d.kind === 'variable') variableCount++;
    }
    return { classCount, functionCount, variableCount };
}

function buildFileSymbolsView(
    views: Record<string, string>,
    navByViewId: Record<string, Record<string, string>>,
    openByViewId: Record<string, Record<string, { filePath: string; line: number }>>,
    scan: WorkspaceScan,
    sectionKind: ScanNodeKind,
    prefix: string,
    relPath: string,
    defs: SymbolDef[],
    viewId: string
) {
    const lines: string[] = [];
    lines.push('flowchart TB');
    const headerLabel = `File ${relPath}`;
    lines.push(`  File[${escapeMermaidLabel(headerLabel)}]`);

    const nav: Record<string, string> = {};
    const open: Record<string, { filePath: string; line: number }> = {};

    const anyDef = defs[0];
    if (anyDef) {
        open[headerLabel] = { filePath: anyDef.filePath, line: 1 };
    }

    const byKind: Record<SymbolKind, SymbolDef[]> = { class: [], function: [], variable: [] };
    for (const d of defs) byKind[d.kind].push(d);
    for (const k of Object.keys(byKind) as SymbolKind[]) {
        byKind[k].sort((a, b) => a.name.localeCompare(b.name));
    }

    const kindTitles: Array<{ kind: SymbolKind; title: string }> = [
        { kind: 'class', title: 'Classes' },
        { kind: 'function', title: 'Functions' },
        { kind: 'variable', title: 'Variables' },
    ];

    lines.push('  subgraph Kinds[Objects]');
    lines.push('    direction LR');

    for (const kt of kindTitles) {
        const list = byKind[kt.kind].slice(0, 25);
        if (list.length === 0) continue;
        const kindId = toMermaidId(`K_${kt.kind}_${hashString(`${viewId}:${kt.kind}`)}`);
        lines.push(`    subgraph ${kindId}[${escapeMermaidLabel(kt.title)}]`);
        lines.push('      direction TB');

        const nodeIds: string[] = [];
        for (const d of list) {
            const stable = `${d.kind}:${d.name}:${d.relPath}:${d.line}`;
            const nodeId = toMermaidId(`S_${hashString(stable)}`);
            const label = `${prefix} ${d.kind} ${d.name}`;
            nodeIds.push(nodeId);
            lines.push(`      ${nodeId}[${escapeMermaidLabel(label)}]`);
            nav[label] = `symbol_${hashString(stable)}`;
        }
        for (let i = 0; i < nodeIds.length - 1; i++) {
            lines.push(`      ${nodeIds[i]} --> ${nodeIds[i + 1]}`);
        }

        lines.push('    end');
        // Anchor from File to the first item in each kind for consistent layout.
        const first = list[0];
        if (first) {
            const stable = `${first.kind}:${first.name}:${first.relPath}:${first.line}`;
            lines.push(`    File --> ${toMermaidId(`S_${hashString(stable)}`)}`);
        }
    }

    lines.push('  end');

    views[viewId] = addClassStyling(lines.join('\n'));
    navByViewId[viewId] = nav;
    openByViewId[viewId] = open;
}

function buildCatalog(scan: WorkspaceScan): MermaidPreview["catalog"] {
    const symbolsByFile: MermaidPreview["catalog"]["symbolsByFile"] = {};
    const countsByFile = new Map<string, { filePath: string; classCount: number; functionCount: number; variableCount: number }>();

    for (const s of scan.symbols) {
        const arr = symbolsByFile[s.relPath] || [];
        const stable = `${s.kind}:${s.name}:${s.relPath}:${s.line}`;
        arr.push({
            kind: s.kind,
            name: s.name,
            viewId: `symbol_${hashString(stable)}`,
            defFilePath: s.filePath,
            defLine: s.line,
            stableKey: stable,
        });
        symbolsByFile[s.relPath] = arr;

        const cur = countsByFile.get(s.relPath) || { filePath: s.filePath, classCount: 0, functionCount: 0, variableCount: 0 };
        if (s.kind === 'class') cur.classCount++;
        else if (s.kind === 'function') cur.functionCount++;
        else if (s.kind === 'variable') cur.variableCount++;
        countsByFile.set(s.relPath, cur);
    }

    const files: MermaidPreview["catalog"]["files"] = [];
    for (const [relPath, c] of countsByFile.entries()) {
        files.push({ relPath, filePath: c.filePath, classCount: c.classCount, functionCount: c.functionCount, variableCount: c.variableCount });
    }

    files.sort((a, b) => a.relPath.localeCompare(b.relPath));

    // Keep catalog bounded.
    const maxFiles = 200;
    const trimmedFiles = files.slice(0, maxFiles);
    const trimmedSymbolsByFile: typeof symbolsByFile = {};
    for (const f of trimmedFiles) {
        trimmedSymbolsByFile[f.relPath] = (symbolsByFile[f.relPath] || []).slice(0, 120);
    }

    return { files: trimmedFiles, symbolsByFile: trimmedSymbolsByFile };
}

function addGlobalSymbolViews(
    views: Record<string, string>,
    navByViewId: Record<string, Record<string, string>>,
    openByViewId: Record<string, Record<string, { filePath: string; line: number }>>,
    scan: WorkspaceScan,
    catalog: MermaidPreview["catalog"]
) {
    // Build missing symbol_* views referenced by the picker (and any other UI).
    // Bound the work to avoid huge payloads for very large repos.
    const maxSymbols = 250;

    let count = 0;
    for (const file of catalog.files) {
        const list = catalog.symbolsByFile[file.relPath] || [];
        for (const item of list) {
            if (!item.viewId || views[item.viewId]) continue;

            const defLabel = `Defined: ${file.relPath}:${item.defLine || 1}`;
            const stableKey = item.stableKey || `${item.kind}:${item.name}:${file.relPath}:${item.defLine || 1}`;
            const uses = (scan.symbolUses[stableKey] || []).slice(0, 8);

            const lines: string[] = [];
            lines.push('flowchart TB');
            lines.push(`  Sym[${escapeMermaidLabel(`${item.kind}: ${item.name}`)}]`);

            const defNode = toMermaidId(`Def_${hashString(`${file.relPath}:${item.defLine || 1}`)}`);
            lines.push(`  ${defNode}[${escapeMermaidLabel(defLabel)}]`);
            lines.push(`  Sym --> ${defNode}`);

            if (uses.length === 0) {
                const noneId = toMermaidId(`NoUses_${hashString(`${stableKey}:${file.relPath}:${item.defLine || 1}`)}`);
                lines.push(`  ${noneId}[No usages indexed]`);
                lines.push(`  Sym --> ${noneId}`);
            } else {
                for (let i = 0; i < uses.length; i++) {
                    const u = uses[i];
                    const uid = toMermaidId(`Use_${i + 1}_${hashString(`${u.relPath}:${u.line}`)}`);
                    const uLabel = u.note ? `Used: ${u.relPath}:${u.line} - ${u.note}` : `Used: ${u.relPath}:${u.line}`;
                    lines.push(`  ${uid}[${escapeMermaidLabel(uLabel)}]`);
                    lines.push(`  Sym --> ${uid}`);
                }
            }

            views[item.viewId] = addClassStyling(lines.join('\n'));
            navByViewId[item.viewId] = {};

            const open: Record<string, { filePath: string; line: number }> = {};
            open[defLabel] = { filePath: item.defFilePath, line: item.defLine || 1 };
            for (const u of uses) {
                const uLabel = u.note ? `Used: ${u.relPath}:${u.line} - ${u.note}` : `Used: ${u.relPath}:${u.line}`;
                open[uLabel] = { filePath: u.filePath, line: u.line };
            }
            openByViewId[item.viewId] = open;

            count++;
            if (count >= maxSymbols) return;
        }
    }
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

/** Returns the Mermaid shape wrapper for a node based on its kind. */
function mermaidShape(id: string, label: string, kind: ScanNodeKind): string {
    const safe = escapeMermaidLabel(label);
    switch (kind) {
        case 'datastore': return `${id}[(${safe})]`;   // cylinder
        case 'external': return `${id}{{${safe}}}`;   // hexagon
        case 'frontend': return `${id}([${safe}])`;   // stadium / pill
        case 'service': return `${id}[/${safe}/]`;    // parallelogram
        default: return `${id}[${safe}]`;     // rectangle
    }
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

    const sections: Array<{ kind: ScanNodeKind; title: string; icon: string }> = [
        { kind: 'frontend', title: 'Frontend', icon: '🖥️' },
        { kind: 'backend', title: 'Backend / API', icon: '⚙️' },
        { kind: 'service', title: 'Services', icon: '🔧' },
        { kind: 'datastore', title: 'Data Store', icon: '🗄️' },
        { kind: 'external', title: 'External', icon: '🌐' },
        { kind: 'unknown', title: 'Other', icon: '📦' },
    ];

    for (const sec of sections) {
        const secNodes = byKind.get(sec.kind) || [];
        if (secNodes.length === 0) continue;
        lines.push(`  subgraph ${toMermaidId(sec.title)}[${sec.icon} ${escapeMermaidLabel(sec.title)}]`);
        lines.push('    direction TB');
        for (const n of secNodes) {
            lines.push(`    ${mermaidShape(n.id, n.label, n.kind)}`);
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

// ──────────────────────── Route Map View ────────────────────────

function buildRouteMapView(
    scan: WorkspaceScan
): { mermaid: string; openMap: Record<string, { filePath: string; line: number }>; navMap: Record<string, string>; dataFlowMeta: Record<string, { filePath: string; handlerName: string; routeLabel: string; handlerLine: number }> } {
    const regs = (scan.frameworkRegistrations || []).filter(r => r.kind === 'route' || r.kind === 'urlpattern');
    const openMap: Record<string, { filePath: string; line: number }> = {};
    const navMap: Record<string, string> = {};
    const dataFlowMeta: Record<string, { filePath: string; handlerName: string; routeLabel: string; handlerLine: number }> = {};
    const sv: string[] = [];
    sv.push('flowchart LR');

    if (regs.length === 0) {
        sv.push('  NoRoutes[No API routes detected]');
        return { mermaid: addClassStyling(sv.join('\n')), openMap, navMap, dataFlowMeta };
    }

    // Group routes by file.
    const byFile = new Map<string, typeof regs>();
    for (const r of regs) {
        const list = byFile.get(r.relPath) || [];
        list.push(r);
        byFile.set(r.relPath, list);
    }

    // Color palette for HTTP methods.
    const methodColors: Record<string, string> = {
        GET: '#bbf7d0', POST: '#bae6fd', PUT: '#fde68a',
        DELETE: '#fecdd3', PATCH: '#ddd6fe', OPTIONS: '#e2e8f0',
    };

    let routeIdx = 0;
    for (const [relPath, fileRoutes] of byFile) {
        const fileId = toMermaidId(`rf_${hashString(relPath)}`);
        sv.push(`  subgraph ${fileId}[📄 ${escapeMermaidLabel(relPath)}]`);
        sv.push('    direction TB');

        for (const r of fileRoutes) {
            routeIdx++;
            const rid = toMermaidId(`route_${routeIdx}`);
            const method = (r.meta || 'GET').toUpperCase();
            const handlerPart = r.handlerName ? ` -> ${r.handlerName}` : '';
            const label = `${method} ${r.name}${handlerPart}`;
            sv.push(`    ${rid}[${escapeMermaidLabel(label)}]`);

            // Style by method.
            const fill = methodColors[method] || '#e2e8f0';
            sv.push(`    style ${rid} fill:${fill},stroke:#475569,stroke-width:1px,color:#1e293b`);

            // For routes with a handler, enable data flow navigation.
            if (r.handlerName) {
                const dfViewId = `dataflow_${hashString(`${r.filePath}:${r.line}:${r.handlerName}`)}`;
                navMap[rid] = dfViewId;
                navMap[label] = dfViewId;
                dataFlowMeta[dfViewId] = { filePath: r.filePath, handlerName: r.handlerName, routeLabel: label, handlerLine: r.line };
            } else {
                // No handler name — just open the file.
                openMap[rid] = { filePath: r.filePath, line: r.line };
                openMap[label] = { filePath: r.filePath, line: r.line };
            }
        }

        sv.push('  end');
    }

    // Legend.
    sv.push('  subgraph Legend[🎨 Method Colors]');
    sv.push('    direction LR');
    sv.push('    LG[GET]');
    sv.push('    LP[POST]');
    sv.push('    LU[PUT]');
    sv.push('    LD[DELETE]');
    sv.push('    style LG fill:#bbf7d0,stroke:#475569,color:#1e293b');
    sv.push('    style LP fill:#bae6fd,stroke:#475569,color:#1e293b');
    sv.push('    style LU fill:#fde68a,stroke:#475569,color:#1e293b');
    sv.push('    style LD fill:#fecdd3,stroke:#475569,color:#1e293b');
    sv.push('  end');

    return { mermaid: sv.join('\n'), openMap, navMap, dataFlowMeta };
}

// ──────────────────────── Data Flow View ────────────────────────

async function buildDataFlowForRoute(
    rootPath: string,
    filePath: string,
    handlerName: string,
    routeLabel: string,
    handlerLine: number
): Promise<{ viewId: string; mermaid: string; openMap: Record<string, { filePath: string; line: number }> }> {
    const viewId = `dataflow_${hashString(`${filePath}:${handlerLine}:${handlerName}`)}`;
    const openMap: Record<string, { filePath: string; line: number }> = {};
    const sv: string[] = [];
    sv.push('flowchart TB');

    // Root: the route itself.
    const routeId = 'RouteEntry';
    sv.push(`  ${routeId}([🛤️ ${escapeMermaidLabel(routeLabel)}])`);
    sv.push(`  style ${routeId} fill:#fef3c7,stroke:#d97706,stroke-width:2px,color:#713f12,font-weight:bold`);

    // Handler function.
    const handlerId = 'Handler';
    const relPath = path.relative(rootPath, filePath).replace(/\\/g, '/');
    const handlerLabel = `${handlerName}() · ${relPath}:${handlerLine}`;
    sv.push(`  ${handlerId}[🔧 ${escapeMermaidLabel(handlerLabel)}]`);
    sv.push(`  style ${handlerId} fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#1e3a5f,font-weight:bold`);
    sv.push(`  ${routeId} --> ${handlerId}`);
    openMap[handlerId] = { filePath, line: handlerLine };
    openMap[handlerLabel] = { filePath, line: handlerLine };

    // Trace references FROM the handler: find what the handler calls.
    try {
        const uri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();
        const lines = text.split(/\r?\n/);

        // Find the handler function body and extract function calls within it.
        const startIdx = Math.max(0, handlerLine - 1);
        const endIdx = Math.min(lines.length, startIdx + 40); // Scan up to 40 lines of function body.

        const builtins = new Set(['if', 'for', 'while', 'return', 'print', 'raise', 'except', 'try', 'with', 'async', 'await', 'def', 'class', 'import', 'from', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple', 'isinstance', 'type', 'super', 'self', 'True', 'False', 'None', 'not', 'and', 'or', 'in', 'is', 'pass', 'break', 'continue', 'yield', 'const', 'let', 'var', 'function', 'new', 'typeof', 'require', 'console', 'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Error', 'Map', 'Set', 'Date']);
        const calledFunctions: { name: string, lineIdx: number }[] = [];
        const seenNames = new Set<string>();

        for (let i = startIdx + 1; i < endIdx; i++) {
            const line = lines[i];
            // Stop at the next function/class definition (end of handler body).
            if (/^(?:def |class |async def |export |function )/.test(line.trim()) && i > startIdx + 1) break;

            const callPattern = /\b([a-zA-Z_]\w*)\s*\(/g;
            let m;
            while ((m = callPattern.exec(line)) !== null) {
                const name = m[1];
                if (!builtins.has(name) && name !== handlerName && name.length > 1) {
                    if (!seenNames.has(name)) {
                        seenNames.add(name);
                        calledFunctions.push({ name, lineIdx: i });
                    }
                }
            }
        }

        const getPlainEnglishName = (fnName: string): string => {
            const lower = fnName.toLowerCase();
            if (lower.includes('query') || lower.includes('select') || lower.includes('find') || lower.includes('filter') || lower.includes('get')) return 'Read Database';
            if (lower.includes('insert') || lower.includes('add') || lower.includes('save') || lower.includes('create')) return 'Save to Database';
            if (lower.includes('update') || lower.includes('modify')) return 'Update Database';
            if (lower.includes('delete') || lower.includes('remove')) return 'Delete from Database';
            if (lower.includes('commit')) return 'Commit Transaction';
            if (lower.includes('execute')) return 'Execute Query';
            if (lower.includes('fetch') || lower.includes('request')) return 'Fetch External Data';
            if (lower.includes('post') || lower.includes('send') || lower.includes('webhook')) return 'Send External Request';
            if (lower.includes('generate')) return `Generate ${fnName.replace(/generate/i, '').replace(/_/g, ' ')}`;
            if (lower.includes('validate') || lower.includes('check') || lower.includes('verify')) return `Validate ${fnName.replace(/validate|check|verify/i, '').replace(/_/g, ' ')}`;
            if (lower === 'depends') return 'Inject Dependencies';
            if (lower === 'httpexception') return 'Throw Error';
            return fnName.replace(/_/g, ' '); // simple conversion
        };

        // Resolve each called function using the symbol index.
        let callIdx = 0;
        const maxCalls = 10;
        let prevNodeId = handlerId;

        for (const call of calledFunctions) {
            if (callIdx >= maxCalls) break;
            callIdx++;

            const fnName = call.name;
            const callId = toMermaidId(`call_${callIdx}`);

            // Try to find where this function is defined.
            let defInfo = '';
            let defFilePath: string | undefined;
            let defLine = 1;

            try {
                const charIdx = lines[call.lineIdx].indexOf(fnName);
                const defLoc = await getDefinitionLocation(filePath, call.lineIdx + 1, charIdx);
                if (defLoc) {
                    defFilePath = defLoc.filePath;
                    defLine = defLoc.line;
                    let defRel = path.relative(rootPath, defLoc.filePath).replace(/\\/g, '/');

                    if (defRel.includes('node_modules/') || defRel.includes('site-packages/') || defRel.includes('packages/')) {
                        const matched = defRel.match(/(?:node_modules|site-packages|packages)\/([^/]+)/);
                        if (matched) {
                            defRel = `📦 ${matched[1]}`;
                            defInfo = ` · ${defRel}`;
                        }
                    } else {
                        defInfo = ` · ${defRel}:${defLine}`;
                    }
                }
            } catch { /* ignore */ }

            const plainName = getPlainEnglishName(fnName);
            const callLabel = `${plainName}${defInfo}`;

            // Categorize: DB-related, external-related, or general service call.
            const lowerName = fnName.toLowerCase();
            const isDb = /query|execute|cursor|commit|insert|update|delete|select|find|save|create_all|session|collection|aggregate/.test(lowerName);
            const isExternal = /fetch|request|post|get|send|api|http|axios|client|webhook/.test(lowerName);

            if (isDb) {
                sv.push(`    ${callId}[(🗄️ ${escapeMermaidLabel(callLabel)})]`);
                sv.push(`    style ${callId} fill:#bae6fd,stroke:#0369a1,stroke-width:2px,color:#0c4a6e`);
            } else if (isExternal) {
                sv.push(`    ${callId}([🌐 ${escapeMermaidLabel(callLabel)}])`);
                sv.push(`    style ${callId} fill:#fecdd3,stroke:#e11d48,stroke-width:2px,color:#881337`);
            } else {
                sv.push(`    ${callId}[⚙️ ${escapeMermaidLabel(callLabel)}]`);
                sv.push(`    style ${callId} fill:#ddd6fe,stroke:#7c3aed,stroke-width:2px,color:#2e1065`);
            }

            sv.push(`  ${prevNodeId} --> ${callId}`);
            sv.push(`  click ${callId} "#" "Original: ${fnName}()"`);

            prevNodeId = callId;

            if (defFilePath) {
                openMap[callId] = { filePath: defFilePath, line: defLine };
                openMap[callLabel] = { filePath: defFilePath, line: defLine };
            }
        }

        if (calledFunctions.length === 0) {
            sv.push('  NoCallsFound[No outgoing calls detected in handler body]');
            sv.push('  style NoCallsFound fill:none,stroke:#94a3b8,color:#64748b,stroke-dasharray:4 2');
            sv.push(`  ${handlerId} --> NoCallsFound`);
        }
    } catch (err: any) {
        sv.push(`  TraceError[Error tracing: ${escapeMermaidLabel(err?.message || 'unknown')}]`);
        sv.push(`  ${handlerId} --> TraceError`);
    }

    // Legend.
    sv.push('  subgraph Legend[🎨 Legend]');
    sv.push('    direction LR');
    sv.push('    L1([Route])');
    sv.push('    L2[Handler]');
    sv.push('    L3[Service Call]');
    sv.push('    L4[(Database)]');
    sv.push('    L5([External])');
    sv.push('    style L1 fill:#fef3c7,stroke:#d97706,color:#713f12');
    sv.push('    style L2 fill:#dbeafe,stroke:#2563eb,color:#1e3a5f');
    sv.push('    style L3 fill:#ddd6fe,stroke:#7c3aed,color:#2e1065');
    sv.push('    style L4 fill:#bae6fd,stroke:#0369a1,color:#0c4a6e');
    sv.push('    style L5 fill:#fecdd3,stroke:#e11d48,color:#881337');
    sv.push('  end');

    return { viewId, mermaid: sv.join('\n'), openMap };
}

// ──────────────────────── Dead Code Detection ────────────────────────

interface DeadSymbol {
    name: string;
    kind: SymbolKind;
    filePath: string;
    relPath: string;
    line: number;
}

function findDeadCode(scan: WorkspaceScan): DeadSymbol[] {
    const dead: DeadSymbol[] = [];
    // Names that are typically entry-points or framework-wired and should not be flagged.
    const entryPoints = new Set(['main', 'app', 'index', '__init__', 'setup', 'configure', 'register',
        'activate', 'deactivate', 'create_app', 'make_app', 'lifespan', 'startup', 'shutdown']);

    // Collect handler names from framework registrations (these are wired by decorators, not direct calls).
    const handlerNames = new Set<string>();
    for (const reg of (scan.frameworkRegistrations || [])) {
        if (reg.handlerName) handlerNames.add(reg.handlerName);
    }

    for (const sym of scan.symbols) {
        // Skip private/internal symbols.
        if (sym.name.startsWith('_') && sym.name !== '__init__') continue;
        // Skip entry points and framework handlers.
        if (entryPoints.has(sym.name.toLowerCase())) continue;
        if (handlerNames.has(sym.name)) continue;
        // Skip variables (too noisy).
        if (sym.kind === 'variable') continue;

        const stableKey = `${sym.kind}:${sym.name}:${sym.relPath}:${sym.line}`;
        const uses = scan.symbolUses[stableKey] || [];
        // Count only cross-file references.
        const crossFileUses = uses.filter((u: any) => u.filePath !== sym.filePath);
        if (crossFileUses.length === 0) {
            dead.push({ name: sym.name, kind: sym.kind, filePath: sym.filePath, relPath: sym.relPath, line: sym.line });
        }
    }

    return dead;
}

function buildDeadCodeView(
    deadSymbols: DeadSymbol[]
): { mermaid: string; openMap: Record<string, { filePath: string; line: number }> } {
    const openMap: Record<string, { filePath: string; line: number }> = {};
    const sv: string[] = [];
    sv.push('flowchart TB');

    if (deadSymbols.length === 0) {
        sv.push('  NoDead[✅ No dead code detected — all symbols are referenced]');
        sv.push('  style NoDead fill:#bbf7d0,stroke:#16a34a,stroke-width:2px,color:#064e3b');
        return { mermaid: sv.join('\n'), openMap };
    }

    sv.push(`  Header["⚠️ ${deadSymbols.length} unreferenced symbol${deadSymbols.length > 1 ? 's' : ''} · Click any item to open"]`);
    sv.push('  style Header fill:#fef3c7,stroke:#d97706,stroke-width:2px,color:#713f12,font-weight:bold');

    // Group by file and cap display to keep the diagram readable.
    const byFile = new Map<string, DeadSymbol[]>();
    for (const d of deadSymbols) {
        const list = byFile.get(d.relPath) || [];
        list.push(d);
        byFile.set(d.relPath, list);
    }

    const MAX_FILES = 12;        // Max file cards to show
    const MAX_SYMS_PER_FILE = 5; // Max symbols per file card
    const COLS = 3;              // Grid columns

    const fileEntries = Array.from(byFile.entries()).slice(0, MAX_FILES);
    const hiddenFiles = byFile.size - fileEntries.length;

    // Organise files into column groups of COLS each.
    // Each row-group connects to the header separately so Mermaid renders them roughly as a grid.
    let fileIdx = 0;
    const rowGroups: string[][] = [];
    let currentRow: string[] = [];

    for (const [relPath, syms] of fileEntries) {
        fileIdx++;
        const fileId = toMermaidId(`df_${fileIdx}`);

        // Short label: just the file name + folder.
        const parts = relPath.replace(/\\/g, '/').split('/');
        const shortLabel = parts.length > 1 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : relPath;

        sv.push(`  subgraph ${fileId}["📄 ${escapeMermaidLabel(shortLabel)}"]`);
        sv.push('    direction TB');

        const shownSyms = syms.slice(0, MAX_SYMS_PER_FILE);
        for (let i = 0; i < shownSyms.length; i++) {
            const s = shownSyms[i];
            const sid = toMermaidId(`dead_${fileIdx}_${i + 1}`);
            const kindIcon = s.kind === 'class' ? '🏗️' : s.kind === 'function' ? '⚡' : '📦';
            const label = `${kindIcon} ${s.name}  L${s.line}`;
            sv.push(`    ${sid}["${escapeMermaidLabel(label)}"]`);
            sv.push(`    style ${sid} fill:#fecdd3,stroke:#e11d48,stroke-width:1px,color:#881337`);
            openMap[sid] = { filePath: s.filePath, line: s.line };
            openMap[label] = { filePath: s.filePath, line: s.line };
        }

        if (syms.length > MAX_SYMS_PER_FILE) {
            const moreId = toMermaidId(`dead_${fileIdx}_more`);
            sv.push(`    ${moreId}["+${syms.length - MAX_SYMS_PER_FILE} more symbols"]`);
            sv.push(`    style ${moreId} fill:none,stroke:#94a3b8,stroke-dasharray:4 4,color:#64748b,font-size:11px`);
        }

        sv.push('  end');
        currentRow.push(fileId);

        if (currentRow.length === COLS) {
            rowGroups.push(currentRow);
            currentRow = [];
        }
    }
    if (currentRow.length > 0) rowGroups.push(currentRow);

    // Link: Header --> each row's first file, and files in a row are chained side-by-side.
    for (const row of rowGroups) {
        sv.push(`  Header --> ${row[0]}`);
        for (let i = 0; i < row.length - 1; i++) {
            sv.push(`  ${row[i]} ~~~ ${row[i + 1]}`);
        }
    }

    if (hiddenFiles > 0) {
        const moreFilesId = toMermaidId('deadMoreFiles');
        sv.push(`  ${moreFilesId}["📂 +${hiddenFiles} more file${hiddenFiles > 1 ? 's' : ''} with dead code..."]`);
        sv.push(`  style ${moreFilesId} fill:none,stroke:#94a3b8,stroke-dasharray:4 4,color:#64748b,font-weight:bold`);
        sv.push(`  Header --> ${moreFilesId}`);
    }

    return { mermaid: sv.join('\n'), openMap };
}

// ──────────────────────── Feature Domains / Subsystems ────────────────────────

async function buildSubsystemDomainView(scan: WorkspaceScan): Promise<{ mermaid: string; openMap: Record<string, { filePath: string; line: number }>; navMap: Record<string, string> }> {
    const lines: string[] = ['flowchart TD'];
    const openMap: Record<string, { filePath: string; line: number }> = {};
    const navMap: Record<string, string> = {};

    // ─────────────────────────────────────────────────────────────────
    // NEW: Intelligent Domain Clustering via LLM
    // ─────────────────────────────────────────────────────────────────
    async function detectDomainsWithLLM(scanReq: WorkspaceScan, fallbackNodes: Array<{ label: string, kind: ScanNodeKind, id: string, filePath?: string, relPath: string }>): Promise<Map<string, string>> {
        const fileToDomain = new Map<string, string>();
        try {
            const models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
            if (!models || models.length === 0) {
                console.warn('@mapper: No compatible LLM found for domain mapping. Falling back to regex.');
                throw new Error("No LM");
            }

            const model = models[0];

            // Build a concise payload for the LLM: just file paths and their kind.
            const fileList = fallbackNodes.map(n => `- ${n.relPath} (${n.kind})`).join('\n');
            const prompt = `You are a software architect analyzing a codebase.
I will give you a list of files and their layer (frontend, backend, datastore).
Group these files into 3 to 6 high-level "Business Subsystems" (e.g., "Authentication", "Checkout", "User Profile", "Core UI", "Analytics").
Do NOT use generic names like "Frontend" or "Backend" for domains.
Assign every file to exactly one subsystem.

Return ONLY a valid JSON object mapping the exact file path to the Subsystem Name. Example:
{
  "src/components/Login.tsx": "Authentication",
  "src/api/auth.ts": "Authentication",
  "src/db/users.sql": "Authentication",
  "src/components/Cart.tsx": "Checkout"
}

Files to analyze:
${fileList}`;

            const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, new vscode.CancellationTokenSource().token);
            let responseText = '';
            for await (const chunk of response.text) {
                responseText += chunk;
            }

            // Extract JSON from potential markdown block
            const jsonStr = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
            const jsonMap = JSON.parse(jsonStr);

            for (const [key, value] of Object.entries(jsonMap)) {
                fileToDomain.set(key, String(value));
            }
            return fileToDomain;

        } catch (e) {
            console.error("@mapper domain LLM failed:", e);
            // Fallback syntax
            const domainKeywords = ['auth', 'user', 'product', 'order', 'payment', 'cart', 'catalog', 'billing', 'admin', 'core', 'shared', 'config', 'dashboard', 'profile', 'api', 'database'];
            for (const n of fallbackNodes) {
                const lower = n.relPath.toLowerCase();
                let foundKw = 'General Features';
                for (const kw of domainKeywords) {
                    if (lower.includes(kw)) {
                        foundKw = kw.charAt(0).toUpperCase() + kw.slice(1);
                        break;
                    }
                }
                fileToDomain.set(n.relPath, foundKw);
            }
            return fileToDomain;
        }
    }

    // Filter out noise files to not clutter the domains
    const NOISE_PATTERNS = [/\.test\./i, /\.spec\./i, /\.chunk\./i, /\.min\./i, /node_modules/i, /venv/i, /__pycache__/i, /dist\//i, /build\//i];

    // 1. Gather all candidate nodes
    const candidateNodes: Array<{ label: string, kind: ScanNodeKind, id: string, filePath?: string, relPath: string }> = [];
    let nodeIdCounter = 0;

    for (const [kind, items] of Object.entries(scan.detailsByKind)) {
        if (kind === 'unknown') continue;
        for (const item of items) {
            const rel = item.relPath || item.label;
            if (NOISE_PATTERNS.some(p => p.test(rel))) continue;

            nodeIdCounter++;
            const id = 'domNode_' + nodeIdCounter;
            const fileName = rel.split('/').pop() || rel;

            candidateNodes.push({ label: fileName, kind: kind as ScanNodeKind, id, filePath: item.filePath, relPath: rel });
        }
    }

    // 2. Map nodes to domains (Uses LLM, or falls back to regex)
    const subsystemDomains = new Map<string, Array<{ label: string, kind: ScanNodeKind, id: string, filePath?: string, relPath: string }>>();
    const fileToDomainMap = await detectDomainsWithLLM(scan, candidateNodes);

    for (const node of candidateNodes) {
        let domain = 'General Features';
        // Flexible matching: the LLM might return 'src/Login.tsx' or 'Login.tsx', check if paths align.
        for (const [key, val] of fileToDomainMap.entries()) {
            if (node.relPath === key || node.relPath.endsWith(key) || key.endsWith(node.relPath)) {
                domain = val;
                break;
            }
        }
        const list = subsystemDomains.get(domain) || [];
        list.push(node);
        subsystemDomains.set(domain, list);
    }

    const sortedDomains = Array.from(subsystemDomains.keys()).sort((a, b) => {
        if (a === 'General Features') return 1;
        if (b === 'General Features') return -1;
        return a.localeCompare(b);
    });

    const kindColors: Record<string, { fill: string; stroke: string; color: string; prefix: string }> = {
        frontend:  { fill: '#10b98126', stroke: '#10b9814d', color: '#6ee7b7', prefix: '💻' },
        backend:   { fill: '#8b5cf626', stroke: '#8b5cf64d', color: '#c4b5fd', prefix: '⚙️' },
        datastore: { fill: '#0ea5e926', stroke: '#0ea5e94d', color: '#7dd3fc', prefix: '🗄️' },
        external:  { fill: '#e11d4826', stroke: '#e11d484d', color: '#fda4af', prefix: '🌐' },
        unknown:   { fill: '#ffffff0d', stroke: '#ffffff1a', color: '#cbd5e1', prefix: '📄' },
    };

    if (sortedDomains.length === 0) {
        lines.push('  Empty["No subsystems detected."]');
    } else {
        const COLS = 4;
        let domainIdx = 0;
        const rowGroups: string[][] = [];
        let currentRow: string[] = [];

        const rootNode = 'DomainsRoot';
        lines.push(`  ${rootNode}["🧩 Feature Subsystems"]`);
        lines.push(`  style ${rootNode} fill:#e0e7ff,stroke:#6366f1,stroke-width:2px,color:#1e1b4b,font-weight:bold`);

        for (const domainName of sortedDomains) {
            const nodes = subsystemDomains.get(domainName) || [];
            if (nodes.length === 0) continue;
            
            domainIdx++;
            const domId = toMermaidId(`dom_${domainIdx}`);
            lines.push(`  subgraph ${domId}["🚀 ${escapeMermaidLabel(domainName)}"]`);
            lines.push(`    direction TB`);
            
            const MAX_SHOWN = 6;
            for (let i = 0; i < Math.min(nodes.length, MAX_SHOWN); i++) {
                const n = nodes[i];
                const c = kindColors[n.kind] || kindColors.unknown;
                const nid = toMermaidId(`dom_${domainIdx}_${i}`);
                
                const rawLabel = `${c.prefix} ${n.label || n.relPath}`;
                const safeLabel = rawLabel.replace(/"/g, "'").replace(/\r?\n/g, ' ');
                lines.push(`    ${nid}["${safeLabel}"]`);
                lines.push(`    style ${nid} fill:${c.fill},stroke:${c.stroke},color:${c.color}`);
                
                if (n.filePath) {
                    openMap[nid] = { filePath: n.filePath, line: 1 };
                }
            }
            
            if (nodes.length > MAX_SHOWN) {
                const moreId = toMermaidId(`dom_${domainIdx}_more`);
                lines.push(`    ${moreId}["+${nodes.length - MAX_SHOWN} files..."]`);
                lines.push(`    style ${moreId} fill:none,stroke:#94a3b8,stroke-dasharray:4 4,color:#64748b,font-size:11px`);
            }
            lines.push(`  end`);
            
            currentRow.push(domId);
            if (currentRow.length === COLS) {
                rowGroups.push(currentRow);
                currentRow = [];
            }
        }
        if (currentRow.length > 0) rowGroups.push(currentRow);

        for (const row of rowGroups) {
            lines.push(`  ${rootNode} --> ${row[0]}`);
            for (let i = 0; i < row.length - 1; i++) {
                lines.push(`  ${row[i]} ~~~ ${row[i + 1]}`);
            }
        }
    }

    // Populate openMap generic routing
    for (const node of candidateNodes) {
        if (node.filePath) openMap[node.id] = { filePath: node.filePath, line: 1 };
    }

    return { mermaid: lines.join('\n'), openMap, navMap };
}

async function buildPreviewFromScan(scan: WorkspaceScan): Promise<MermaidPreview> {
    const views: Record<string, string> = {};
    const navByViewId: Record<string, Record<string, string>> = {};
    const openByViewId: MermaidPreview["openByViewId"] = {};

    const catalog = buildCatalog(scan);

    // Overview: show actual detected architecture nodes, not just abstract counts.
    const hasFrontend = scan.nodes.some((n) => n.kind === 'frontend');
    const hasBackend = scan.nodes.some((n) => n.kind === 'backend');
    const hasDataStore = scan.nodes.some((n) => n.kind === 'datastore');
    const hasExternal = scan.nodes.some((n) => n.kind === 'external');

    const byKind = new Map<ScanNodeKind, ScanNode[]>();
    for (const n of scan.nodes) {
        const arr = byKind.get(n.kind) || [];
        arr.push(n);
        byKind.set(n.kind, arr);
    }

    const overviewLines: string[] = [];
    overviewLines.push('flowchart TD');

    const sectionMeta: Array<{ kind: ScanNodeKind; title: string; icon: string; id: string }> = [
        { kind: 'frontend', title: 'Frontend', icon: '🖥️', id: 'sg_Frontend' },
        { kind: 'backend', title: 'Backend / API', icon: '⚙️', id: 'sg_Backend' },
        { kind: 'datastore', title: 'Data Store', icon: '🗄️', id: 'sg_DataStore' },
        { kind: 'external', title: 'External', icon: '🌐', id: 'sg_External' },
    ];

    for (const sec of sectionMeta) {
        const secNodes = byKind.get(sec.kind) || [];
        if (secNodes.length === 0) continue;
        overviewLines.push(`  subgraph ${sec.id}[${sec.icon} ${escapeMermaidLabel(sec.title)}]`);
        overviewLines.push('    direction TB');
        for (const n of secNodes) {
            overviewLines.push(`    ${mermaidShape(n.id, n.label, n.kind)}`);
        }
        // Show file count inside the subgraph as context.
        const fileCount = scan.detailsByKind[sec.kind]?.length || 0;
        if (fileCount > 0) {
            const countId = toMermaidId(`${sec.id}_count`);
            overviewLines.push(`    ${countId}[${fileCount} files]`);
            overviewLines.push(`    style ${countId} fill:none,stroke:none,color:#64748b,font-size:11px`);
        }
        overviewLines.push('  end');
    }

    // Subdomains Node Link
    overviewLines.push('  Domains([🧩 Subsystems / Domains])');
    overviewLines.push('  style Domains fill:#cffafe,stroke:#06b6d4,stroke-width:2px,color:#164e63,font-weight:bold');

    // Second-level map (lazy-built): folder/module import graph.
    overviewLines.push('  Modules([📁 Modules])');

    // Route map: show clickable Routes node if any routes were detected.
    const routeRegs = (scan.frameworkRegistrations || []).filter(r => r.kind === 'route' || r.kind === 'urlpattern');
    const hasRoutes = routeRegs.length > 0;
    if (hasRoutes) {
        overviewLines.push(`  Routes([🛤️ Routes · ${routeRegs.length}])`);
        overviewLines.push('  style Routes fill:#fef3c7,stroke:#d97706,stroke-width:2px,color:#713f12,font-weight:bold');
        if (hasBackend) overviewLines.push('  sg_Backend --> Routes');
    }

    // Dead code detection: show node if dead code exists.
    const deadSymbols = findDeadCode(scan);
    const hasDeadCode = deadSymbols.length > 0;
    if (hasDeadCode) {
        overviewLines.push(`  DeadCode([⚠️ Dead Code · ${deadSymbols.length}])`);
        overviewLines.push('  style DeadCode fill:#fecdd3,stroke:#e11d48,stroke-width:2px,color:#881337,font-weight:bold');
    }

    // Use real edges from the scan instead of hardcoded relations.
    const addedEdges = new Set<string>();
    for (const e of scan.edges) {
        const key = `${e.from}->${e.to}`;
        if (addedEdges.has(key)) continue;
        addedEdges.add(key);
        const lbl = e.label ? `|${escapeMermaidLabel(e.label)}|` : '';
        overviewLines.push(`  ${e.from} -->${lbl} ${e.to}`);
    }

    // Fallback connections if no edges were generated. (Point between subgraphs rather than nodes).
    if (addedEdges.size === 0) {
        if (hasFrontend && hasBackend) overviewLines.push('  sg_Frontend --> sg_Backend');
        if (hasBackend && hasDataStore) overviewLines.push('  sg_Backend --> sg_DataStore');
        if (hasBackend && hasExternal) overviewLines.push('  sg_Backend --> sg_External');
        if (!hasBackend && hasFrontend && hasDataStore) overviewLines.push('  sg_Frontend --> sg_DataStore');
        if (!hasBackend && hasFrontend && hasExternal) overviewLines.push('  sg_Frontend --> sg_External');
    }

    // If we can't infer anything, at least show the scan found something.
    if (!hasFrontend && !hasBackend && !hasDataStore && !hasExternal) {
        overviewLines.push('  Other([📦 Workspace])');
    }

    views.overview = addClassStyling(overviewLines.join('\n'));

    const nav: Record<string, string> = {};
    for (const sec of sectionMeta) {
        const secNodes = byKind.get(sec.kind) || [];
        if (scan.detailsByKind[sec.kind]?.length) nav[sec.id] = sec.kind;
        // Also allow clicking individual nodes to drill into their section.
        for (const n of secNodes) {
            nav[n.label] = sec.kind;
            nav[n.id] = sec.kind;
        }
    }
    nav.Modules = 'modules';
    nav['Modules'] = 'modules';
    nav.Domains = 'domains';
    nav['Domains'] = 'domains';
    if (hasRoutes) {
        nav['Routes'] = 'routes';
        nav['routes'] = 'routes';
    }
    if (hasDeadCode) {
        nav['DeadCode'] = 'deadcode';
        nav['deadcode'] = 'deadcode';
    }
    navByViewId.overview = nav;
    openByViewId.overview = {};

    // Generate Domains view (Now LLM powered)
    const domainView = await buildSubsystemDomainView(scan);
    views.domains = domainView.mermaid;
    openByViewId.domains = domainView.openMap;
    navByViewId.domains = domainView.navMap;

    // Initialize open maps BEFORE calling buildSectionView so the Mermaid node IDs
    // are populated inside buildSectionView, then merge with buildOpenMapForDetails.
    openByViewId.frontend = buildOpenMapForDetails(scan, 'frontend');
    openByViewId.backend = buildOpenMapForDetails(scan, 'backend');
    openByViewId.datastore = buildOpenMapForDetails(scan, 'datastore');
    openByViewId.external = buildOpenMapForDetails(scan, 'external');

    // Drill-down views: show the concrete nodes found for each section.
    // buildSectionView adds Mermaid node ID keys (e.g. Backend_1_1) into the openMap,
    // which wireClickableNodes needs to match SVG nodes to file-open actions.
    views.frontend = addClassStyling(buildSectionView(scan, 'frontend', 'Frontend', 'Frontend', 'UI:', openByViewId.frontend));
    views.backend = addClassStyling(buildSectionView(scan, 'backend', 'Backend/API', 'Backend', 'API:', openByViewId.backend));
    views.datastore = addClassStyling(buildSectionView(scan, 'datastore', 'Data Store', 'DataStore', 'DB:', openByViewId.datastore));
    views.external = addClassStyling(buildSectionView(scan, 'external', 'External', 'External', 'EXT:', openByViewId.external));

    // No special navigation inside section views for now.
    navByViewId.frontend = buildSymbolsNav(scan, 'frontend');
    navByViewId.backend = buildSymbolsNav(scan, 'backend');
    navByViewId.datastore = buildSymbolsNav(scan, 'datastore');
    navByViewId.external = buildSymbolsNav(scan, 'external');

    // Symbols views per section (click "Objects" to navigate).
    addSymbolsViews(views, navByViewId, openByViewId, scan, 'frontend', 'UI');
    addSymbolsViews(views, navByViewId, openByViewId, scan, 'backend', 'API');
    addSymbolsViews(views, navByViewId, openByViewId, scan, 'datastore', 'DB');
    addSymbolsViews(views, navByViewId, openByViewId, scan, 'external', 'EXT');

    // Route map view.
    let dataFlowMeta: MermaidPreview['dataFlowMeta'] = {};
    if (hasRoutes) {
        const routeView = buildRouteMapView(scan);
        views.routes = routeView.mermaid;
        openByViewId.routes = routeView.openMap;
        navByViewId.routes = routeView.navMap;
        dataFlowMeta = routeView.dataFlowMeta;
    }

    // Dead code view.
    if (hasDeadCode) {
        const dcView = buildDeadCodeView(deadSymbols);
        views.deadcode = dcView.mermaid;
        openByViewId.deadcode = dcView.openMap;
        navByViewId.deadcode = {};
    }

    const fs = require('fs');
    const path = require('path');
    try {
        fs.writeFileSync(path.join(__dirname, '..', 'debug_mermaid.json'), JSON.stringify(views, null, 2));
    } catch (e) { }

    // Symbol trace views are now lazy-loaded via VS Code's reference provider (webview requests them on demand).

    return { startViewId: 'overview', views, navByViewId, openByViewId, catalog, dataFlowMeta };
}

/** Returns a short human-readable role hint for a file based on its path and name. */
function inferFileRole(rel: string, kind: ScanNodeKind): string {
    const r = rel.toLowerCase();
    if (kind === 'frontend') {
        if (/page|screen|view/i.test(r)) return 'page';
        if (/component|widget|card|button|input|modal/i.test(r)) return 'component';
        if (/layout|template/i.test(r)) return 'layout';
        if (/hook|use[A-Z]/i.test(r)) return 'hook';
        if (/store|context|redux|zustand|recoil/i.test(r)) return 'state';
        if (/router|navigation/i.test(r)) return 'router';
        if (/style|css|scss|less/i.test(r)) return 'styles';
        if (/util|helper|format/i.test(r)) return 'utility';
        if (/app\.(ts|tsx|js|jsx|py)$/i.test(r)) return 'entry point';
        return 'UI file';
    }
    if (kind === 'backend') {
        if (/route|router|controller/i.test(r)) return 'router';
        if (/service|manager|handler/i.test(r)) return 'service';
        if (/middleware|guard|interceptor/i.test(r)) return 'middleware';
        if (/model|entity|schema/i.test(r)) return 'model';
        if (/auth|jwt|token|session/i.test(r)) return 'auth';
        if (/util|helper|format/i.test(r)) return 'utility';
        if (/main|app|server|index/i.test(r)) return 'entry point';
        if (/config|settings/i.test(r)) return 'config';
        return 'API file';
    }
    if (kind === 'datastore') {
        if (/migration|seed/i.test(r)) return 'migration';
        if (/model|entity|schema/i.test(r)) return 'model';
        if (/repository|repo|query|dao/i.test(r)) return 'repository';
        if (/connection|pool|client/i.test(r)) return 'connection';
        return 'data file';
    }
    return 'file';
}

function buildSectionView(
    scan: WorkspaceScan,
    kind: ScanNodeKind,
    title: string,
    rootId: string,
    labelPrefix: string,
    openMap?: Record<string, { filePath: string; line: number }>
): string {
    const lines: string[] = [];
    lines.push('flowchart TB');

    const rawDetails = scan.detailsByKind[kind] || [];

    // Filter out build artifacts, chunks, vendored, generated files.
    const NOISE_PATTERNS = [
        /\.chunk\.\w+$/i,
        /\.min\.\w+$/i,
        /\.map$/i,
        /\.bundle\.\w+$/i,
        /\.compiled\.\w+$/i,
        /\.generated\.\w+$/i,
        /[\\/]dist[\\/]/i,
        /[\\/]build[\\/]/i,
        /[\\/]\.next[\\/]/i,
        /[\\/]out[\\/]/i,
        /[\\/]coverage[\\/]/i,
        /[\\/]__pycache__[\\/]/i,
        /[\\/]\.history[\\/]/i,
        /[\\/]node_modules[\\/]/i,
        /[\\/]venv[\\/]/i,
        /[\\/]\.venv[\\/]/i,
        /package-lock\.json$/i,
        /yarn\.lock$/i,
        /pnpm-lock\.yaml$/i,
    ];

    const details = rawDetails.filter(d => {
        const label = (d.label || d.relPath || '').replace(/\\/g, '/');
        return !NOISE_PATTERNS.some(p => p.test(label));
    });

    // Pre-compute symbol counts per file for richer labels.
    const symCountByFile = new Map<string, { funcs: number; classes: number }>();
    for (const s of scan.symbols) {
        const cur = symCountByFile.get(s.filePath) || { funcs: 0, classes: 0 };
        if (s.kind === 'function') cur.funcs++;
        if (s.kind === 'class') cur.classes++;
        symCountByFile.set(s.filePath, cur);
    }

    // Count routes per file.
    const routeCountByFile = new Map<string, number>();
    for (const reg of (scan.frameworkRegistrations || [])) {
        if (reg.kind === 'route' || reg.kind === 'urlpattern') {
            routeCountByFile.set(reg.filePath, (routeCountByFile.get(reg.filePath) || 0) + 1);
        }
    }

    // Summary header node.
    const routeTotal = details.reduce((acc, d) => acc + (d.filePath ? (routeCountByFile.get(d.filePath) || 0) : 0), 0);
    const funcTotal  = details.reduce((acc, d) => acc + (d.filePath ? (symCountByFile.get(d.filePath)?.funcs || 0) : 0), 0);
    const headerLabel = routeTotal > 0
        ? `${title} - ${details.length} files - ${routeTotal} routes - ${funcTotal} fns`
        : `${title} - ${details.length} files - ${funcTotal} fns`;
    const safeHeader = headerLabel.replace(/"/g, "'").replace(/\r?\n/g, ' ');
    lines.push(`  ${rootId}["${safeHeader}"]`);
    lines.push(`  style ${rootId} fill:#e0e7ff,stroke:#6366f1,stroke-width:2px,color:#1e1b4b,font-weight:bold`);

    if (details.length === 0) {
        lines.push(`  ${rootId} --> Empty[No ${escapeMermaidLabel(title)} source files detected]`);
        return lines.join('\n');
    }

    // Group by top-level directory.
    const groups = new Map<string, Array<{ rel: string; fileName: string; filePath?: string; role: string; symInfo: string }>>(); 
    for (const d of details) {
        const rel = (d.relPath || d.label).replace(/\\/g, '/');
        const top = rel.includes('/') ? rel.split('/')[0] : '(root)';
        const fileName = rel.includes('/') ? rel.split('/').pop() || rel : rel;
        const role = inferFileRole(rel, kind);
        // Build a compact symbol info badge: e.g. "3fn" or "1cls 5fn" or "2routes"
        const counts = d.filePath ? symCountByFile.get(d.filePath) : undefined;
        const routes = d.filePath ? (routeCountByFile.get(d.filePath) || 0) : 0;
        const badges: string[] = [];
        if (routes > 0) badges.push(`${routes} route${routes > 1 ? 's' : ''}`);
        if (counts?.classes) badges.push(`${counts.classes} class${counts.classes > 1 ? 'es' : ''}`);
        if (counts?.funcs) badges.push(`${counts.funcs} fn${counts.funcs > 1 ? 's' : ''}`);
        const symInfo = badges.join(', ');
        const list = groups.get(top) || [];
        list.push({ rel, fileName, filePath: d.filePath, role, symInfo });
        groups.set(top, list);
    }

    const groupNames = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
    const maxGroups = 8;
    const shownGroups = groupNames.slice(0, maxGroups);
    const hiddenGroups = groupNames.length - shownGroups.length;

    let groupIndex = 0;
    for (const groupName of shownGroups) {
        groupIndex++;
        const groupId = toMermaidId(`${rootId}_grp_${groupIndex}`);
        lines.push(`  ${rootId} --> ${groupId}`);
        lines.push(`  subgraph ${groupId}["📂 ${escapeMermaidLabel(groupName)}"]`);
        lines.push('    direction LR');

        const items = (groups.get(groupName) || []).slice(0, 8);
        const nodeIds: string[] = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const id = toMermaidId(`${rootId}_${groupIndex}_${i + 1}`);
            nodeIds.push(id);
            // Rich label inside a Mermaid quoted node ["..."]:
            // Only escape double-quotes and newlines — NOT brackets or dots.
            const roleTag = item.role ? ` [${item.role}]` : '';
            const symTag = item.symInfo ? ` | ${item.symInfo}` : '';
            const rawLabel = `${item.fileName}${roleTag}${symTag}`;
            // Safe for Mermaid quoted strings: escape only double-quotes.
            const safeLabel = rawLabel.replace(/"/g, "'").replace(/\r?\n/g, ' ');
            lines.push(`    ${id}["${safeLabel}"]`);

            if (openMap && item.filePath) {
                openMap[id] = { filePath: item.filePath, line: 1 };
                openMap[item.fileName] = { filePath: item.filePath, line: 1 };
            }
        }

        // No arrow chains between nodes — let Mermaid auto-layout them side-by-side.

        const extra = (groups.get(groupName) || []).length - items.length;
        if (extra > 0) {
            const moreId = toMermaidId(`${rootId}_${groupIndex}_more`);
            lines.push(`    ${moreId}["+${extra} more..."]`);
        }

        lines.push('  end');
    }

    if (hiddenGroups > 0) {
        const moreGroupsId = toMermaidId(`${rootId}_more_groups`);
        lines.push(`  ${rootId} --> ${moreGroupsId}["+${hiddenGroups} more folder${hiddenGroups > 1 ? 's' : ''}..."]`);
    }

    return lines.join('\n');
}

function escapeHtml(text: string): string {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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
        .replace(/[\[\]\{\}\(\)]/g, ' ')
        .replace(/[<>`"']/g, ' ')
        .replace(/→/g, '->')
        .replace(/·/g, '-')
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
        classLines.push(`class ${ids.join(',')} ${className}`);
    }

    if (classLines.length === 0) return mermaidCode;

    const defs = [
        '',
        '%% Styling injected by @mapper',
        'classDef frontend fill:#bbf7d0,stroke:#059669,stroke-width:2px,color:#064e3b,font-weight:bold;',
        'classDef service fill:#ddd6fe,stroke:#7c3aed,stroke-width:2px,color:#2e1065,font-weight:bold;',
        'classDef db fill:#bae6fd,stroke:#0369a1,stroke-width:2px,color:#0c4a6e,font-weight:bold;',
        'classDef cache fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#713f12,font-weight:bold;',
        'classDef external fill:#fecdd3,stroke:#e11d48,stroke-width:2px,color:#881337,font-weight:bold,stroke-dasharray: 5 3;',
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
function openMermaidPreview(preview: MermaidPreview, rootPath: string) {
    const panel = vscode.window.createWebviewPanel(
        'mermaidPreview', 'Architecture Map', vscode.ViewColumn.Two, { enableScripts: true }
    );

    const base64Payload = Buffer.from(JSON.stringify(preview)).toString('base64');
    const nonce = getNonce();

    // Map viewId -> symbol identity, so the webview can lazily request traces by view id.
    const viewInfoByViewId = new Map<string, { stableKey: string; defFilePath: string; defLine: number }>();
    try {
        for (const f of (preview.catalog?.files || [])) {
            const list = (preview.catalog?.symbolsByFile && preview.catalog.symbolsByFile[f.relPath]) ? preview.catalog.symbolsByFile[f.relPath] : [];
            for (const s of list) {
                if (!s.viewId || !s.stableKey) continue;
                viewInfoByViewId.set(s.viewId, { stableKey: s.stableKey, defFilePath: s.defFilePath, defLine: s.defLine || 1 });
            }
        }
    } catch {
        // ignore
    }

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
            return;
        }

        if (message.type === 'fileSymbols' && message.filePath) {
            try {
                const filePath = String(message.filePath);
                const relPath = String(message.relPath || path.relative(rootPath, filePath).replace(/\\/g, '/'));
                const syms = await getTopLevelSymbolsForFile(rootPath, filePath);
                panel.webview.postMessage({ type: 'fileSymbolsResult', relPath, filePath, symbols: syms });
            } catch (err: any) {
                panel.webview.postMessage({ type: 'error', message: `@mapper: Failed to load symbols: ${err?.message || String(err)}` });
            }
            return;
        }

        if (message.type === 'moduleView') {
            try {
                const res = await buildModuleImportMapView(rootPath);
                panel.webview.postMessage({ type: 'viewResult', viewId: res.viewId, mermaid: res.mermaid, openMap: res.openMap });
            } catch (err: any) {
                panel.webview.postMessage({ type: 'error', message: `@mapper: Failed to build import map: ${err?.message || String(err)}` });
            }
            return;
        }

        if (message.type === 'traceSymbol') {
            try {
                const filePath = String(message.filePath || '');
                const kind = String(message.kind || 'function') as SymbolKind;
                const name = String(message.name || '');
                const defLine = Number(message.defLine || message.line || 1);
                const defChar = Number(message.defChar || message.character || 0);
                if (!filePath || !name) throw new Error('Missing symbol identity for tracing.');

                const res = await buildSymbolTraceViewFromPosition(rootPath, filePath, kind, name, defLine, defChar);
                panel.webview.postMessage({ type: 'viewResult', viewId: res.viewId, mermaid: res.mermaid, openMap: res.openMap });
            } catch (err: any) {
                panel.webview.postMessage({ type: 'error', message: `@mapper: Trace failed: ${err?.message || String(err)}` });
            }
            return;
        }

        if (message.type === 'dataFlow') {
            try {
                const filePath = String(message.filePath || '');
                const handlerName = String(message.handlerName || '');
                const routeLabel = String(message.routeLabel || '');
                const handlerLine = Number(message.handlerLine || message.line || 1);
                if (!filePath || !handlerName) throw new Error('Missing handler identity for data flow tracing.');

                const res = await buildDataFlowForRoute(rootPath, filePath, handlerName, routeLabel, handlerLine);
                panel.webview.postMessage({ type: 'viewResult', viewId: res.viewId, mermaid: res.mermaid, openMap: res.openMap });
            } catch (err: any) {
                panel.webview.postMessage({ type: 'error', message: `@mapper: Data flow trace failed: ${err?.message || String(err)}` });
            }
            return;
        }

        if (message.type === 'requestView' && message.viewId) {
            try {
                const viewId = String(message.viewId);
                const hit = viewInfoByViewId.get(viewId);
                if (!hit) throw new Error('Unknown view id');

                // stableKey format: kind:name:relPath:line
                const parts = String(hit.stableKey || '').split(':');
                const kind = (parts[0] || 'function') as SymbolKind;
                const name = parts[1] || 'symbol';
                const relPath = parts.slice(2, parts.length - 1).join(':') || path.relative(rootPath, hit.defFilePath).replace(/\\/g, '/');
                const defLine = Number(parts[parts.length - 1] || hit.defLine || 1);
                const filePath = hit.defFilePath || path.join(rootPath, relPath.replace(/\//g, path.sep));

                const res = await buildSymbolTraceViewFromPosition(rootPath, filePath, kind, name, defLine, 0);
                panel.webview.postMessage({ type: 'viewResult', viewId, mermaid: res.mermaid, openMap: res.openMap });
            } catch (err: any) {
                panel.webview.postMessage({ type: 'error', message: `@mapper: Could not build view: ${err?.message || String(err)}` });
            }
            return;
        }

        if (message.type === 'scrumView') {
            try {
                await detectScrumCompletions(rootPath);
                const goals = getScrumGoals(rootPath);
                panel.webview.postMessage({ type: 'scrumResult', goals });
            } catch(e: any) {
                panel.webview.postMessage({ type: 'error', message: `@mapper: Scrum check failed: ${e?.message || String(e)}` });
            }
            return;
        }

        if (message.type === 'addGoal') {
            try {
                const title = String(message.title || '').trim();
                if (title) {
                    const goals = getScrumGoals(rootPath);
                    goals.push({ 
                        id: Math.random().toString(36).substring(2, 9), 
                        title, 
                        completed: false, 
                        createdAt: new Date().toISOString() 
                    });
                    saveScrumGoals(rootPath, goals);
                    panel.webview.postMessage({ type: 'scrumResult', goals });
                }
            } catch(e: any) {
                panel.webview.postMessage({ type: 'error', message: `@mapper: Add goal failed: ${e?.message || String(e)}` });
            }
            return;
        }
    });

    panel.webview.html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net;">
            <style>
                :root {
                    --bg: #0f111a;
                    --fg: #e2e8f0;
                    --border: rgba(255, 255, 255, 0.15);
                    --btn-bg: rgba(255, 255, 255, 0.12);
                    --btn-fg: #ffffff;
                    --btn-hover: rgba(255, 255, 255, 0.2);
                    --accent: #6366f1;
                    --accent-glow: rgba(99, 102, 241, 0.4);
                    --input-bg: rgba(15, 17, 26, 0.8);
                    --input-fg: #e2e8f0;
                    --input-border: rgba(255, 255, 255, 0.15);
                    --muted: #94a3b8;
                }
                body { 
                    background: radial-gradient(circle at 50% 0%, #1e1b4b, #0f111a 80%); 
                    background-attachment: fixed;
                    color: var(--fg); margin: 0; padding: 0; overflow: hidden; height: 100vh; width: 100vw; 
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; 
                    font-size: 13px; 
                    -webkit-font-smoothing: antialiased;
                }
                /* Webkit scrollbar for sleek dark mode */
                ::-webkit-scrollbar { width: 8px; height: 8px; }
                ::-webkit-scrollbar-track { background: transparent; }
                ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.2); border-radius: 4px; }
                ::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.3); }

                #controls {
                    position: absolute; top: 0; left: 0; right: 0; z-index: 100;
                    background: rgba(15, 17, 26, 0.65); 
                    backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
                    border-bottom: 1px solid var(--border);
                    padding: 12px 18px; 
                    display: flex; gap: 16px; align-items: center; flex-wrap: wrap;
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
                }
                button {
                    border: 1px solid rgba(255, 255, 255, 0.2); background: var(--btn-bg); color: var(--btn-fg);
                    padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600;
                    transition: all 0.2s ease; box-shadow: 0 1px 3px rgba(0,0,0,0.3);
                }
                button:hover:not([disabled]) { 
                    background: var(--btn-hover); border-color: rgba(255, 255, 255, 0.4); 
                    transform: translateY(-1px);
                    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);
                }
                #traceBtn:hover:not([disabled]) {
                    background: var(--accent); border-color: #818cf8;
                    box-shadow: 0 0 12px var(--accent-glow);
                }
                button[disabled] { opacity: 0.4; cursor: not-allowed; }
                
                #title { font-weight: 700; font-size: 14px; color: var(--fg); text-shadow: 0 1px 2px rgba(0,0,0,0.5); }
                #breadcrumb { font-size: 11px; color: #cbd5e1; margin-top: 2px; }
                #hint { font-size: 11px; color: var(--muted); margin-top: 2px; }
                
                #picker { display: flex; gap: 8px; align-items: center; margin-left: auto; }
                #picker select {
                    font-size: 12px; padding: 6px 10px; max-width: 250px;
                    background: var(--input-bg); color: var(--input-fg); 
                    border: 1px solid var(--input-border); border-radius: 5px;
                    outline: none; transition: border-color 0.2s;
                    appearance: none;
                    background-image: url("data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20fill%3D%22%2394a3b8%22%20viewBox%3D%220%200%2016%2016%22%3E%3Cpath%20d%3D%22M8%2011L3%206h10l-5%205z%22%2F%3E%3C%2Fsvg%3E");
                    background-repeat: no-repeat; background-position: right 8px center; padding-right: 28px;
                }
                #picker select:hover:not([disabled]) { border-color: rgba(255, 255, 255, 0.3); }
                #picker select:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.2); }
                #picker select[disabled] { opacity: 0.4; cursor: not-allowed; }

                #legend {
                    display: flex; gap: 10px; align-items: center; font-size: 11px; margin-left: 10px;
                }
                #legend .chip {
                    display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; 
                    border-radius: 4px; font-weight: 600; text-shadow: none;
                    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.1);
                }
                /* Needy pastel chips for dark mode */
                .chip-frontend { background: rgba(16, 185, 129, 0.15); color: #6ee7b7; border: 1px solid rgba(16, 185, 129, 0.3); }
                .chip-backend  { background: rgba(139, 92, 246, 0.15); color: #c4b5fd; border: 1px solid rgba(139, 92, 246, 0.3); }
                .chip-db       { background: rgba(14, 165, 233, 0.15); color: #7dd3fc; border: 1px solid rgba(14, 165, 233, 0.3); }
                .chip-cache    { background: rgba(234, 179, 8, 0.15); color: #fdf08a; border: 1px solid rgba(234, 179, 8, 0.3); }
                .chip-external { background: rgba(225, 29, 72, 0.15); color: #fda4af; border: 1px solid rgba(225, 29, 72, 0.3); border-style: dashed; }
                
                #diagram-container { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; padding-top: 60px; box-sizing: border-box; }
                svg { width: 100% !important; height: 100% !important; transition: opacity 0.3s; }
                .clickable { cursor: pointer; }
                .clickable:hover rect, .clickable:hover polygon, .clickable:hover circle, .clickable:hover path { 
                    filter: brightness(1.15) drop-shadow(0 0 6px rgba(255, 255, 255, 0.2)); 
                }
                
                /* Scrum UI Styles */
                .scrum-board { display: flex; gap: 20px; padding: 20px; min-height: calc(100vh - 100px); align-items: flex-start; justify-content: center; }
                .scrum-col { width: 400px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 12px; padding: 18px; min-height: 500px; display: flex; flex-direction: column; gap: 14px; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.02); }
                .scrum-col-title { font-weight: 700; font-size: 15px; color: var(--fg); margin-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 12px; display: flex; justify-content: space-between; align-items: center; }
                .scrum-card { background: rgba(15, 17, 26, 0.9); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 14px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); transition: transform 0.2s; }
                .scrum-card:hover { transform: translateY(-2px); border-color: rgba(255,255,255,0.2); }
                .scrum-card.completed { border-color: rgba(16, 185, 129, 0.5); background: linear-gradient(180deg, rgba(16,185,129,0.05) 0%, rgba(15,17,26,0.9) 100%); }
                .scrum-card-title { font-weight: 600; font-size: 14px; margin-bottom: 12px; line-height: 1.4; }
                .scrum-meta { font-size: 11px; color: var(--muted); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
                .scrum-input { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15); color: #fff; padding: 10px 12px; border-radius: 6px; width: calc(100% - 26px); outline: none; margin-bottom: 4px; font-size: 13px; font-family: inherit; }
                .scrum-input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-glow); }
                .badge { background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.3); color: #6ee7b7; padding: 3px 8px; border-radius: 5px; font-weight: 600; font-size: 10px; }
            </style>
        </head>
        <body>
            <div id="controls">
                <button id="backBtn" disabled>← Back</button>
                <div>
                    <div id="title">🗺️ @mapper Architecture</div>
                    <div id="breadcrumb"></div>
                    <div id="hint">Click sections to explore · Scroll to Zoom · Drag to Pan</div>
                </div>
                <div id="legend">
                    <span class="chip chip-frontend">💻 Frontend</span>
                    <span class="chip chip-backend">⚙️ Backend</span>
                    <span class="chip chip-db">🗄️ Data</span>
                    <span class="chip chip-external">🌐 External</span>
                    <button id="scrumBtn" style="margin-left: 12px; background: rgba(99, 102, 241, 0.2); border-color: #6366f1; color: #c4b5fd;">📋 Scrum Tracker</button>
                </div>
                <div id="picker" title="Jump to top-level object">
                    <select id="fileSelect">
                        <option value="">📂 Source File...</option>
                    </select>
                    <select id="symbolSelect" disabled>
                        <option value="">🔍 Symbol...</option>
                    </select>
                    <button id="traceBtn" disabled>Trace</button>
                    <button id="openBtn" disabled>Open code</button>
                </div>
            </div>
            <div id="diagram-container">
                <div id="status" style="color: var(--muted); font-size: 14px; display: flex; align-items: center; gap: 8px;">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: spin 2s linear infinite;"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="4.93" x2="19.07" y2="7.76"></line></svg>
                    <span>Preparing Canvas...</span>
                </div>
            </div>
            <div id="scrum-container" style="display:none; width: 100%; height: 100%; padding-top: 70px; overflow-y: auto; box-sizing: border-box; background: var(--bg);">
                <div class="scrum-board">
                    <div class="scrum-col" id="col-todo">
                        <div class="scrum-col-title"><span>📌 To Do / Active</span> <span id="todo-count" style="color:#64748b; font-size:12px;">0</span></div>
                        <input type="text" id="newGoalInput" class="scrum-input" placeholder="Type a new goal and press Enter...">
                        <div id="scrum-todo-list" style="display:flex; flex-direction:column; gap:12px;"></div>
                    </div>
                    <div class="scrum-col" id="col-done">
                        <div class="scrum-col-title"><span>✅ Ready for Review</span> <span id="done-count" style="color:#64748b; font-size:12px;">0</span></div>
                        <div id="scrum-done-list" style="display:flex; flex-direction:column; gap:12px;"></div>
                    </div>
                </div>
            </div>
            <style>@keyframes spin { 100% { transform: rotate(360deg); } }</style>

            <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.1/dist/svg-pan-zoom.min.js"></script>
            <script nonce="${nonce}" type="module">
                const container = document.getElementById('diagram-container');
                const backBtn = document.getElementById('backBtn');
                const titleEl = document.getElementById('title');
                const hintEl = document.getElementById('hint');
                const breadcrumbEl = document.getElementById('breadcrumb');
                const vscode = acquireVsCodeApi();
                const fileSelect = document.getElementById('fileSelect');
                const symbolSelect = document.getElementById('symbolSelect');
                const traceBtn = document.getElementById('traceBtn');
                const openBtn = document.getElementById('openBtn');
                const scrumBtn = document.getElementById('scrumBtn');
                const scrumContainer = document.getElementById('scrum-container');
                const newGoalInput = document.getElementById('newGoalInput');

                function showError(message) {
                    container.innerHTML = "<div style='color:red; padding:20px; max-width: 900px;'><b>Render Error:</b><br/>" + message + "</div>";
                }

                (async () => {
                    try {
                        // Dynamic import so we can surface module-load errors in the UI.
                        const mod = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs');
                        const mermaid = mod.default ?? mod;
                        // Force premium dark mode aesthetic on the Mermaid canvas.
                        mermaid.initialize({ 
                            startOnLoad: false, 
                            theme: 'base',
                            themeVariables: {
                                fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
                                primaryColor: 'rgba(255,255,255,0.03)',
                                primaryTextColor: '#e2e8f0',
                                primaryBorderColor: 'rgba(255,255,255,0.15)',
                                lineColor: 'rgba(203,213,225,0.4)',
                                secondaryColor: 'rgba(99,102,241,0.15)',
                                tertiaryColor: 'transparent',
                                nodeBorder: 'rgba(255,255,255,0.3)',
                                clusterBkg: 'rgba(255,255,255,0.02)',
                                clusterBorder: 'rgba(255,255,255,0.1)'
                            }
                        });

                        const bstr = atob('${base64Payload}');
                        const u8 = new Uint8Array(bstr.length);
                        for (let i = 0; i < bstr.length; i++) {
                            u8[i] = bstr.charCodeAt(i);
                        }
                        const payload = JSON.parse(new TextDecoder().decode(u8));
                        const views = payload.views || {};
                        const navByViewId = payload.navByViewId || {};
                        const openByViewId = payload.openByViewId || {};
                        const catalog = payload.catalog || { files: [], symbolsByFile: {} };
                        let currentViewId = payload.startViewId || 'overview';
                        const stack = [];
                        let panZoomInstance = null;
                        let selectedFile = null;
                        let selectedSymbol = null;

                        function clearSelect(selectEl, placeholder) {
                            selectEl.innerHTML = '';
                            const opt = document.createElement('option');
                            opt.value = '';
                            opt.textContent = placeholder;
                            selectEl.appendChild(opt);
                        }

                        function populateFileSelect() {
                            clearSelect(fileSelect, 'File...');
                            const files = (catalog.files || []).slice().sort((a, b) => (a.relPath || '').localeCompare(b.relPath || ''));
                            for (const f of files) {
                                const opt = document.createElement('option');
                                opt.value = f.relPath;
                                // Avoid nested template literals inside the outer webview HTML template string.
                                opt.textContent = f.relPath + "  (C" + f.classCount + " F" + f.functionCount + " V" + f.variableCount + ")";
                                opt.dataset.filePath = f.filePath;
                                fileSelect.appendChild(opt);
                            }
                        }

                        function populateSymbolSelect(relPath) {
                            clearSelect(symbolSelect, 'Object...');
                            const list = (window.__fileSymbolsCache && window.__fileSymbolsCache[relPath])
                                ? window.__fileSymbolsCache[relPath]
                                : ((catalog.symbolsByFile && catalog.symbolsByFile[relPath]) ? catalog.symbolsByFile[relPath] : []);
                            if (!list.length) {
                                symbolSelect.disabled = true;
                                traceBtn.disabled = true;
                                return;
                            }

                            // Group by kind.
                            const kinds = { class: [], function: [], variable: [] };
                            for (const s of list) {
                                if (kinds[s.kind]) kinds[s.kind].push(s);
                            }

                            const addGroup = (label, items) => {
                                if (!items.length) return;
                                items.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
                                const og = document.createElement('optgroup');
                                og.label = label;
                                for (const s of items) {
                                    const opt = document.createElement('option');
                                    opt.value = s.viewId;
                                    // Avoid nested template literals inside the outer webview HTML template string.
                                    opt.textContent = s.kind + ": " + s.name;
                                    opt.dataset.defFilePath = s.defFilePath;
                                    opt.dataset.defLine = String(s.defLine || 1);
                                    opt.dataset.defChar = String(s.defChar || 0);
                                    opt.dataset.stableKey = s.stableKey || '';
                                    opt.dataset.kind = s.kind;
                                    opt.dataset.name = s.name;
                                    og.appendChild(opt);
                                }
                                symbolSelect.appendChild(og);
                            };

                            addGroup('Classes', kinds.class);
                            addGroup('Functions', kinds.function);
                            addGroup('Variables', kinds.variable);

                            symbolSelect.disabled = false;
                        }

                        async function renderView(viewId, pushStack) {
                            if (scrumContainer) scrumContainer.style.display = 'none';
                            if (container) container.style.display = 'flex';
                            
                            const code = views[viewId];
                            if (!code) {
                                if (String(viewId || '').startsWith('symbol_')) {
                                    container.innerHTML = "<div style='padding:20px; color: var(--muted);'>Loading trace...</div>";
                                    vscode.postMessage({ type: 'requestView', viewId: viewId });
                                    return;
                                }
                                if (String(viewId || '').startsWith('dataflow_')) {
                                    container.innerHTML = "<div style='padding:20px; color: var(--muted);'>🛤️ Tracing data flow...</div>";
                                    var meta = window.__dataFlowMeta && window.__dataFlowMeta[viewId];
                                    if (meta) {
                                        vscode.postMessage({ type: 'dataFlow', filePath: meta.filePath, handlerName: meta.handlerName, routeLabel: meta.routeLabel, handlerLine: meta.handlerLine });
                                    } else {
                                        vscode.postMessage({ type: 'requestView', viewId: viewId });
                                    }
                                    return;
                                }
                                if (String(viewId || '') === 'modules') {
                                    container.innerHTML = "<div style='padding:20px; color: var(--muted);'>Building import map...</div>";
                                    vscode.postMessage({ type: 'moduleView', scope: 'workspace' });
                                    return;
                                }
                                throw new Error("Missing Mermaid view: " + viewId);
                            }

                            // ── HTML view (e.g. Domains page) ──
                            if (code.startsWith('<!--html-->')) {
                                if (pushStack) stack.push(currentViewId);
                                currentViewId = viewId;
                                backBtn.disabled = stack.length === 0;
                                var prettyNamesH = { overview: 'Architecture Overview', frontend: 'Frontend', backend: 'Backend / API', datastore: 'Data Store', external: 'External Services', modules: 'Module Import Map', routes: 'API Routes', deadcode: 'Dead Code', domains: 'Subsystems / Domains' };
                                titleEl.textContent = '\u{1F5FA}\u{FE0F} ' + (prettyNamesH[viewId] || viewId);
                                breadcrumbEl.textContent = stack.slice().concat([viewId]).map(function(v){return prettyNamesH[v]||v;}).join(' \u203A ');
                                hintEl.textContent = 'Click a file card to open it in the editor';
                                try { panZoomInstance && panZoomInstance.destroy && panZoomInstance.destroy(); } catch {}
                                panZoomInstance = null;
                                // Strip the sentinel prefix and inject the HTML.
                                var htmlContent = code.replace('<!--html-->', '');
                                container.style.overflowY = 'auto';
                                container.style.alignItems = 'flex-start';
                                container.style.justifyContent = 'flex-start';
                                container.innerHTML = htmlContent;
                                // Store vscodeApi ref so inline click scripts can use it.
                                window.__vscodeApi = vscode;
                                // Re-run any embedded <script id="__domScript"> tags.
                                var sc = container.querySelector('#__domScript');
                                if (sc) { try { (new Function(sc.textContent || ''))(); } catch {} }
                                // After rendering HTML view, reset container style on next Mermaid render.
                                return;
                            }

                            if (pushStack) stack.push(currentViewId);
                            currentViewId = viewId;

                            backBtn.disabled = stack.length === 0;

                            // Pretty view name for the title.
                            var prettyNames = { overview: 'Architecture Overview', frontend: 'Frontend', backend: 'Backend / API', datastore: 'Data Store', external: 'External Services', modules: 'Module Import Map', routes: 'API Routes', deadcode: 'Dead Code' };
                            var viewName = prettyNames[viewId] || viewId;
                            titleEl.textContent = viewId === 'overview' ? '\u{1F5FA}\u{FE0F} @mapper Architecture' : '\u{1F5FA}\u{FE0F} ' + viewName;

                            // Breadcrumb trail.
                            var trail = stack.slice().concat([viewId]);
                            breadcrumbEl.textContent = trail.map(function(v) { return prettyNames[v] || v; }).join(' \u203A ');

                            // Render fresh SVG. Reset any styles set by HTML views.
                            container.style.overflowY = '';
                            container.style.alignItems = '';
                            container.style.justifyContent = '';
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
                                    ? 'Click a section to drill down \u00B7 Scroll to Zoom \u00B7 Drag to Pan'
                                    : ('No clickable sections detected. Nodes: ' + Array.from(svgElement.querySelectorAll('g.node, g[class*="node"]')).slice(0, 6).map((g) => (g.querySelector('title')?.textContent || g.id || '(no id)')).join(', '));
                            } else {
                                hintEl.textContent = 'Click nodes to explore \u00B7 Scroll to Zoom \u00B7 Drag to Pan';
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

                        fileSelect.addEventListener('change', () => {
                            selectedFile = fileSelect.value || null;
                            selectedSymbol = null;

                            // Ask the extension for accurate symbols (DocumentSymbolProvider) for this file.
                            try {
                                const opt = fileSelect.selectedOptions && fileSelect.selectedOptions[0];
                                const fp = opt ? opt.dataset.filePath : null;
                                if (fp && selectedFile) {
                                    vscode.postMessage({ type: 'fileSymbols', filePath: fp, relPath: selectedFile });
                                }
                            } catch {}

                            populateSymbolSelect(selectedFile);
                            traceBtn.disabled = true;
                            openBtn.disabled = !selectedFile;
                        });

                        symbolSelect.addEventListener('change', () => {
                            selectedSymbol = symbolSelect.value || null;
                            traceBtn.disabled = !selectedSymbol;
                        });

                        traceBtn.addEventListener('click', () => {
                            if (!selectedSymbol) return;
                            const opt = symbolSelect.selectedOptions && symbolSelect.selectedOptions[0];
                            if (!opt) return;
                            const fp = opt.dataset.defFilePath;
                            const line = Number(opt.dataset.defLine || '1');
                            const ch = Number(opt.dataset.defChar || '0');
                            const kind = opt.dataset.kind || '';
                            const name = opt.dataset.name || '';
                            if (fp && kind && name) {
                                container.innerHTML = "<div style='padding:20px; color:#475569;'>Tracing references...</div>";
                                vscode.postMessage({ type: 'traceSymbol', viewId: selectedSymbol, filePath: fp, defLine: line, defChar: ch, kind: kind, name: name });
                                return;
                            }
                            renderView(selectedSymbol, true).catch((err) => showError(err.message || String(err)));
                        });

                        openBtn.addEventListener('click', () => {
                            if (!selectedFile) return;
                            const opt = fileSelect.selectedOptions && fileSelect.selectedOptions[0];
                            const fp = opt ? opt.dataset.filePath : null;
                            if (!fp) return;
                            vscode.postMessage({ type: 'open', filePath: fp, line: 1 });
                        });

                        scrumBtn.addEventListener('click', () => {
                            stack.push(currentViewId); backBtn.disabled = stack.length === 0;
                            container.style.display = 'none';
                            scrumContainer.style.display = 'block';
                            titleEl.textContent = '📋 Scrum Tracker';
                            breadcrumbEl.textContent = 'Active Goals mapping to Git';
                            hintEl.textContent = 'Auto-detecting completions...';
                            vscode.postMessage({ type: 'scrumView' });
                        });

                        newGoalInput.addEventListener('keypress', (e) => {
                            if (e.key === 'Enter' && newGoalInput.value.trim()) {
                                vscode.postMessage({ type: 'addGoal', title: newGoalInput.value.trim() });
                                newGoalInput.value = '';
                                newGoalInput.placeholder = 'Adding...';
                            }
                        });

                        populateFileSelect();

                        // Cache of DocumentSymbolProvider results by relPath.
                        window.__fileSymbolsCache = {};
                        // Data flow metadata: stored by the route map view, used for lazy loading data flow views.
                        window.__dataFlowMeta = payload.dataFlowMeta || {};

                        window.addEventListener('message', (event) => {
                            const msg = event && event.data ? event.data : null;
                            if (!msg || typeof msg !== 'object') return;

                            if (msg.type === 'fileSymbolsResult') {
                                try {
                                    const relPath = msg.relPath;
                                    const list = Array.isArray(msg.symbols) ? msg.symbols : [];
                                    window.__fileSymbolsCache[relPath] = list;
                                    if (selectedFile === relPath) {
                                        populateSymbolSelect(relPath);
                                        symbolSelect.disabled = !list.length;
                                    }
                                } catch {}
                            }

                            if (msg.type === 'viewResult') {
                                try {
                                    if (msg.viewId && msg.mermaid) {
                                        views[msg.viewId] = msg.mermaid;
                                        openByViewId[msg.viewId] = msg.openMap || {};
                                        navByViewId[msg.viewId] = navByViewId[msg.viewId] || {};
                                        renderView(msg.viewId, true).catch((err) => showError(err.message || String(err)));
                                    }
                                } catch (e) {
                                    showError(e?.message || String(e));
                                }
                            }

                            if (msg.type === 'scrumResult') {
                                const listTodo = document.getElementById('scrum-todo-list');
                                const listDone = document.getElementById('scrum-done-list');
                                const cTodo = document.getElementById('todo-count');
                                const cDone = document.getElementById('done-count');
                                if (listTodo) listTodo.innerHTML = ''; 
                                if (listDone) listDone.innerHTML = '';
                                let td = 0, dn = 0;
                                
                                (msg.goals || []).forEach(g => {
                                    const d = new Date(g.createdAt).toLocaleDateString();
                                    const meta = g.completed ? 
                                        '<span class="badge">Autocompleted By ' + (g.completedBy || 'Unknown') + '</span> <span style="font-family:monospace;">' + (g.commitHash ? g.commitHash.slice(0,7) : '') + '</span>' : 
                                        '<span>' + d + '</span>';
                                    
                                    const card = '<div class="scrum-card ' + (g.completed ? 'completed' : '') + '">' +
                                        '<div class="scrum-card-title">' + g.title + '</div>' +
                                        '<div class="scrum-meta">' + meta + '</div>' +
                                    '</div>';
                                    
                                    if (g.completed) { if (listDone) listDone.innerHTML += card; dn++; } 
                                    else { if (listTodo) listTodo.innerHTML += card; td++; }
                                });
                                if (cTodo) cTodo.textContent = td;
                                if (cDone) cDone.textContent = dn;
                                if (newGoalInput) newGoalInput.placeholder = 'Type a new goal and press Enter...';
                            }

                            if (msg.type === 'error') {
                                showError(msg.message || 'Unknown error');
                            }
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

export function deactivate() { }
