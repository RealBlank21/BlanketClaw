# 🐾 BlanketClaw

**An autonomous, context-aware CLI AI Assistant built for developers.**

BlanketClaw is a Node.js terminal agent designed to sit right inside your codebase. It doesn't just chat; it reads your local files, tracks token usage, utilizes reasoning models (like DeepSeek-R1), and can autonomously execute shell commands to build, debug, and navigate your projects.

### ✨ Key Features
* **Universal Provider Support:** Seamlessly switch between local models via **Ollama** and cloud models via **OpenRouter**.
* **Agentic Tool Calling:** Give the AI permission to run shell commands in your terminal. It captures `stdout` and `stderr` to autonomously read errors and self-correct its own mistakes.
* **Spatial File Awareness:** Use `/load` with glob wildcards to inject specific code files into the AI's context window. Hidden files (`.env`, `.git`) are safely bypassed but acknowledged.
* **Native Reasoning Support:** Beautiful, intercept-driven stream parsing for models that "think" (e.g., DeepSeek-R1). Watch the AI's thought process live, or hide it to keep your terminal clean.
* **Global Identity:** Configuration, persistent memory, and AI personas live in `~/.blanketclaw`, meaning your assistant remembers who you are no matter what project folder you launch it in.
* **Polished CLI UX:** Built with `@clack/prompts` and native `readline` for real-time tab-autocompletion.

---

## 🚀 Installation

**Prerequisites:**
* Node.js (v18+ recommended)
* [Ollama](https://ollama.com/) (For running local models)

**Setup:**
1. Clone the repository or navigate to the source folder.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Link the package globally so you can run it from any directory:
   ```bash
   npm link
   ```

You can now launch the assistant by typing `blanketclaw` in any terminal window.

---

## ⚙️ Configuration

On first boot, BlanketClaw automatically generates a global configuration directory at `~/.blanketclaw/`. 

### `config.json`
This file manages your providers, models, and API keys. 
* To use **OpenRouter**, add your API key to this file.
* You can define specific `contextWindow` limits and `reasoning` flags for individual models.

### Global Markdown Files
You can customize BlanketClaw's behavior globally by editing these files in the `~/.blanketclaw/` directory:
* `PERSONA.md`: Set the AI's base personality and system rules.
* `USER.md`: Provide context about yourself, your tech stack, or your preferences.
* `MEMORY.md`: A persistent ledger of notes. (You can append to this directly from the CLI using `/memory`).

---

## 🕹️ Command Reference

BlanketClaw uses a standard REPL interface. Standard text is sent to the LLM, while text starting with `/` triggers local system commands (with `[TAB]` autocomplete support).

### **Context & Files**
* `/load <file>` — Load a specific file into the AI's context window.
* `/load src/*.js` — Use wildcards to load multiple files at once.
* `/load all` — Load all readable files in the current working directory.
* `/clear` — Wipe the conversation history.
* `/clear all` — Wipe the conversation history AND unload all context files.

### **Session Management**
* `/model` — Opens an interactive menu to switch between Ollama/OpenRouter and your configured models.
* `/think [show|hidden|off]` — Toggle how reasoning models behave. `show` prints thoughts in a clean UI box, `hidden` parses thoughts silently, and `off` instructs the model to skip thinking entirely.
* `/status` — Displays current active model, loaded files, toggle states, and an estimated **Context Token usage** percentage.
* `/verbose` — Toggles background tool execution logs.
* `/persona [off]` — Unload or reload your global `.md` context files for the current session.

### **Utility**
* `/memory <text>` — Instantly save a persistent note to `~/.blanketclaw/MEMORY.md`.
* `/log` — Exports the entire conversation history and file context array into a readable `.json` file in your current directory.
* `/help` — Show available commands.
* `/quit` — Exit the application.

---

## 🛡️ Security & Tool Calling

BlanketClaw features a **Security Gate** for terminal execution. When the AI attempts to use the `execute_shell` tool, the stream will pause and prompt you:

```text
BlanketClaw wants to run: npm install express
> Allow Once
> Always Allow (Session)
> Deny
```

If you select **Always Allow**, the AI enters full autonomous mode for the remainder of the session, executing commands, reading the outputs, and continuing its work without user intervention. Use this feature with caution.