import fs from 'fs';
import path from 'path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { state } from './state.js';
import { handleLoadFiles } from './files.js';
import { MEMORY_FILE, activeConfig, saveConfig } from './config.js';
import { buildSystemPrompt } from './prompt.js';
import { toggleLiveLogging } from './logger.js';

export async function handleCommand(input) {
    const args = input.trim().split(' ');
    const command = args[0].toLowerCase();

    if (command !== '/log' && command !== '/clear' && command !== '/model' && command !== '/debug') {
        state.history.push({ role: 'system', content: `[CLI Command Executed by User: ${input}]` });
    }

    switch (command) {
        case '/help':
            const helpMsg = `/model           - Switch active AI provider and model\n/load <file/all> - Load file(s) into AI context\n/status          - Show session info & loaded files\n/think [mode]    - Toggle AI thoughts (show/hidden/off)\n/verbose         - Toggle tool execution logs\n/debug           - Toggle live stream/error logging to file\n/persona [off]   - Toggle global persona/memory\n/memory <text>   - Save a persistent note\n/log             - Export chat history to JSON\n/clear [all]     - Clear history [and files]\n/help            - Show this menu\n/quit            - Exit BlanketClaw`;
            p.note(helpMsg, 'Available Commands');
            break;
        case '/quit':
            p.outro(pc.green('Goodbye!'));
            process.exit(0);
        case '/clear':
            if (args[1] === 'all') {
                state.history = [];
                state.loadedFiles = [];
                p.note('Conversation history and loaded files cleared.', 'System');
            } else {
                state.history = [];
                p.note('Conversation history cleared.', 'System');
            }
            state.history.push({ role: 'system', content: '[System Event: Conversation history was cleared.]' });
            break;
        case '/load':
            const target = args.slice(1).join(' ');
            if (!target) {
                p.log.warn('Please specify a file, wildcard (*.js), or "all"');
            } else {
                const res = handleLoadFiles(target);
                if (res && res.loadedNames.length > 0) {
                    state.history.push({
                        role: 'assistant',
                        content: `Acknowledged. I have loaded and can now see the following files in my context: ${res.loadedNames.join(', ')}`
                    });
                }
            }
            break;
        case '/status':
            const systemPrompt = buildSystemPrompt();
            const fullPayload = JSON.stringify([{ role: 'system', content: systemPrompt }, ...state.history]);
            const ctxTokens = Math.ceil(fullPayload.length / 4);
            const ctxPercent = Math.min(100, Math.round((ctxTokens / state.maxContext) * 100));
            
            const statusMsg = `Model: ${state.provider}/${state.currentModel}\nContext: ${ctxTokens.toLocaleString()} / ${state.maxContext.toLocaleString()} (${ctxPercent}%)\nLoaded Files: ${state.loadedFiles.length}\nPersona: ${state.personaEnabled ? 'ON' : 'OFF'}\nThinking: ${state.thinkMode.toUpperCase()}\nAlways Allow Shell: ${state.alwaysAllowShell ? 'YES' : 'NO'}`;
            p.note(statusMsg, 'Status');
            break;
        case '/think':
            const modes = ['show', 'hidden', 'off'];
            if (args[1] && modes.includes(args[1])) {
                state.thinkMode = args[1];
            } else {
                state.thinkMode = modes[(modes.indexOf(state.thinkMode) + 1) % modes.length];
            }
            p.note(`Thinking mode is now ${state.thinkMode.toUpperCase()}.`, 'System');
            break;
        case '/verbose':
            state.isVerbose = !state.isVerbose;
            p.note(`Verbose mode is now ${state.isVerbose ? 'ON' : 'OFF'}.`, 'System');
            break;
        case '/debug':
            const logFile = toggleLiveLogging();
            if (logFile) {
                p.note(`Live logging ENABLED.\n\nOpen a second terminal and paste this to watch:\n\nPowerShell:\nGet-Content -Path "${logFile}" -Wait\n\nBash/Zsh:\ntail -f "${logFile}"`, 'Debug Mode');
            } else {
                p.note('Live logging DISABLED.', 'Debug Mode');
            }
            break;
        case '/persona':
            if (args[1] === 'off') {
                state.personaEnabled = false;
                p.note('Persona context unloaded for this session.', 'System');
            } else {
                state.personaEnabled = true;
                p.note('Persona context loaded.', 'System');
            }
            break;
        case '/memory':
            const memo = args.slice(1).join(' ');
            if (!memo) {
                p.log.warn('Please provide text to save. Example: /memory Learn React hooks.');
            } else {
                const date = new Date().toISOString().split('T')[0];
                fs.appendFileSync(MEMORY_FILE, `\n- [${date}] ${memo}`, 'utf-8');
                p.note('Added to persistent memory.', 'Memory Updated');
            }
            break;
        case '/log':
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const logPath = path.join(process.cwd(), `blanketclaw-log-${timestamp}.json`);
            
            const logExport = {
                exportedAt: new Date().toISOString(),
                currentFilesLoaded: state.loadedFiles.map(f => ({ name: f.name, isProtected: f.isProtected })),
                sessionHistory: state.history
            };

            fs.writeFileSync(logPath, JSON.stringify(logExport, null, 2), 'utf-8');
            p.note(`Session exported to:\n${logPath}`, 'Log Saved');
            break;
        case '/model':
            const providerNames = Object.keys(activeConfig.providers);
            const providerChoice = await p.select({
                message: pc.cyan('Select Provider:'),
                options: providerNames.map(p => ({ value: p, label: p }))
            });

            if (p.isCancel(providerChoice)) break;

            const models = activeConfig.providers[providerChoice].models;
            const modelChoice = await p.select({
                message: pc.cyan('Select Model:'),
                options: models.map(m => ({ value: m.id, label: m.name }))
            });

            if (p.isCancel(modelChoice)) break;

            activeConfig.activeProvider = providerChoice;
            activeConfig.activeModelId = modelChoice;
            saveConfig();

            state.provider = providerChoice;
            state.currentModel = modelChoice;
            state.modelConfig = models.find(m => m.id === modelChoice);
            state.maxContext = state.modelConfig.contextWindow;

            if (!state.modelConfig.reasoning && state.thinkMode !== 'off') {
                state.thinkMode = 'off';
            } else if (state.modelConfig.reasoning && state.thinkMode === 'off') {
                state.thinkMode = 'show';
            }

            p.note(`Switched to ${providerChoice}/${modelChoice}`, 'Model Changed');
            break;
        default:
            p.log.warn(`Unknown command: ${command}`);
    }
}