# Change Log

All notable changes to the `Mapper Agent` extension will be documented in this file.

## [1.1.0] - 2026-04-14 (Initial Production Release)

### ✨ Core Features
- **Intelligent Architecture Mapping**: Use `@mapper /draw` to generate high-level Mermaid.js visualizations of local workspaces based on AST and module resolution.
- **Scrum Tracker**: An AI-driven Kanban board that automatically maps open goals to local git commits using natural language semantics.
- **Two-Tier AI Engine**: Optimized for **0-credit usage** via GitHub Copilot (GPT-4o), with a secure fallback to the Google Gemini API.
- **Explain Module**: Real-time contextual feedback about specific files in your dependency tree.

### 🛠 UI & UX
- **Model Transparency**: Status bar indicators show exactly which AI model (GPT-4o or Gemini) is processing your data.
- **Rich Interactions**: Clickable commit-diff hashes, assignee filtering, and drag-and-drop task prioritization.
- **Glassmorphism Design**: High-fidelity dark mode interface following VS Code's design language.
- **Navigation Safety**: Fully functional Back/Forward navigation stack including support for shifting between the Architecture and Scrum views.

### 🛡 Privacy & Security
- **Zero SaaS Lock-in**: All caches (`.mapper/`) and Scrum data are stored exclusively in your local workspace.
- **Secret Storage**: API keys are stored in VS Code's encrypted Secret Storage vault.

### 🐛 Key Fixes
- Added per-card **Remove** buttons and a **Clear All** board reset option.
- Stabilized Windows Git log parsing for robust commit detection.
- Fixed navigation stack corruption when switching between diagram and board views.