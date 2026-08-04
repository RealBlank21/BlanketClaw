import fs from 'fs';
import path from 'path';
import os from 'os';
import { redactSecrets } from './config.js';

const GLOBAL_DIR = path.join(os.homedir(), '.blanketclaw');
export let currentLogFile = null;
export let isLoggingActive = false;

// Optional streaming tool-audit log. We keep this separate from the main debug
// log so the user can tail just the tool call stream while debugging.
export let currentToolLogFile = null;

export function toggleLiveLogging() {
    isLoggingActive = !isLoggingActive;
    if (isLoggingActive) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        currentLogFile = path.join(GLOBAL_DIR, `debug-${timestamp}.log`);
        fs.writeFileSync(currentLogFile, `[SYSTEM] Live logging initialized at ${new Date().toISOString()}\n\n`, 'utf-8');
        return currentLogFile;
    } else {
        currentLogFile = null;
        return null;
    }
}

function safe(data) {
    try {
        if (typeof data === 'string') return redactSecrets(data);
        return JSON.stringify(data, (_k, v) => {
            if (typeof v === 'string') return redactSecrets(v);
            return v;
        }, 2);
    } catch (_) {
        return '[Unserializable Data]';
    }
}

export function logDebug(category, message, data = null) {
    if (!isLoggingActive || !currentLogFile) return;

    const timestamp = new Date().toISOString();
    let logLine = `[${timestamp}] [${category.toUpperCase()}] ${redactSecrets(message)}\n`;

    if (data !== null && data !== undefined) {
        logLine += safe(data) + '\n';
    }

    try {
        fs.appendFileSync(currentLogFile, logLine + '\n', 'utf-8');
    } catch (_) { /* ignore */ }
}

// Dedicated tool-call audit log. Always records every tool execution attempt
// regardless of /debug, but only when /debug is on does it actually write to
// disk. This gives users a forensic trail if something goes sideways.
export function logToolCall(toolName, args, result, status) {
    if (!isLoggingActive) return;
    try {
        if (!currentToolLogFile) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            currentToolLogFile = path.join(GLOBAL_DIR, `tools-${timestamp}.log`);
        }
        const line = [
            `[${new Date().toISOString()}]`,
            `[${status.toUpperCase()}]`,
            `tool=${toolName}`,
            `args=${safe(args)}`,
            `result=${safe(typeof result === 'string' ? result.slice(0, 4000) : result)}${typeof result === 'string' && result.length > 4000 ? '...[truncated]' : ''}`,
            ''
        ].join('\n');
        fs.appendFileSync(currentToolLogFile, line, 'utf-8');
    } catch (_) { /* ignore */ }
}