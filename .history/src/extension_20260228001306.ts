import * as vscode from 'vscode';
import * as path from 'path';
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

// 1. The Main Activate Function (VS Code calls this on startup)
export function activate(context: vscode.ExtensionContext) {
    console.log('@mapper is now active!');

    // 2. Define the Chat Participant
    const mapper = vscode.chat.createChatParticipant("mapper", async (request, context_chat, response, token) => {
        
        // Pass the outer 'context' so we can access secret storage
        const apiKey = await getApiKey(context); 
        
        if (!apiKey) {
            response.markdown("❌ **Missing API Key.** Please enter it in the prompt above.");
            return;
        }

        // Initialize Gemini
        const model = new ChatGoogleGenerativeAI({
            model: "gemini-1.5-flash",
            apiKey: apiKey,
        });

        // Handle /draw command
        if (request.command === 'draw') {
            response.markdown("🎨 **@mapper is analyzing your project...**\n\n");
            // ... (Your drawing logic goes here)
            return;
        }

        // Handle /summary or default logic
        response.markdown("👋 Hello! I am @mapper. Try using `/draw` or `/summary`.");
    });

    // 3. Register the participant so it stays active
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

// 5. This is required for clean shutdown
export function deactivate() {}