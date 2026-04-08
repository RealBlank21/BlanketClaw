import fs from 'fs';
import os from 'os';
import { state } from './state.js';
import { PERSONA_FILE, USER_FILE, MEMORY_FILE } from './config.js';

export function buildSystemPrompt() {
    let prompt = ``;

    if (state.personaEnabled && fs.existsSync(PERSONA_FILE)) {
        prompt += fs.readFileSync(PERSONA_FILE, 'utf-8') + '\n\n';
    }

    prompt += `[SYSTEM OPERATIONAL DIRECTIVES]\n`;
    prompt += `CRITICAL INSTRUCTION: You HAVE direct access to the user's file system via tools and context injection. If files are listed below in the LOADED FILES section, you CAN see them and read their content. Never claim you cannot see files or ask the user to upload them.\n\n`;
    
    prompt += `TOOL USAGE DIRECTIVE: If you need to perform an action (create files, directories, run scripts), you MUST use the provided 'execute_shell' tool. Do not just write the command in text. If a user request requires multiple steps (e.g., "create a folder AND a file"), you must continue using tools one after another until the entire task is complete.\n\n`;

    if (state.thinkMode === 'off') {
        prompt += `CRITICAL INSTRUCTION: DO NOT output any <think> reasoning blocks. Provide your direct, final answer immediately.\n\n`;
    }

    prompt += `[SYSTEM HARDWARE CONTEXT]\n`;
    prompt += `OS: ${os.platform()} ${os.release()}\n`;
    prompt += `CPU: ${os.cpus()[0].model}\n`;
    prompt += `RAM: ${Math.round(os.totalmem() / 1073741824)}GB Total / ${Math.round(os.freemem() / 1073741824)}GB Free\n`;
    prompt += `CWD: ${process.cwd()}\n\n`;

    if (state.personaEnabled) {
        if (fs.existsSync(USER_FILE)) prompt += fs.readFileSync(USER_FILE, 'utf-8') + '\n\n';
        if (fs.existsSync(MEMORY_FILE)) prompt += fs.readFileSync(MEMORY_FILE, 'utf-8') + '\n\n';
    }

    if (state.loadedFiles.length > 0) {
        prompt += `--- LOADED FILES ---\n`;
        const protectedFiles = state.loadedFiles.filter(f => f.isProtected);
        const readableFiles = state.loadedFiles.filter(f => !f.isProtected);

        for (const file of readableFiles) {
            prompt += `\n[${file.name}]\n${file.content}\n`;
        }

        if (protectedFiles.length > 0) {
            prompt += `\n[Protected/Ignored Files in Directory]\n`;
            for (const file of protectedFiles) {
                prompt += `- ${file.name} ${file.content}\n`;
            }
        }
    }

    return prompt;
}