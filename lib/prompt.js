import os from 'os';
import { state } from './state.js';
import { readPersona, readUser, readMemory, PERSONA_FILE, USER_FILE, MEMORY_FILE } from './config.js';

export function buildSystemPrompt() {
    let prompt = ``;

    if (state.personaEnabled) {
        const persona = readPersona();
        if (persona) prompt += persona + '\n\n';
    }

    prompt += `[SYSTEM OPERATIONAL DIRECTIVES]\n`;
    prompt += `CRITICAL INSTRUCTION: You HAVE direct access to the user's file system via tools. If files are listed below in the LOADED FILES section, you CAN see them and read their content.\n\n`;

    prompt += `TOOL USAGE DIRECTIVE: You are connected to Model Context Protocol (MCP) servers. If you need to perform an action (create files, directories, run scripts), you MUST use the provided native tools.\n\n`;

    if (state.thinkMode === 'off') {
        prompt += `CRITICAL INSTRUCTION: DO NOT output any <think> reasoning blocks. Provide your direct, final answer immediately.\n\n`;
    }

    prompt += `[SYSTEM HARDWARE CONTEXT]\n`;
    prompt += `OS: ${os.platform()} ${os.release()}\n`;
    prompt += `CPU: ${os.cpus()[0].model}\n`;
    prompt += `RAM: ${Math.round(os.totalmem() / 1073741824)}GB Total / ${Math.round(os.freemem() / 1073741824)}GB Free\n`;
    prompt += `CWD: ${process.cwd()}\n\n`;

    if (state.personaEnabled) {
        const userCtx = readUser();
        if (userCtx) prompt += userCtx + '\n\n';
        const memCtx = readMemory();
        if (memCtx) prompt += memCtx + '\n\n';
    }

    if (state.loadedFiles.length > 0) {
        prompt += `--- LOADED FILES ---\n`;
        const readableFiles = state.loadedFiles.filter(f => !f.isProtected);

        for (const file of readableFiles) {
            prompt += `\n[${file.name}]\n${file.content}\n`;
        }
    }

    return prompt;
}

// Re-export file paths for any module that needs them.
export { PERSONA_FILE, USER_FILE, MEMORY_FILE };