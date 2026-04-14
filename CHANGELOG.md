# Change Log

All notable changes to the `@mapper` extension will be documented in this file.

## [1.1.1] - 2026-04-14

### Documentation
- Added a high-fidelity, professional showcase image to the README to demonstrate the Architecture Mapping and Scrum Tracker UI without exposing private project data.

---

## [1.1.0] - 2026-04-14

### Features
- **Two-Tier AI Engine**: Mapper now uses a strict, transparent AI selection hierarchy for the Scrum Tracker. If GitHub Copilot with GPT-4o is available, it is used at zero credit cost. If not, it automatically falls back to the Gemini API using the user's free personal key.
- **Model Transparency**: A VS Code status bar message now appears every time a Scrum sync runs, clearly showing which AI model processed the request (GPT-4o or Gemini).
- **Credit Safety Guard**: The extension now strictly refuses to fall back to any non-GPT-4o Copilot model (such as Claude or o1) to protect users from unexpected credit consumption.

### Documentation
- Completely rewrote README.md with a professional structure, architecture diagram, full key component table, and a detailed two-tier AI configuration guide.
- Added a Privacy Model section clearly documenting what data is and is not sent to external APIs.
- Documented the free-tier API key setup flow for Gemini with a direct link to Google AI Studio.

### Fixes
- Corrected publisher ID in `package.json` from `karthik` to `KarthikMallareddy` to match the registered VS Code Marketplace account.

---

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