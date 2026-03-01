import * as vscode from 'vscode';
import * as path from 'path';
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

export function activate(context: vscode.ExtensionContext) {
    console.log('@mapper is now active!');

    // 1. REGISTER THE RESET COMMAND (Accessible via Command Palette: Ctrl+Shift+P)
    const resetCommand = vscode.commands.registerCommand('mapper.resetApiKey', async () => {
        await context.secrets.delete("GEMINI_API_KEY");
        vscode.window.showInformationMessage("🔄 Gemini API Key cleared. You'll be prompted for a new one on your next request.");
    });
    context.subscriptions.push(resetCommand);

    // 2. REGISTER THE CHAT PARTICIPANT
    const mapper = vscode.chat.createChatParticipant("mapper", async (request, context_chat, response, token) => {
        const apiKey = await getApiKey(context); 
        if (!apiKey) {
            response.markdown("❌ **Missing API Key.** Please enter it in the prompt above.");
            return;
        }

        // Optimized for early 2026 stable endpoints
        const model = new ChatGoogleGenerativeAI({
            model: "gemini-2.5-flash", 
            apiKey: apiKey,
            apiVersion: "v1beta", 
        });

        // --- COMMAND: /summary (The Scrum Master) ---
        if (request.command === 'summary') {
            response.markdown("📋 **@mapper is gathering your recent work...**\n\n");
            const gitExtension = vscode.extensions.getExtension('vscode.git');
            const git = gitExtension?.exports.getAPI(1);
            const repo = git?.repositories[0];

            if (!repo) {
                response.markdown("❌ **No Git repository found.**");
                return;
            }

            const commits = await repo.log({ maxEntries: 5 });
            const commitMessages = commits.map((c: any) => `- ${c.message}`).join('\n');

            try {
                const aiResponse = await model.invoke([
                    {
                        role: "user",
                        content: `Act as a Scrum Master. Summarize these commits into Accomplishments, Focus, and Blockers.\n\nCOMMITS:\n${commitMessages}`
                    }
                ]);
                response.markdown("### 🚀 Daily Standup Summary\n\n" + aiResponse.content);
            } catch (err: any) {
                response.markdown(`❌ **AI Error:** ${err.message}`);
            }
            return;
        }

        // --- COMMAND: /draw (The Architect - Now with Visual Preview) ---
        if (request.command === 'draw') {
            response.markdown("🎨 **@mapper is performing a Deep Scan and generating your visualization...**\n\n");
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) return;

            const rootPath = workspaceFolders[0].uri.fsPath;
            const fileTree = await getFileTree(rootPath);
            
            // Read extension.ts for logic context
            const extensionUri = vscode.Uri.file(path.join(rootPath, 'src', 'extension.ts'));
            let extensionCode = "";
            try {
                const uint8Arr = await vscode.workspace.fs.readFile(extensionUri);
                extensionCode = new TextDecoder().decode(uint8Arr).substring(0, 4000);
            } catch { extensionCode = "// Structure analysis only."; }

            try {
                const aiResponse = await model.invoke([
                    {
                        role: "user",
                        content: `Act as a Senior Architect. Generate a Mermaid.js (graph TD) diagram. 
                        Use subgraphs to group UI, Logic, and APIs. 
                        Output ONLY the Mermaid code block starting with 'graph TD'.\n\nFILES:\n${fileTree}\n\nLOGIC:\n${extensionCode}`
                    }
                ]);

                const mermaidCode = aiResponse.content as string;

                // 1. Show code in chat as a record
                response.markdown("### 🗺️ System Architecture Map\n\n" + mermaidCode);

                // 2. LAUNCH THE VISUAL PREVIEW WINDOW
                openMermaidPreview(mermaidCode);

            } catch (err: any) {
                response.markdown(`❌ **AI Error:** ${err.message}`);
            }
            return;
        }

        // --- COMMAND: /explain (The Teacher) ---
        if (request.command === 'explain') {
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor) {
                response.markdown("Please open a file first.");
                return;
            }

            const content = activeEditor.document.getText().substring(0, 3000);
            try {
                const aiResponse = await model.invoke([
                    {
                        role: "user",
                        content: `Explain the purpose of this file and its role in the architecture.\n\nFILE: ${activeEditor.document.fileName}\n\nCONTENT:\n${content}`
                    }
                ]);
                response.markdown("### 📖 File Analysis\n\n" + aiResponse.content);
            } catch (err: any) {
                response.markdown(`❌ **AI Error:** ${err.message}`);
            }
            return;
        }

        // DEFAULT RESPONSE
        response.markdown("👋 I am **@mapper**. Try using `/summary`, `/draw`, or `/explain` to manage your project!");
    });

    context.subscriptions.push(mapper);
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

/**
 * Opens a new VS Code WebView tab to render the Mermaid diagram visually.
 */
function openMermaidPreview(mermaidCode: string) {
    const panel = vscode.window.createWebviewPanel(
        'mermaidPreview',
        'Architecture Map',
        vscode.ViewColumn.Two, // Opens to the side of the current editor
        { enableScripts: true }
    );

    // Injecting Mermaid.js to render the text into a diagram
    panel.webview.html = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { background-color: white; display: flex; justify-content: center; padding: 20px; }
            </style>
            <script type="module">
                import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
                mermaid.initialize({ 
                    startOnLoad: true,
                    theme: 'default'
                });
            </script>
        </head>
        <body>
            <pre class="mermaid">
                ${mermaidCode}
            </pre>
        </body>
        </html>
    `;
}

export function deactivate() {}