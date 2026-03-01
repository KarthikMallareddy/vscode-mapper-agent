import * as vscode from 'vscode';
import * as path from 'path';
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

export function activate(context: vscode.ExtensionContext) {
    console.log('@mapper is now active!');

    // 1. REGISTER THE RESET COMMAND (Ctrl+Shift+P > Mapper: Reset Gemini API Key)
    const resetCommand = vscode.commands.registerCommand('mapper.resetApiKey', async () => {
        await context.secrets.delete("GEMINI_API_KEY");
        vscode.window.showInformationMessage("🔄 Gemini API Key cleared. You'll be prompted for a new one next time.");
    });
    context.subscriptions.push(resetCommand);

    // 2. REGISTER THE CHAT PARTICIPANT
    const mapper = vscode.chat.createChatParticipant("mapper", async (request, context_chat, response, token) => {
        const apiKey = await getApiKey(context); 
        if (!apiKey) {
            response.markdown("❌ **Missing API Key.** Please enter it in the prompt above.");
            return;
        }

        // Using 2026 stable production model and beta API version for modern features
        const model = new ChatGoogleGenerativeAI({
            model: "gemini-2.5-flash", 
            apiKey: apiKey,
            apiVersion: "v1beta", 
        });

        // --- COMMAND: /draw ---
        if (request.command === 'draw') {
            response.markdown("🎨 **@mapper is performing a Deep Scan and generating a navigable map...**\n\n");
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) {
                response.markdown("❌ **No workspace folder found.** Please open a project.");
                return;
            }

            const rootPath = workspaceFolders[0].uri.fsPath;
            const fileTree = await getFileTree(rootPath);
            
            try {
                const aiResponse = await model.invoke([
                    {
                        role: "user",
                        content: `Act as a Senior Architect. Generate a professional Mermaid.js (graph TD) diagram.
                        
                        STRICT RULES:
                        1. Use 'subgraph' to group: [Frontend], [Backend/API], [Services], and [Data Store].
                        2. Use 'direction LR' inside subgraphs for a cleaner horizontal look.
                        3. Use descriptive labels (e.g., 'main.py (FastAPI)').
                        4. Output ONLY the raw Mermaid code. Do not use markdown backticks.
                        
                        STRUCTURE:
                        ${fileTree}`
                    }
                ]);

                const rawContent = aiResponse.content as string;
                const cleanCode = sanitizeMermaid(rawContent);

                // Show text representation in chat for reference
                response.markdown("### 🗺️ System Architecture Map\n\nDiagram generated. Launching interactive preview...");
                
                // Launch the professional webview with navigation
                openMermaidPreview(cleanCode);

            } catch (err: any) {
                response.markdown(`❌ **AI Error:** ${err.message}`);
            }
            return;
        }

        // DEFAULT RESPONSE
        response.markdown("👋 I am **@mapper**. Try using `/draw` to visualize your project architecture!");
    });

    context.subscriptions.push(mapper);
}

// --- SANITIZATION HELPER ---
/** * Cleans the AI response to ensure the Mermaid renderer doesn't fail on Markdown artifacts.
 */
function sanitizeMermaid(text: string): string {
    return text.replace(/```mermaid/g, '').replace(/```/g, '').trim();
}

// --- WEBVIEW RENDERER (With Navigation) ---
/**
 * Opens an interactive, zoomable preview of the Mermaid diagram.
 */
function openMermaidPreview(mermaidCode: string) {
    const panel = vscode.window.createWebviewPanel(
        'mermaidPreview',
        'Architecture Map',
        vscode.ViewColumn.Two,
        { enableScripts: true }
    );

    panel.webview.html = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { background-color: #f0f0f0; margin: 0; overflow: hidden; font-family: sans-serif; }
                #controls { position: absolute; top: 10px; left: 10px; z-index: 100; background: white; padding: 10px; border-radius: 4px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                #diagram-container { width: 100vw; height: 100vh; cursor: grab; display: flex; align-items: center; justify-content: center; }
                svg { width: 100% !important; height: 100% !important; }
            </style>
            <script type="module">
                import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
                import svgPanZoom from 'https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.1/dist/svg-pan-zoom.min.js';
                
                mermaid.initialize({ startOnLoad: false, theme: 'neutral' });
                
                async function init() {
                    const container = document.getElementById('diagram-container');
                    try {
                        // Render the mermaid code to SVG
                        const { svg } = await mermaid.render('mermaid-svg', \`${mermaidCode}\`);
                        container.innerHTML = svg;
                        
                        const svgElement = container.querySelector('svg');
                        
                        // Initialize navigation (Zoom & Pan)
                        window.panZoom = svgPanZoom(svgElement, {
                            zoomEnabled: true,
                            controlIconsEnabled: true,
                            fit: true,
                            center: true,
                            minZoom: 0.1,
                            maxZoom: 10
                        });
                    } catch (e) {
                        container.innerHTML = "<h2 style='color:red'>Syntax Error in Diagram Logic</h2><pre>" + e.message + "</pre>";
                    }
                }
                init();
            </script>
        </head>
        <body>
            <div id="controls">
                <b>@mapper Visualizer</b><br/>
                <span>Scroll to Zoom | Drag to Pan</span>
            </div>
            <div id="diagram-container"></div>
        </body>
        </html>
    `;
}

// --- HELPER FUNCTIONS ---

async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
    let apiKey = await context.secrets.get("GEMINI_API_KEY");
    if (!apiKey) {
        apiKey = await vscode.window.showInputBox({
            prompt: "Enter your Gemini API Key",
            password: true,
            ignoreFocusOut: true
        });
        if (apiKey) {
            await context.secrets.store("GEMINI_API_KEY", apiKey);
        }
    }
    return apiKey;
}

async function getFileTree(dir: string, depth = 0): Promise<string> {
    if (depth > 2) return ""; // Limits scan depth to avoid token bloat
    try {
        const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
        let tree = "";
        for (const [name, type] of entries) {
            // Skips irrelevant directories for cleaner diagrams
            if (['node_modules', '.git', 'dist', '.history', '.vscode', '__pycache__'].includes(name)) continue;
            
            tree += `${"  ".repeat(depth)}${type === vscode.FileType.Directory ? "📁" : "📄"} ${name}\n`;
            if (type === vscode.FileType.Directory) {
                tree += await getFileTree(path.join(dir, name), depth + 1);
            }
        }
        return tree;
    } catch { return ""; }
}

export function deactivate() {}