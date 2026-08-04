import fs from 'fs';
import path from 'path';
import os from 'os';
import { logDebug } from './logger.js';

export const GLOBAL_DIR = path.join(os.homedir(), '.blanketclaw');
export const CACHE_DIR = path.join(GLOBAL_DIR, 'cache');
export const CONFIG_FILE = path.join(GLOBAL_DIR, 'config.json');
export const PERSONA_FILE = path.join(GLOBAL_DIR, 'PERSONA.md');
export const USER_FILE = path.join(GLOBAL_DIR, 'USER.md');
export const MEMORY_FILE = path.join(GLOBAL_DIR, 'MEMORY.md');

export let activeConfig = {};

// Cache for persona/user/memory file reads so we don't fsync on every turn.
// Invalidated when file mtime changes (cheap stat).
const personaCache = { text: null, mtime: 0, exists: false };
const userCache = { text: null, mtime: 0, exists: false };
const memoryCache = { text: null, mtime: 0, exists: false };

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

// Safe config loader. If the user's config.json is corrupt we:
//   1. Back up the broken file to config.json.broken-<timestamp>
//   2. Reset to defaults
//   3. Log the event so they can recover their API keys
// Previously this silently swallowed the error and nuked API keys.
export function loadConfig() {
    try {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
        activeConfig = JSON.parse(raw);
        return activeConfig;
    } catch (error) {
        logDebug('config_error', `Failed to load config: ${error.message}. Resetting to defaults.`);
        // Best-effort backup of the broken file so the user can recover it.
        try {
            const backup = `${CONFIG_FILE}.broken-${Date.now()}`;
            fs.copyFileSync(CONFIG_FILE, backup);
            logDebug('config_backup', `Backed up broken config to ${backup}`);
        } catch (_) { /* ignore */ }
        activeConfig = JSON.parse(JSON.stringify(defaultConfig));
        try {
            saveConfig();
        } catch (_) { /* ignore */ }
        return activeConfig;
    }
}

export function saveConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(activeConfig, null, 2), 'utf-8');
}

// Read a global markdown file with an mtime-based cache. Returns '' if missing.
// The cache is per-file and invalidated automatically when the user edits the
// file from outside the CLI.
function readCached(filePath, cache) {
    try {
        const stat = fs.statSync(filePath);
        if (!cache.exists || stat.mtimeMs !== cache.mtime) {
            cache.text = fs.readFileSync(filePath, 'utf-8');
            cache.mtime = stat.mtimeMs;
            cache.exists = true;
        }
        return cache.text;
    } catch (_) {
        cache.exists = false;
        cache.text = null;
        cache.mtime = 0;
        return '';
    }
}

export function readPersona() { return readCached(PERSONA_FILE, personaCache); }
export function readUser() { return readCached(USER_FILE, userCache); }
export function readMemory() { return readCached(MEMORY_FILE, memoryCache); }

// Explicit invalidation (e.g., after /memory append).
export function invalidateMemoryCache() { memoryCache.mtime = 0; }

// Redact API keys from arbitrary text before it lands in a log file.
// We only redact well-formed strings; we never try to be clever with partials.
export function redactSecrets(text) {
    if (typeof text !== 'string') return text;
    let out = text;
    // OpenAI / OpenRouter style keys
    out = out.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_API_KEY]');
    out = out.replace(/\bsk-or-v1-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_API_KEY]');
    // Anthropic
    out = out.replace(/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_API_KEY]');
    // GitHub
    out = out.replace(/\bghp_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]');
    out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]');
    // AWS access key IDs (AKIA / ASIA prefixes)
    out = out.replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]');
    // Google API keys (AIza...)
    out = out.replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED_GOOGLE_KEY]');
    // JWTs (three base64url segments separated by dots, header always starts with 'eyJ')
    out = out.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]');
    // Authorization headers
    out = out.replace(/(Authorization:\s*Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]');
    return out;
}