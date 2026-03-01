import * as vscode from 'vscode';
import * as path from 'path';
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

// 1. The Main Activate Function (VS Code calls this on startup)
export function activate(context: vscode.ExtensionContext) {
    console.log('@mapper is now active!');

    const mapper = vscode.chat.createChatParticipant("mapper", async (request, context_chat, response, token) => {
        const apiKey = await getApiKey(context); 
        if (!apiKey) {
            response.markdown("❌ **Missing API Key.** Please enter it in the prompt above.");
            return;
        }

        const model = new ChatGoogleGenerativeAI({
        // Use 'model' (not modelName) to satisfy TypeScript
        model: "gemini-1.5-flash", 
        
        // Explicitly set the apiKey
        apiKey: apiKey,
        
        // Force v1 to avoid the 'v1beta' 404 error
        apiVersion: "v1", 
        });
        // 1. COMMAND: /summary (The Scrum Master)
        if (request.command === 'summary') {
            response.markdown("📋 **@mapper is gathering your recent work...**\n\n");
            const gitExtension = vscode.extensions.getExtension('vscode.git');
            const git = gitExtension?.exports.getAPI(1);
            const repo = git?.repositories[0];

            if (!repo) {
                response.markdown("❌ **No Git repository found.** Ensure your project has a .git folder at the root.");
                return;
            }

            const commits = await repo.log({ maxEntries: 5 });
            const commitMessages = commits.map((c: any) => `- ${c.message}`).join('\n');

            const aiResponse = await model.invoke([
                ["system", "You are an expert Scrum Master. Turn the following commits into a concise Daily Standup note (Accomplishments, Focus, Blockers)."],
                ["user", `My recent commits:\n${commitMessages}`]
            ]);
            response.markdown("### 🚀 Daily Standup Summary\n\n" + aiResponse.content);
            return;
        }

        // 2. COMMAND: /draw (The Architect)
        if (request.command === 'draw') {
    response.markdown("🎨 **@mapper is generating a Deep Scan architecture map...**\n\n");

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        response.markdown("❌ **No workspace folder open.** Please open a project folder first.");
        return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;

    // 1. Get the File Tree (using our helper function)
    const fileTree = await getFileTree(rootPath);

    // 2. Read the main extension code for logic context
    const extensionUri = vscode.Uri.file(path.join(rootPath, 'src', 'extension.ts'));
    let extensionCode = "";
    try {
        const uint8Array = await vscode.workspace.fs.readFile(extensionUri);
        extensionCode = new TextDecoder().decode(uint8Array).substring(0, 4000); 
    } catch (e) {
        extensionCode = "// src/extension.ts not found. Analyzing structure only.";
    }

    // 3. The "Universal" AI Call (Avoiding the 400 systemInstruction error)
    try {
        const aiResponse = await model.invoke([
            {
                role: "user",
                content: `
                ACT AS: Senior Software Architect.
                TASK: Analyze the provided project data and generate a professional Mermaid.js (graph TD) diagram.
                REQUIREMENTS:
                - Use 'subgraph' blocks to group UI, Logic, and External APIs.
                - Show the flow from User Request to AI Response.
                - Ensure the output is valid Mermaid code.

                PROJECT DATA:
                File Structure:
                ${fileTree}

                Core Logic Snippet:
                ${extensionCode}
                `
            }
        ]);

        response.markdown("### 🗺️ System Architecture Map\n\n" + aiResponse.content);
    } catch (error: any) {
        response.markdown(`❌ **AI Error:** ${error.message}`);
        console.error("Draw Command Error:", error);
    }
    return;
}
        // 3. COMMAND: /explain (The Teacher)
        if (request.command === 'explain') {
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor) {
                response.markdown("Please open a file first so I can explain it.");
                return;
            }

            const content = activeEditor.document.getText().substring(0, 3000);
            const aiResponse = await model.invoke([
                ["system", "Explain the purpose of this file and its role in the overall software architecture."],
                ["user", `File: ${activeEditor.document.fileName}\n\nContent:\n${content}`]
            ]);
            response.markdown("### 📖 File Analysis\n\n" + aiResponse.content);
            return;
        }

        // DEFAULT RESPONSE
        response.markdown("👋 I am **@mapper**. Try using `/summary`, `/draw`, or `/explain` to manage your project!");
    });

    context.subscriptions.push(mapper);
}

// 4. The helper function for the API Key
async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
    let apiKey = await context.secrets.get("GEMINI_API_KEY");

    if (!apiKey) {
        apiKey = await vscode.window.showInputBox({
            prompt: "Enter your Gemini API Key",
            placeHolder: "AIza...",
            ignoreFocusOut: true,
            password: true
        });

        if (apiKey) {
            await context.secrets.store("GEMINI_API_KEY", apiKey);
            vscode.window.showInformationMessage("✅ Gemini Key saved securely.");
        }
    }
    return apiKey;
}

async function getFileTree(dir: string, depth = 0): Promise<string> {
    if (depth > 2) return ""; // Keep it high-level to avoid hitting token limits
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    let tree = "";
    
    for (const [name, type] of entries) {
        // Skip heavy or hidden folders to keep the diagram clean
        if (['node_modules', '.git', 'dist', '.history', '.vscode'].includes(name)) continue;
        
        tree += `${"  ".repeat(depth)}${type === vscode.FileType.Directory ? "📁" : "📄"} ${name}\n`;
        
        if (type === vscode.FileType.Directory) {
            tree += await getFileTree(path.join(dir, name), depth + 1);
        }
    }
    return tree;
}

// 5. This is required for clean shutdown
export function deactivate() {}