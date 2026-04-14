# 🗺️ @mapper

**The AI-powered architect and scrum master for your VS Code projects.**

`@mapper` transforms your VS Code sidebar into an intelligent command center. Leveraging the power of Google's Gemini 1.5 Pro AI, it analyzes your codebase to automatically generate live architecture diagrams and manages your project tasks with a self-updating Git-linked Scrum board.

## ✨ Key Features

### 🏛️ Live Architecture Visualization (`/draw`)
Never get lost in a sprawling codebase again. `@mapper` deeply scans your files, categorizes your technical stack (Frontend, Backend, Database), and visualizes the relationships between your modules in a beautiful, zoomable, interactive Mermaid diagram directly in a Webview panel.

### 📋 AI Auto-Mapped Scrum Tracker (`/scrumtracker`)
Project management natively inside your IDE. Create goals, assign them to team members, and keep track of your ticket types (Bug, Story, Task). 
**The Magic:** The proprietary AI Sync engine automatically scans your local `git commit` history. When it detects a commit that resolves a goal, it instantly maps the commit hash and moves the ticket to the "Completed" column—without you lifting a finger.

### 🧠 Deep File Explanation (`/explain`)
Clicking on any node inside the `/draw` architecture map allows you to seamlessly beam the file into your Copilot Chat. The AI will provide a high-level summary of what the file does and how it fits into the broader architecture.

### 💾 Markdown Exports (`/export`)
Generate an `ARCHITECTURE.md` file charting your entire project's module imports and symbols hierarchy instantly, perfect for onboarding new developers.

## 🚀 Getting Started

1. **Install `@mapper`** from the VS Code Marketplace.
2. **Open Chat:** Press `Ctrl+Alt+I` to open your VS Code Chat panel.
3. **Initialize:** Type `@mapper /draw` and press Enter.
4. **Authenticate:** Provide your Gemini API Key when prompted (you only need to do this once). 
5. Watch as your code maps itself!

## ⌨️ Command Reference

| Command | Description |
| ------- | ----------- |
| `/draw` | Visualize the project's architecture with a Mermaid diagram. |
| `/scrumtracker` | Open the AI-mapped Git Scrum Tracker. |
| `/explain` | Explain the role of the currently open file in the architecture. |
| `/export` | Export the project architecture as an `ARCHITECTURE.md` file. |
| `/config` | Show configuration flow and routing settings. |

## ⚙️ Requirements

* Visual Studio Code `^1.80.0`
* A valid **Gemini API Key** (Get yours for free at Google AI Studio)
* Git installed locally (required for Scrum Tracker AI mapping)

## 💬 Privacy & Security

Your privacy is paramount. `@mapper` communicates exclusively with the official Gemini secure endpoints. It strictly analyzes module dependencies and file symbols for visualizations, and commit subjects for task resolutions.

---
*Built to bring order to code chaos.*
