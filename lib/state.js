// Central session state. Treated as a singleton; mutated freely.
// Tool registry and per-tool auto-approval live here so they're testable
// and so MCP code doesn't leak module-level mutable globals.

import fs from 'fs';
import path from 'path';

export const state = {
    history: [],
    loadedFiles: [],
    currentModel: '',
    provider: '',
    thinkMode: 'show',
    maxContext: 0,
    isVerbose: false,
    personaEnabled: true,
    modelConfig: {},

    // Per-tool auto-approval set (replaces the old global `alwaysAllowShell` flag).
    // Each entry is a tool name the user has explicitly blessed for the session.
    approvedTools: new Set(),

    // Tools registry, populated by setupMcp() and updated on /model switch.
    // Each entry: { type: 'function', function: { name, description, parameters }, serverName, isReadOnly }
    availableTools: [],

    // Map of tool name -> Client (MCP connection) for dispatching calls.
    mcpClients: {},

    // Map of tool name -> server name, used for shutdown + diagnostics.
    mcpServers: {}
};

// ---- Token estimation ----------------------------------------------------
// 4-chars-per-token is a rough English heuristic but works well enough for
// /status reporting. We deliberately avoid pulling in a full tokenizer so the
// install footprint stays small. The accuracy is documented in /status.
export function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

// Estimate the size of an entire OpenAI-style messages payload.
export function estimatePayloadTokens(messages) {
    let totalChars = 0;
    for (const m of messages) {
        // content may be string or array of parts
        if (typeof m.content === 'string') totalChars += m.content.length;
        else if (Array.isArray(m.content)) {
            for (const part of m.content) {
                if (typeof part === 'string') totalChars += part.length;
                else if (part && typeof part === 'object') totalChars += JSON.stringify(part).length;
            }
        }
        totalChars += (m.role || '').length;
        if (m.tool_calls) totalChars += JSON.stringify(m.tool_calls).length;
        if (m.name) totalChars += m.name.length;
    }
    return Math.ceil(totalChars / 4);
}

// Reset all session-scoped approval state. Called on /model switch so a
// user moving to a new provider isn't silently trusting tools there.
export function resetApprovals() {
    state.approvedTools.clear();
}

// ---- Pending history write (shared with the lifecycle module) -----------
// index.js populates these via scheduleHistoryWrite(); lib/lifecycle.js
// flushes them on shutdown via flushHistoryWrite(). Kept here so we don't
// have to dance around circular imports.
let _pending = null;
let _timer = null;

function _doWrite(historyFile, history) {
    try {
        const dir = path.dirname(historyFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(historyFile, history.join('\n') + '\n', 'utf-8');
    } catch (_) { /* ignore */ }
}

export function scheduleHistoryWrite(history, historyFile) {
    _pending = { history, historyFile };
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(() => {
        const p = _pending;
        _pending = null;
        _timer = null;
        if (p) _doWrite(p.historyFile, p.history);
    }, 500);
}

export function flushHistoryWrite() {
    if (!_pending) return;
    if (_timer) { clearTimeout(_timer); _timer = null; }
    const p = _pending;
    _pending = null;
    _doWrite(p.historyFile, p.history);
}