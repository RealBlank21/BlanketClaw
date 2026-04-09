import fs from 'fs';
import path from 'path';
import os from 'os';

const GLOBAL_DIR = path.join(os.homedir(), '.blanketclaw');
export let currentLogFile = null;
export let isLoggingActive = false;

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

export function logDebug(category, message, data = null) {
    if (!isLoggingActive || !currentLogFile) return;

    const timestamp = new Date().toISOString();
    let logLine = `[${timestamp}] [${category.toUpperCase()}] ${message}\n`;
    
    if (data) {
        try {
            logLine += typeof data === 'object' ? JSON.stringify(data, null, 2) + '\n' : data + '\n';
        } catch (e) {
            logLine += '[Unserializable Data]\n';
        }
    }
    
    try {
        fs.appendFileSync(currentLogFile, logLine + '\n', 'utf-8');
    } catch (e) {}
}