import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import * as vscode from 'vscode';
import * as path from 'path';

// Add 'path' to your imports at the top


// ... (keep your getApiKey and existing activation logic) ...

const mapper = vscode.chat.createChatParticipant("mapper", async (request, context, response, token) => {
    const apiKey = await getApiKey();
    if (!apiKey) {
        response.markdown("❌ **Missing API Key.**");
        return;
    }

    // Initialize the AI
    const model = new ChatGoogleGenerativeAI({
        model: "gemini-1.5-flash",
        apiKey: apiKey,
    });

    // Handle the /draw command
    if (request.command === 'draw') {
        response.markdown("🎨 **@mapper is analyzing your project structure to draw a map...**\n\n");
        
        // 1. Get a snapshot of the folder structure
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            response.markdown("Please open a workspace to use /draw.");
            return;
        }

        const rootPath = workspaceFolders[0].uri.fsPath;
        const fileTree = await getFileTree(rootPath);

        // 2. Ask Gemini to interpret the architecture
        const aiResponse = await model.invoke([
            ["system", "You are a Software Architect. Based on the provided file tree, generate a high-level architecture diagram using Mermaid.js syntax. Group files into logical layers (e.g., UI, Logic, Data)."],
            ["user", `Here is my project structure:\n${fileTree}`]
        ]);

        response.markdown("### 🗺️ Project Architecture Map\n\n" + aiResponse.content);
        return;
    }

    // Default: Scrum Note Logic (Your existing code)
    // ...
});

// Helper function to scan the directory
async function getFileTree(dir: string, depth = 0): Promise<string> {
    if (depth > 3) return ""; // Don't go too deep
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    let tree = "";
    for (const [name, type] of entries) {
        if (name === 'node_modules' || name === '.git') continue;
        tree += `${"  ".repeat(depth)}${type === vscode.FileType.Directory ? "📁" : "📄"} ${name}\n`;
        if (type === vscode.FileType.Directory) {
            tree += await getFileTree(path.join(dir, name), depth + 1);
        }
    }
    return tree;
}
async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
    // 1. Try to get the key from secure storage
    let apiKey = await context.secrets.get("GEMINI_API_KEY");

    // 2. If it's not there, ask the user for it
    if (!apiKey) {
        apiKey = await vscode.window.showInputBox({
            prompt: "Enter your Gemini API Key",
            placeHolder: "AIza...",
            ignoreFocusOut: true,
            password: true
        });

        // 3. If they entered a key, save it for next time
        if (apiKey) {
            await context.secrets.store("GEMINI_API_KEY", apiKey);
            vscode.window.showInformationMessage("✅ Gemini Key saved securely.");
        }
    }

    return apiKey;
}