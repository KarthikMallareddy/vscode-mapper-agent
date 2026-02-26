import * as vscode from 'vscode';

export async function activate(context: vscode.ExtensionContext) {
    
    // Helper function to securely get or ask for the API Key
    async function getApiKey(): Promise<string | undefined> {
        // 1. Try to get the key from SecretStorage
        let apiKey = await context.secrets.get('gemini_api_key');

        if (!apiKey) {
            // 2. If missing, ask the user
            apiKey = await vscode.window.showInputBox({
                prompt: "Enter your Gemini API Key to enable @mapper",
                placeHolder: "AIzaSy...",
                ignoreFocusOut: true,
                password: true // Hides the key as they type
            });

            if (apiKey) {
                // 3. Save it securely for next time
                await context.secrets.store('gemini_api_key', apiKey);
                vscode.window.showInformationMessage("✅ Gemini Key saved securely.");
            }
        }
        return apiKey;
    }

    // Register a command so users can update their key later
    context.subscriptions.push(
        vscode.commands.registerCommand('mapper.setGeminiKey', async () => {
            await context.secrets.delete('gemini_api_key');
            await getApiKey();
        })
    );

    const mapper = vscode.chat.createChatParticipant("mapper", async (request, context, response, token) => {
        const apiKey = await getApiKey();
        
        if (!apiKey) {
            response.markdown("❌ **Missing API Key.** I need a Gemini API key to scan your architecture. Use the command `Mapper: Set Gemini API Key` to add one.");
            return;
        }

        response.markdown("🔍 **@mapper is authorized and scanning...**");
        // Your scanning and LangChain logic goes here!
    });
}