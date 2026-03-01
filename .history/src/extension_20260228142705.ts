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
            response.markdown("❌ **Missing API Key.**");
            return;
        }

        const model = new ChatGoogleGenerativeAI({
            model: "gemini-2.5-flash", 
            apiKey: apiKey,
            apiVersion: "v1beta", 
        });

        // --- COMMAND: /draw ---
        if (request.command === 'draw') {
            response.markdown("🎨 **Generating your architecture visualization...**\n\n");
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) return;

            const rootPath = workspaceFolders[0].uri.fsPath;
            const fileTree = await getFileTree(rootPath);
            
            try {
                const aiResponse = await model.invoke([
                    {
                        role: "user",
                        content: `Act as a Senior Architect. Generate a Mermaid.js (graph TD) diagram for this project structure. 
                        Output ONLY the raw Mermaid code. Do not use markdown backticks.\n\nSTRUCTURE:\n${fileTree}`
                    }
                ]);

                // SANITIZE AND OPEN PREVIEW
                const rawContent = aiResponse.content as string;
                const cleanCode = sanitizeMermaid(rawContent);

                response.markdown("### 🗺️ System Architecture Map Generated\n\n" + cleanCode);
                openMermaidPreview(cleanCode);

            } catch (err: any) {
                response.markdown(`❌ **AI Error:** ${err.message}`);
            }
            return;
        }

        // --- COMMAND: /summary ---
        if (request.command === 'summary') {
            // ... (keep your existing summary logic here)
        }

        response.markdown("👋 I am **@mapper**. Try `/draw` or `/summary`!");
    });

    context.subscriptions.push(mapper);
}

// --- NEW: SANITIZATION HELPER ---
function sanitizeMermaid(text: string): string {
    // Removes markdown code blocks like ```mermaid or ``` if the AI includes them
    return text.replace(/```mermaid/g, '').replace(/```/g, '').trim();
}

// --- UPDATED: WEBVIEW RENDERER ---
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
                body { background-color: white; margin: 0; display: flex; justify-content: center; }
                .mermaid { width: 100%; height: 100vh; }
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

// ... (keep getApiKey and getFileTree helpers)

export function deactivate() {}