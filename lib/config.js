import fs from 'fs';
import path from 'path';
import os from 'os';

export const GLOBAL_DIR = path.join(os.homedir(), '.blanketclaw');
export const CACHE_DIR = path.join(GLOBAL_DIR, 'cache');
export const CONFIG_FILE = path.join(GLOBAL_DIR, 'config.json');
export const PERSONA_FILE = path.join(GLOBAL_DIR, 'PERSONA.md');
export const USER_FILE = path.join(GLOBAL_DIR, 'USER.md');
export const MEMORY_FILE = path.join(GLOBAL_DIR, 'MEMORY.md');

export let activeConfig = {};

const defaultConfig = {
  activeProvider: "ollama",
  activeModelId: "llama3.1",
  providers: {
    ollama: {
      baseUrl: "http://127.0.0.1:11434",
      apiKey: "",
      models: [
        {
          id: "llama3.1",
          name: "Llama 3.1 8B",
          reasoning: false,
          contextWindow: 128000
        },
        {
          id: "qwen2.5-coder",
          name: "Qwen 2.5 Coder",
          reasoning: false,
          contextWindow: 32000
        },
        {
          id: "deepseek-r1",
          name: "DeepSeek R1",
          reasoning: true,
          contextWindow: 128000
        }
      ]
    },
    openrouter: {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "YOUR_OPENROUTER_KEY",
      models: [
        {
          id: "anthropic/claude-3.5-sonnet",
          name: "Claude 3.5 Sonnet",
          reasoning: false,
          contextWindow: 200000
        },
        {
          id: "deepseek/deepseek-r1",
          name: "DeepSeek R1 (OpenRouter)",
          reasoning: true,
          contextWindow: 128000
        }
      ]
    }
  }
};

export function initializeGlobalDirectory() {
    if (!fs.existsSync(GLOBAL_DIR)) fs.mkdirSync(GLOBAL_DIR, { recursive: true });
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

    const defaultFiles = [
        { path: CONFIG_FILE, content: JSON.stringify(defaultConfig, null, 2) },
        { path: PERSONA_FILE, content: "You are BlanketClaw, an autonomous CLI developer assistant running locally on the user's machine." },
        { path: USER_FILE, content: "" },
        { path: MEMORY_FILE, content: "" }
    ];

    defaultFiles.forEach(file => {
        if (!fs.existsSync(file.path)) {
            fs.writeFileSync(file.path, file.content, 'utf-8');
        }
    });
}

export function loadConfig() {
    try {
        activeConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        return activeConfig;
    } catch (error) {
        activeConfig = defaultConfig;
        return activeConfig;
    }
}

export function saveConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(activeConfig, null, 2), 'utf-8');
}