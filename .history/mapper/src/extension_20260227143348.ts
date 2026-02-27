import * as vscode from 'vscode';
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

export async function activate(context: vscode.ExtensionContext) {
    
    // 1. Hook into the built-in VS Code Git Extension
    const gitExtension = vscode.extensions.getExtension<any>('vscode.git')?.exports;
    const git = gitExtension?.getAPI(1);

    // 2. Helper function to securely get or ask for the Gemini API Key
    async function getApiKey(): Promise<string | undefined> {
        let apiKey = await context.secrets.get('gemini_api_key');

        if (!apiKey) {
            apiKey = await vscode.window.showInputBox({
                prompt: "Enter your Gemini API Key to enable @mapper",
                placeHolder: "AIzaSy...",
                ignoreFocusOut: true,
                password: true
            });

            if (apiKey) {
                await context.secrets.store('gemini_api_key', apiKey);
                vscode.window.showInformationMessage("✅ Gemini Key saved securely.");
            }
        }
        return apiKey;
    }

    // 3. Register a command to manually update/set the Gemini Key
    context.subscriptions.push(
        vscode.commands.registerCommand('mapper.setGeminiKey', async () => {
            await context.secrets.delete('gemini_api_key');
            await getApiKey();
        })
    );

    // 4. Register the @mapper Chat Participant
    const mapper = vscode.chat.createChatParticipant("mapper", async (request, context, response, token) => {
        const apiKey = await getApiKey();
        
        if (!apiKey) {
            response.markdown("❌ **Missing API Key.** Please use the command `Mapper: Set Gemini API Key` to authorize @mapper.");
            return;
        }

        // Check if we are in a Git repository
        const repo = git?.repositories[0];
        if (!repo) {
            response.markdown("I couldn't find a Git repository. To generate Scrum notes, please open a folder initialized with Git.");
            return;
        }

        response.markdown("🔍 **@mapper is scanning your recent commits for Scrum notes...**\n\n");

        try {
            // 5. Fetch the last 24 hours of Git history
            // We use 'git log' logic to see what the user actually built
            const recentCommits = await repo.log({ maxEntries: 5 });
            
            if (recentCommits.length === 0) {
                response.markdown("No recent commits found in the last 24 hours. Keep coding, and I'll be ready to summarize your progress!");
                return;
            }

            // 6. Initialize the Gemini Brain (Day 2 Milestone)
           // 6. Initialize the Gemini Brain (The 'model' property fix)
const model = new ChatGoogleGenerativeAI({
    model: "gemini-1.5-flash", // Changed from 'modelName' to 'model'
    apiKey: apiKey,
});
            const commitSummary = recentCommits.map((c: any) => `* ${c.message}`).join('\n');

            // 7. Generate the Daily Standup Note
            const aiResponse = await model.invoke([
                ["system", "You are a Scrum Master. Turn the following Git commit messages into a concise Daily Standup note with three sections: 'Yesterday's Accomplishments', 'Current Focus', and 'Potential Blockers'."],
                ["user", `My recent commits:\n${commitSummary}`]
            ]);

            response.markdown("### 📝 Daily Standup Note\n\n" + aiResponse.content);

        } catch (err) {
            response.markdown("❌ **Error generating Scrum notes:** " + (err as Error).message);
        }
    });
}

export function deactivate() {}