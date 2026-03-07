/**
 * frameworkDetectors.ts — Framework-specific pattern detection.
 *
 * Detects framework registrations (routes, blueprints, callbacks, etc.)
 * that don't appear as direct function calls but are important
 * architectural signals.
 */

import * as vscode from 'vscode';
import * as path from 'path';

// ──────────────────────── Types ────────────────────────

export type FrameworkType = 'fastapi' | 'streamlit' | 'flask' | 'django' | 'express' | 'nestjs';

export type RegistrationKind =
    | 'route'
    | 'middleware'
    | 'dependency'
    | 'blueprint'
    | 'urlpattern'
    | 'model'
    | 'callback'
    | 'session_key'
    | 'page'
    | 'router_include'
    | 'lifespan'
    | 'view';

export interface FrameworkRegistration {
    framework: FrameworkType;
    kind: RegistrationKind;
    name: string;
    filePath: string;
    relPath: string;
    line: number;
    /** Extra info: HTTP method, blueprint name, session key name, etc. */
    meta?: string;
    /** The handler function/class name for routes. */
    handlerName?: string;
}

// ──────────────────────── Detection Engine ────────────────────────

/**
 * Scan a set of source files and detect framework-specific registrations.
 * Returns an array of registrations sorted by file and line.
 */
export async function detectFrameworkRegistrations(
    rootPath: string,
    fileUris: vscode.Uri[],
    frameworks: Set<string>
): Promise<FrameworkRegistration[]> {
    const registrations: FrameworkRegistration[] = [];

    for (const uri of fileUris) {
        const ext = path.extname(uri.fsPath).toLowerCase();
        let text: string;
        try {
            text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        } catch {
            continue;
        }
        const relPath = path.relative(rootPath, uri.fsPath).replace(/\\/g, '/');

        if (ext === '.py') {
            if (frameworks.has('fastapi')) detectFastAPI(text, uri.fsPath, relPath, registrations);
            if (frameworks.has('streamlit')) detectStreamlit(text, uri.fsPath, relPath, registrations);
            if (frameworks.has('flask')) detectFlask(text, uri.fsPath, relPath, registrations);
            if (frameworks.has('django')) detectDjango(text, uri.fsPath, relPath, registrations);
        }

        if (['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext)) {
            if (frameworks.has('express')) detectExpress(text, uri.fsPath, relPath, registrations);
            if (frameworks.has('nestjs')) detectNestJS(text, uri.fsPath, relPath, registrations);
        }
    }

    registrations.sort((a, b) => a.relPath.localeCompare(b.relPath) || a.line - b.line);
    return registrations;
}

// ──────────────────────── FastAPI ────────────────────────

function detectFastAPI(text: string, filePath: string, relPath: string, out: FrameworkRegistration[]): void {
    const lines = text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Route decorators: @app.get("/path"), @router.post("/path"), etc.
        const routeMatch = line.match(/^\s*@\s*(\w+)\.(get|post|put|delete|patch|options|head|trace|websocket)\s*\(\s*["']([^"']*)/i);
        if (routeMatch) {
            // Look ahead for the handler function name
            let handlerName: string | undefined;
            for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
                const fnMatch = lines[j].match(/^\s*(?:async\s+)?def\s+(\w+)/);
                if (fnMatch) { handlerName = fnMatch[1]; break; }
            }
            out.push({
                framework: 'fastapi',
                kind: 'route',
                name: `${routeMatch[2].toUpperCase()} ${routeMatch[3]}`,
                filePath,
                relPath,
                line: i + 1,
                meta: routeMatch[2].toUpperCase(),
                handlerName,
            });
            continue;
        }

        // Depends() injection.
        const dependsMatch = line.match(/Depends\s*\(\s*([A-Za-z_]\w*)/);
        if (dependsMatch) {
            out.push({
                framework: 'fastapi',
                kind: 'dependency',
                name: dependsMatch[1],
                filePath,
                relPath,
                line: i + 1,
                meta: 'Depends()',
            });
        }

        // Middleware: app.add_middleware(...)
        const mwMatch = line.match(/\.add_middleware\s*\(\s*([A-Za-z_]\w*)/);
        if (mwMatch) {
            out.push({
                framework: 'fastapi',
                kind: 'middleware',
                name: mwMatch[1],
                filePath,
                relPath,
                line: i + 1,
            });
        }

        // Router include: app.include_router(router, prefix=...)
        const includeMatch = line.match(/\.include_router\s*\(\s*([A-Za-z_]\w*)/);
        if (includeMatch) {
            const prefixMatch = line.match(/prefix\s*=\s*["']([^"']*)/);
            out.push({
                framework: 'fastapi',
                kind: 'router_include',
                name: includeMatch[1],
                filePath,
                relPath,
                line: i + 1,
                meta: prefixMatch ? prefixMatch[1] : undefined,
            });
        }

        // Lifespan: @app.on_event("startup") / @asynccontextmanager lifespan
        const lifespanMatch = line.match(/\.on_event\s*\(\s*["'](startup|shutdown)["']/);
        if (lifespanMatch) {
            out.push({
                framework: 'fastapi',
                kind: 'lifespan',
                name: lifespanMatch[1],
                filePath,
                relPath,
                line: i + 1,
            });
        }
    }
}

// ──────────────────────── Streamlit ────────────────────────

function detectStreamlit(text: string, filePath: string, relPath: string, out: FrameworkRegistration[]): void {
    const lines = text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Callbacks: on_click=func, on_change=func
        const callbackMatch = line.match(/\b(on_click|on_change)\s*=\s*([A-Za-z_]\w*)/);
        if (callbackMatch) {
            out.push({
                framework: 'streamlit',
                kind: 'callback',
                name: callbackMatch[2],
                filePath,
                relPath,
                line: i + 1,
                meta: callbackMatch[1],
            });
        }

        // Session state keys: st.session_state["key"] or st.session_state.key
        const sessionMatch = line.match(/st\.session_state\s*[\[.]s*["']?([A-Za-z_]\w*)["']?\]?/);
        if (sessionMatch) {
            out.push({
                framework: 'streamlit',
                kind: 'session_key',
                name: sessionMatch[1],
                filePath,
                relPath,
                line: i + 1,
            });
        }

        // Page links: st.page_link("pages/foo.py")
        const pageLinkMatch = line.match(/st\.page_link\s*\(\s*["']([^"']+)/);
        if (pageLinkMatch) {
            out.push({
                framework: 'streamlit',
                kind: 'page',
                name: pageLinkMatch[1],
                filePath,
                relPath,
                line: i + 1,
            });
        }
    }

    // Detect multipage: check for pages/ directory.
    if (relPath.startsWith('pages/') || relPath.includes('/pages/')) {
        const basename = path.basename(relPath, path.extname(relPath));
        out.push({
            framework: 'streamlit',
            kind: 'page',
            name: basename,
            filePath,
            relPath,
            line: 1,
            meta: 'multipage',
        });
    }
}

// ──────────────────────── Flask ────────────────────────

function detectFlask(text: string, filePath: string, relPath: string, out: FrameworkRegistration[]): void {
    const lines = text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Route decorators: @app.route("/path", methods=[...])
        const routeMatch = line.match(/^\s*@\s*(\w+)\.route\s*\(\s*["']([^"']*)/);
        if (routeMatch) {
            const methodsMatch = line.match(/methods\s*=\s*\[([^\]]+)\]/);
            // Look ahead for the handler function name
            let handlerName: string | undefined;
            for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
                const fnMatch = lines[j].match(/^\s*(?:async\s+)?def\s+(\w+)/);
                if (fnMatch) { handlerName = fnMatch[1]; break; }
            }
            out.push({
                framework: 'flask',
                kind: 'route',
                name: routeMatch[2],
                filePath,
                relPath,
                line: i + 1,
                meta: methodsMatch ? methodsMatch[1].replace(/'/g, '').trim() : 'GET',
                handlerName,
            });
            continue;
        }

        // Blueprint creation: bp = Blueprint("name", __name__)
        const bpMatch = line.match(/=\s*Blueprint\s*\(\s*["']([^"']+)/);
        if (bpMatch) {
            out.push({
                framework: 'flask',
                kind: 'blueprint',
                name: bpMatch[1],
                filePath,
                relPath,
                line: i + 1,
            });
        }

        // register_blueprint: app.register_blueprint(bp, url_prefix=...)
        const regBpMatch = line.match(/\.register_blueprint\s*\(\s*([A-Za-z_]\w*)/);
        if (regBpMatch) {
            const prefixMatch = line.match(/url_prefix\s*=\s*["']([^"']*)/);
            out.push({
                framework: 'flask',
                kind: 'router_include',
                name: regBpMatch[1],
                filePath,
                relPath,
                line: i + 1,
                meta: prefixMatch ? prefixMatch[1] : undefined,
            });
        }
    }
}

// ──────────────────────── Django ────────────────────────

function detectDjango(text: string, filePath: string, relPath: string, out: FrameworkRegistration[]): void {
    const lines = text.split(/\r?\n/);
    const isUrlsFile = /urls\.py$/.test(relPath);
    const isViewsFile = /views\.py$/.test(relPath);
    const isModelsFile = /models\.py$/.test(relPath);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // URL patterns: path("route/", view, name="name")
        if (isUrlsFile) {
            const pathMatch = line.match(/\b(?:path|re_path)\s*\(\s*["']([^"']*)/);
            if (pathMatch) {
                const nameMatch = line.match(/name\s*=\s*["']([^"']+)/);
                // Extract view name: path("url/", views.ViewName.as_view()) or path("url/", view_func)
                const viewMatch = line.match(/["'][^"']*["']\s*,\s*(?:views?\.)?([A-Za-z_]\w*)/);
                out.push({
                    framework: 'django',
                    kind: 'urlpattern',
                    name: pathMatch[1] || '/',
                    filePath,
                    relPath,
                    line: i + 1,
                    meta: nameMatch ? nameMatch[1] : undefined,
                    handlerName: viewMatch ? viewMatch[1] : undefined,
                });
            }
        }

        // Class-based views: class MyView(View) / class MyView(APIView) etc.
        if (isViewsFile) {
            const viewMatch = line.match(/^class\s+([A-Za-z_]\w*)\s*\(.*(?:View|Mixin|APIView|ViewSet)/);
            if (viewMatch) {
                out.push({
                    framework: 'django',
                    kind: 'view',
                    name: viewMatch[1],
                    filePath,
                    relPath,
                    line: i + 1,
                });
            }
        }

        // Models: class MyModel(models.Model)
        if (isModelsFile) {
            const modelMatch = line.match(/^class\s+([A-Za-z_]\w*)\s*\(\s*(?:models\.Model|Model)\s*\)/);
            if (modelMatch) {
                out.push({
                    framework: 'django',
                    kind: 'model',
                    name: modelMatch[1],
                    filePath,
                    relPath,
                    line: i + 1,
                });
            }
        }
    }
}

// ──────────────────────── Express ────────────────────────

function detectExpress(text: string, filePath: string, relPath: string, out: FrameworkRegistration[]): void {
    const lines = text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Route definitions: router.get("/path", ...), app.post("/path", ...)
        const routeMatch = line.match(/\b(\w+)\.(get|post|put|delete|patch|all|use)\s*\(\s*["']([^"']*)/);
        if (routeMatch) {
            const obj = routeMatch[1].toLowerCase();
            if (obj === 'app' || obj === 'router' || obj === 'route') {
                // Try to extract handler name from the same line: app.get("/path", handlerName)
                const handlerMatch = line.match(/["'][^"']*["']\s*,\s*([A-Za-z_]\w*)/);
                out.push({
                    framework: 'express',
                    kind: routeMatch[2] === 'use' ? 'middleware' : 'route',
                    name: `${routeMatch[2].toUpperCase()} ${routeMatch[3]}`,
                    filePath,
                    relPath,
                    line: i + 1,
                    meta: routeMatch[2].toUpperCase(),
                    handlerName: handlerMatch ? handlerMatch[1] : undefined,
                });
            }
        }

        // Router mounting: app.use("/api", router)
        const mountMatch = line.match(/\bapp\.use\s*\(\s*["']([^"']+)["']\s*,\s*([A-Za-z_]\w*)/);
        if (mountMatch) {
            out.push({
                framework: 'express',
                kind: 'router_include',
                name: mountMatch[2],
                filePath,
                relPath,
                line: i + 1,
                meta: mountMatch[1],
            });
        }
    }
}

// ──────────────────────── NestJS ────────────────────────

function detectNestJS(text: string, filePath: string, relPath: string, out: FrameworkRegistration[]): void {
    const lines = text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Route decorators: @Get("/path"), @Post("/path"), etc.
        const routeMatch = line.match(/^\s*@(Get|Post|Put|Delete|Patch|All)\s*\(\s*["']?([^"')]*)/);
        if (routeMatch) {
            // Look ahead for the handler method name
            let handlerName: string | undefined;
            for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
                const fnMatch = lines[j].match(/^\s*(?:async\s+)?(\w+)\s*\(/);
                if (fnMatch && !fnMatch[1].startsWith('@')) { handlerName = fnMatch[1]; break; }
            }
            out.push({
                framework: 'nestjs',
                kind: 'route',
                name: `${routeMatch[1].toUpperCase()} ${routeMatch[2] || '/'}`,
                filePath,
                relPath,
                line: i + 1,
                meta: routeMatch[1].toUpperCase(),
                handlerName,
            });
            continue;
        }

        // Controller decorator: @Controller("path")
        const ctrlMatch = line.match(/^\s*@Controller\s*\(\s*["']?([^"')]*)/);
        if (ctrlMatch) {
            out.push({
                framework: 'nestjs',
                kind: 'router_include',
                name: ctrlMatch[1] || '/',
                filePath,
                relPath,
                line: i + 1,
                meta: 'Controller',
            });
        }

        // Middleware: @UseGuards, @UseInterceptors, @UsePipes
        const mwMatch = line.match(/^\s*@(UseGuards|UseInterceptors|UsePipes)\s*\(\s*([A-Za-z_]\w*)/);
        if (mwMatch) {
            out.push({
                framework: 'nestjs',
                kind: 'middleware',
                name: mwMatch[2],
                filePath,
                relPath,
                line: i + 1,
                meta: mwMatch[1],
            });
        }
    }
}

/**
 * Determine which frameworks are likely present based on dependency hints.
 */
export function detectActiveFrameworks(depHints: Set<string>): Set<string> {
    const frameworks = new Set<string>();
    if (['fastapi', 'uvicorn', 'starlette'].some(d => depHints.has(d))) frameworks.add('fastapi');
    if (depHints.has('streamlit')) frameworks.add('streamlit');
    if (depHints.has('flask')) frameworks.add('flask');
    if (depHints.has('django')) frameworks.add('django');
    if (['express', '@types/express', 'fastify', 'koa'].some(d => depHints.has(d))) frameworks.add('express');
    if (['@nestjs/core', '@nestjs/common'].some(d => depHints.has(d))) frameworks.add('nestjs');
    return frameworks;
}
