import * as vscode from 'vscode';
import * as path from 'path';
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

export function activate(context: vscode.ExtensionContext) {
    console.log('@mapper is now active!');

    const mapper = vscode.chat.createChatParticipant("mapper", async (request, context_chat, response, token) => {
        const apiKey = await getApiKey(context); 
        if (!apiKey) {
            response.markdown("❌ **Missing API Key.** Please enter it in the prompt above.");
            return;
        }

        // Updated initialization to avoid 404/400 errors
        const model = new ChatGoogleGenerativeAI({
            model: "gemini-1.5-flash", 
            apiKey: apiKey,
            apiVersion: "v1beta", // v1beta handles Flash models more reliably in dev
        });

        // 1. COMMAND: /summary
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
                        content: `INSTRUCTIONS: Act as a Scrum Master. Turn these commits into a Daily Standup note (Accomplishments, Focus, Blockers).\n\nCOMMITS:\n${commitMessages}`
                    }
                ]);
                response.markdown("### 🚀 Daily Standup Summary\n\n" + aiResponse.content);
            } catch (err: any) {
                response.markdown(`❌ **AI Error:** ${err.message}`);
            }
            return;
        }

        // 2. COMMAND: /draw
        if (request.command === 'draw') {
            response.markdown("🎨 **@mapper is generating a Deep Scan architecture map...**\n\n");
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) return;

            const rootPath = workspaceFolders[0].uri.fsPath;
            const fileTree = await getFileTree(rootPath);

            const extensionUri = vscode.Uri.file(path.join(rootPath, 'src', 'extension.ts'));
            let extensionCode = "";
            try {
                const uint8Array = await vscode.workspace.fs.readFile(extensionUri);
                extensionCode = new TextDecoder().decode(uint8Array).substring(0, 4000); 
            } catch (e) {
                extensionCode = "// Analyzing structure only.";
            }

            try {
                const aiResponse = await model.invoke([
                    {
                        role: "user",
                        content: `ACT AS: Senior Software Architect. TASK: Generate a Mermaid.js (graph TD) diagram. 
                        Use subgraphs to group UI, Logic, and APIs.\n\nSTRUCTURE:\n${fileTree}\n\nLOGIC:\n${extensionCode}`
                    }
                ]);
                response.markdown("### 🗺️ System Architecture Map\n\n" + aiResponse.content);
            } catch (err: any) {
                response.markdown(`❌ **AI Error:** ${err.message}`);
            }
            return;
        }

        // 3. COMMAND: /explain
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
                        content: `INSTRUCTIONS: Explain the purpose of this file and its role in the architecture.\n\nFILE: ${activeEditor.document.fileName}\n\nCONTENT:\n${content}`
                    }
                ]);
                response.markdown("### 📖 File Analysis\n\n" + aiResponse.content);
            } catch (err: any) {
                response.markdown(`❌ **AI Error:** ${err.message}`);
            }
            return;
        }

        response.markdown("👋 I am **@mapper**. Try `/summary`, `/draw`, or `/explain`!");
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

export function deactivate() {}