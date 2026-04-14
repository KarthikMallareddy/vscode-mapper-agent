# Change Log

All notable changes to the `@mapper` extension will be documented in this file.

## [1.0.0] - Initial Release

### ✨ Features
- **Intelligent Architecture Mapping**: Added the `/draw` command to generate high-level Mermaid.js visualizations of local workspaces based on AST and module resolution.
- **Scrum Tracker**: Added the `/scrumtracker` command. Introduced an internal Kanban board that automatically parses your local Git log via Gemini 1.5 Pro to map commit resolutions identically to open tickets.
- **Explain Module**: Added `/explain` for real-time contextual feedback about specific files in your dependency tree.
- **Exporting**: Introduced `/export` for generating an `ARCHITECTURE.md` snapshot of the current workspace state.

### 🛠 Improvements
- **Fallback AI Engine**: Added robust internal `fetch` fallback using native API keys so `@mapper` operates perfectly even if the user lacks an installed enterprise Copilot.
- **Glassmorphism UI**: Native VS Code Webview panels rendered meticulously using modern dark-mode tailored CSS and standardized VS Code color variables.
- **Cross-Platform Readiness**: Stabilized child processes to ensure complex shell executions (like `git log`) run flawlessly on Windows, macOS, and Linux without delimiter breakages.