import * as vscode from 'vscode';
import * as path from 'path';
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

export function activate(context: vscode.ExtensionContext) {
    console.log('@mapper is now active!');

    const resetCommand = vscode.commands.registerCommand('mapper.resetApiKey', async () => {
        await context.secrets.delete("GEMINI_API_KEY");
        vscode.window.showInformationMessage("🔄 Gemini API Key cleared.");
    });
    context.subscriptions.push(resetCommand);

    const mapper = vscode.chat.createChatParticipant("mapper", async (request, context_chat, response, token) => {
        const apiKey = await getApiKey(context); 
        if (!apiKey) {
            response.markdown("❌ **Missing API Key.**");
            return;
        }

        const model = new ChatGoogleGenerativeAI({
            model: "gemini-2.5-flash", 
            apiKey: apiKey,
            apiVersion: "v1beta", 
        });

        if (request.command === 'draw') {
            response.markdown("🎨 **@mapper is rendering your architecture...**\n\n");
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) return;

            const rootPath = workspaceFolders[0].uri.fsPath;
            const fileTree = await getFileTree(rootPath);
            
            try {
                const aiResponse = await model.invoke([
                    {
                        role: "user",
                        content: `Act as a Senior Architect. Generate a Mermaid.js (graph TD) diagram. 
                        Use subgraphs for: [Frontend], [Backend/API], [Services], and [Data Store]. 
                        Output ONLY raw Mermaid code. No markdown backticks.
                        
                        STRUCTURE:
                        ${fileTree}`
                    }
                ]);

                const cleanCode = sanitizeMermaid(aiResponse.content as string);
                openMermaidPreview(cleanCode);

            } catch (err: any) {
                response.markdown(`❌ **AI Error:** ${err.message}`);
            }
            return;
        }

        response.markdown("👋 I am **@mapper**. Try `/draw`!");
    });

    context.subscriptions.push(mapper);
}

function sanitizeMermaid(text: string): string {
    return text.replace(/```mermaid/g, '').replace(/```/g, '').trim();
}

function openMermaidPreview(mermaidCode: string) {
    const panel = vscode.window.createWebviewPanel(
        'mermaidPreview', 'Architecture Map', vscode.ViewColumn.Two, { enableScripts: true }
    );

    panel.webview.html = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { background: #ffffff; margin: 0; padding: 0; overflow: hidden; font-family: sans-serif; height: 100vh; width: 100vw; }
                #controls { position: absolute; top: 10px; left: 10px; z-index: 100; background: rgba(255,255,255,0.9); padding: 8px; border-radius: 4px; border: 1px solid #ccc; font-size: 12px; }
                #diagram-container { width: 100%; height: 100%; background: #fafafa; display: flex; align-items: center; justify-content: center; }
                /* Critical: Ensure SVG fills the container */
                svg { width: 100%; height: 100%; min-height: 500px; } 
            </style>
        </head>
        <body>
            <div id="controls">
                <b>@mapper Visualizer</b><br/>
                Scroll to Zoom | Drag to Pan
            </div>
            <div id="diagram-container">
                <div id="loading">⌛ Rendering diagram...</div>
            </div>

            <script type="module">
                import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
                import svgPanZoom from 'https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.1/dist/svg-pan-zoom.min.js';
                
                mermaid.initialize({ startOnLoad: false, theme: 'neutral' });
                
                async function render() {
                    const container = document.getElementById('diagram-container');
                    try {
                        const { svg } = await mermaid.render('mermaid-svg', \`${mermaidCode}\`);
                        container.innerHTML = svg;
                        
                        const svgElement = container.querySelector('svg');
                        svgPanZoom(svgElement, {
                            zoomEnabled: true,
                            controlIconsEnabled: true,
                            fit: true,
                            center: true
                        });
                    } catch (e) {
                        container.innerHTML = "<div style='color:red; padding:20px;'><b>Syntax Error:</b><br/>" + e.message + "</div>";
                    }
                }
                render();
            </script>
        </body>
        </html>
    `;
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