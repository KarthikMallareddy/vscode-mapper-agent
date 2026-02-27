import * as vscode from 'vscode';
// We'll use these for Day 2 logic
// import { ChatOpenAI } from "@langchain/openai"; 

export function activate(context: vscode.ExtensionContext) {
    // Register the @mapper agent
    const mapper = vscode.chat.createChatParticipant("mapper", async (request, context, response, token) => {
        
        response.markdown("🔍 **@mapper is scanning your project...**\n\n");

        // 1. Discovery: Find all configuration and source files
        const files = await vscode.workspace.findFiles('**/*.{ts,js,py,env,sol}', '**/node_modules/**');
        
        if (files.length === 0) {
            response.markdown("I couldn't find any service files to map. Try opening a project folder!");
            return;
        }

        // 2. Report: List what we found (This is the 'Retrieval' part of RAG)
        response.markdown(`I found **${files.length}** files that might contain service connections. Here is the breakdown:`);
        
        const fileList = files.slice(0, 5).map(f => `* ${vscode.workspace.asRelativePath(f)}`).join('\n');
        response.markdown(`\n${fileList}\n\n*...and ${files.length - 5} more.*`);

        response.markdown("\n\nReady for Day 2? Next, I'll analyze these files to draw your Mermaid diagram!");
    });
}