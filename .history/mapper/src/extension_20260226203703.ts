import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    const mapper = vscode.chat.createChatParticipant("mapper", async (request, context, response, token) => {
        
        response.markdown("🔍 **@mapper is analyzing your service connections...**\n\n");

        // 1. Find relevant files (ignoring heavy folders)
        const files = await vscode.workspace.findFiles('**/*.{ts,js,env}', '**/node_modules/**');
        
        if (files.length === 0) {
            response.markdown("I couldn't find any relevant files. Try opening a project folder!");
            return;
        }

        // 2. Read contents (The 'Document Loading' step you learned)
        const projectContext: string[] = [];
        
        for (const file of files.slice(0, 10)) { // Limit to 10 files for performance
            const content = await vscode.workspace.fs.readFile(file);
            const text = new TextDecoder().decode(content);
            
            // Clean the text slightly to save LLM tokens
            projectContext.push(`FILE: ${vscode.workspace.asRelativePath(file)}\nCONTENT:\n${text.substring(0, 1000)}`);
        }

        // 3. Final Output for testing
        response.markdown(`✅ I've successfully read **${files.length}** files.\n\n`);
        response.markdown("I am now ready to identify your **Supabase**, **OpenAI**, or **Database** connections from this data.");
    });
}