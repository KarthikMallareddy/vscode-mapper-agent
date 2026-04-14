# Mapper
*The AI-powered architect and scrum master for your projects.*

Mapper is a Visual Studio Code extension designed to bring order to code chaos. By deeply analyzing your codebase via AST parsing and module resolution, and integrating directly with Google's Gemini 1.5 Pro AI, Mapper provides live, zoomable architecture visualizations and zero-friction project management using your local Git history.

## Features

### Live Architecture Visualization
Never get lost in a sprawling codebase again. Mapper deeply scans your files, categorizes your technical stack (Frontend, Backend, Database), and visualizes the relationships between your modules in a beautiful, zoomable, interactive Mermaid diagram directly in a Webview panel.

### AI Auto-Mapped Scrum Tracker
Project management natively inside your IDE. Create goals, assign them to team members, and keep track of your ticket types (Bug, Story, Task). 
**Zero-Friction Completion**: The proprietary AI Sync engine automatically scans your local git commit history. When it detects a commit that resolves a goal, it instantly maps the commit hash and moves the ticket to the "Completed" column.

### Contextual File Explanation
Beam any source file directly into your Copilot Chat. Mapper will analyze the file's role within your dependency tree and explain how it connects to the broader architecture.

### Markdown Exporting
Automatically generate an ARCHITECTURE.md file charting your entire project's module imports and symbols hierarchy, perfect for onboarding new developers.

## Quick Start

**1. Initialize the Visualizer**
- Open the Command Palette (Ctrl+Shift+P) or Chat panel (Ctrl+Alt+I).
- Run @mapper /draw.
- Provide your Gemini API Key when prompted.

**2. Explore Your Code**
- Click on any node in the generated diagram to jump to that file in your editor.
- Use the breadcrumb trails and trace tools to find references.

**3. Manage Tasks**
- Run @mapper /scrumtracker.
- Add tasks and assign them to your Git contributors.
- Click Sync after making a commit to watch the AI automatically resolve your tickets.

## Architecture
```text
┌─────────────────┐         ┌─────────────────┐
│  VS Code Editor │         │   Mapper Agent  │
│                 │         │                 │
│  Active Files   │         │  AST Parsing    │
│       ↓         │         │       ↓         │
│  Git History    │         │  Module Graph   │
└────────┬────────┘         └────────┬────────┘
         │                           │
         └──────────┬────────────────┘
                    │
           ┌────────▼────────┐
           │   Gemini API    │
           │  (Semantic Map) │
           └────────┬────────┘
                    │
           ┌────────▼────────┐
           │ Webview UI Core │
           │ Scrums & Graphs │
           └─────────────────┘
```

## Key Components

| Component | Purpose |
| :--- | :--- |
| symbolIndex.ts | AST Parsing and symbol extraction (classes, functions, interfaces). |
| moduleGraph.ts | Dependency resolution and Mermaid.js syntax generation. |
| scanCache.ts | Local caching of workspace scans to optimize performance. |
| scrum.json | Local offline storage for Kanban tickets and assignments. |
| detectScrumCompletions | AI prompt engine that maps .git logs to goal statuses. |
| frameworkDetectors.ts | Identifies technologies (React, Express, FastAPI) automatically. |

## Configuration
Mapper requires a valid Gemini API Key to function. This key is stored securely in VS Code's native Secret Storage block and is never written to plaintext files. You can reset it at any time using the Mapper: Reset Gemini API Key command.

## Privacy Model
- **Zero SaaS Lock-in**: All architecture caching (.mapper/) and Scrum goals (scrum.json) are stored natively on your local hard drive.
- **Safe Telemetry**: Mapper communicates exclusively with official Gemini API endpoints. It sends only module dependency maps for visualizations and commit subjects for task resolutions, keeping your core source code business logic entirely private during these syncs.

## Development
```bash
# Install dependencies
npm install

# Watch mode (auto-rebuild)
npm run watch

# Production build
npm run compile

# Press F5 in VS Code to launch Extension Development Host
```

## License
MIT
