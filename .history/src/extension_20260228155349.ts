import * as vscode from 'vscode';
import * as path from 'path';
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

export function activate(context: vscode.ExtensionContext) {
    console.log('@mapper is now active!');

    // 1. REGISTER THE RESET COMMAND
    const resetCommand = vscode.commands.registerCommand('mapper.resetApiKey', async () => {
        await context.secrets.delete("GEMINI_API_KEY");
        vscode.window.showInformationMessage("🔄 Gemini API Key cleared.");
    });
    context.subscriptions.push(resetCommand);

    // 2. REGISTER THE CHAT PARTICIPANT
    const mapper = vscode.chat.createChatParticipant("mapper", async (request, context_chat, response, token) => {
        const apiKey = await getApiKey(context); 
        if (!apiKey) {
            response.markdown("❌ **Missing API Key.** Please enter it in the prompt above.");
            return;
        }

        const model = new ChatGoogleGenerativeAI({
            model: "gemini-2.5-flash", 
            apiKey: apiKey,
            apiVersion: "v1beta", 
        });

        if (request.command === 'draw') {
            response.markdown("🎨 **Generating your architecture visualization...**\n\n");
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) return;

            const rootPath = workspaceFolders[0].uri.fsPath;
            const fileTree = await getFileTree(rootPath);
            
            const aiResponse = await model.invoke([
    {
        role: "user",
        content: `Act as a Senior Architect. Generate a professional Mermaid.js (graph TD) diagram.
        
        STRICT RULES:
        1. Use 'subgraph' to group: [Frontend], [Backend/API], [Services], and [Data Store].
        2. Use 'direction LR' inside subgraphs for a cleaner horizontal look.
        3. Use descriptive labels (e.g., 'main.py (FastAPI)').
        4. Output ONLY the raw Mermaid code. No backticks.
        
        STRUCTURE:
        ${fileTree}`
    }
]);
            return;
        }

        response.markdown("👋 I am **@mapper**. Try `/draw`!");
    });

    context.subscriptions.push(mapper);
}

// --- SANITIZATION HELPER ---
function sanitizeMermaid(text: string): string {
    return text.replace(/```mermaid/g, '').replace(/```/g, '').trim();
}

// --- WEBVIEW RENDERER ---
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
                body { background-color: white; margin: 0; display: flex; justify-content: center; overflow: auto; }
                .mermaid { padding: 20px; }
            </style>
            <script type="module">
                import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
                mermaid.initialize({ startOnLoad: true, theme: 'neutral' });
            </script>
        </head>
        <body>
            <div class="mermaid">
                ${mermaidCode}
            </div>
        </body>
        </html>
    `;
}

// --- MISSING HELPER FUNCTIONS (Add these back!) ---

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
    if (depth > 2) return "";
    try {
        const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
        let tree = "";
        for (const [name, type] of entries) {
            if (['node_modules', '.git', 'dist', '.history', '.vscode'].includes(name)) continue;
            tree += `${"  ".repeat(depth)}${type === vscode.FileType.Directory ? "📁" : "📄"} ${name}\n`;
            if (type === vscode.FileType.Directory) {
                tree += await getFileTree(path.join(dir, name), depth + 1);
            }
        }
        return tree;
    } catch { return ""; }
}

export function deactivate() {}