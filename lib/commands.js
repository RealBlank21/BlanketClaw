import fs from 'fs';
import path from 'path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { state, resetApprovals, estimatePayloadTokens } from './state.js';
import { MEMORY_FILE, activeConfig, saveConfig, invalidateMemoryCache, redactSecrets } from './config.js';
import { buildSystemPrompt } from './prompt.js';
import { toggleLiveLogging } from './logger.js';
import { loadFiles } from './files.js';
import { checkProviderHealth } from './tools.js';
import { gracefulShutdown } from './lifecycle.js';

export async function handleCommand(input) {
    const args = input.trim().split(' ');
    const command = args[0].toLowerCase();

    // We deliberately log every command for the audit trail. /log, /clear,
    // /model, and /debug are operational (not "user commands to the AI") and
    // are excluded so they don't confuse the model. /help, /status, /think,
    // /verbose, /persona, /memory, /tools, and /load are also excluded —
    // they're either purely informational (no behavioral effect on the
    // session), state-toggles (already captured in state), or contextual
    // (/load injects files directly into the prompt rather than into
    // history).
    const silentCommands = new Set([
        '/log', '/clear', '/model', '/debug', '/tools', '/help',
        '/status', '/think', '/verbose', '/persona', '/memory'
    ]);

    if (!silentCommands.has(command) && !command.startsWith('/load')) {
        state.history.push({ role: 'system', content: `[CLI Command Executed by User: ${input}]` });
    }

    switch (command) {
        case '/help': {
            const helpMsg = [
                '/model           - Switch active AI provider and model',
                '/load <file/all> - Load file(s) into AI context (PDF/Office/text)',
                '/load all **     - Load files recursively',
                '/tools           - List currently available MCP tools',
                '/status          - Show session info & loaded files',
                '/think [mode]    - Toggle AI thoughts (show/hidden/off)',
                '/verbose         - Toggle tool execution logs',
                '/debug           - Toggle live stream/error logging to file',
                '/persona [off]   - Toggle global persona/memory',
                '/memory <text>   - Save a persistent note',
                '/log             - Export chat history to JSON',
                '/clear [all]     - Clear history [and files]',
                '/help            - Show this menu',
                '/quit            - Exit BlanketClaw'
            ].join('\n');
            p.note(helpMsg, 'Available Commands');
            break;
        }

        case '/quit': {
            // Forward to the same shutdown path as Ctrl-C so MCP transports
            // and npx children are torn down cleanly. (Previously /quit
            // called process.exit(0) directly, leaking subprocesses.)
            await gracefulShutdown();
            break;
        }

        case '/clear': {
            const wipeAll = args[1] === 'all';
            state.history = [];
            if (wipeAll) {
                state.loadedFiles = [];
                p.note('Conversation history AND loaded files cleared.', 'System');
                state.history.push({ role: 'system', content: '[System Event: Conversation history AND loaded files were cleared.]' });
            } else {
                p.note('Conversation history cleared.', 'System');
                state.history.push({ role: 'system', content: '[System Event: Conversation history was cleared.]' });
            }
            break;
        }

        case '/load': {
            const target = args.slice(1).join(' ');
            if (!target) {
                p.log.warn('Please specify a file, wildcard (*.js), or "all" (use "all **" for recursive)');
                break;
            }

            const s = p.spinner();
            s.start('Parsing and loading files...');

            try {
                // Support both `/load all` (top-level only) and `/load all **`
                // (recursive). The recursive flag is forwarded to loadFiles.
                let pattern = target;
                let recursive = false;
                const recursiveMatch = target.match(/^all(\s+\*\*)?$/);
                if (recursiveMatch && recursiveMatch[1]) {
                    pattern = '**';
                    recursive = true;
                }

                const result = await loadFiles(pattern, { recursive });
                if (result.loaded === 0 && result.protected === 0) {
                    s.stop('No matching files found.');
                    break;
                }
                const tokenMsg = result.tokens > 0
                    ? pc.dim(` (+ ${result.tokens.toLocaleString()} tokens)`)
                    : '';
                const protectedMsg = result.protected > 0
                    ? pc.dim(` (${result.protected} hidden)`)
                    : '';
                s.stop(`Loaded ${result.loaded} file(s)${protectedMsg}.${tokenMsg}`);
            } catch (error) {
                s.stop('Failed to load files.');
                p.log.error(error.message);
            }
            break;
        }

        case '/tools': {
            if (state.availableTools.length === 0) {
                p.note('No MCP tools available. Check /debug for connection errors.', 'Tools');
            } else {
                const lines = state.availableTools.map(t => {
                    const flag = t.isReadOnly ? pc.green('[read]') : pc.yellow('[write]');
                    return `${flag} ${t.function.name}  ${pc.dim('(' + t.serverName + ')')}`;
                });
                p.note(lines.join('\n'), 'Available MCP Tools');
            }
            break;
        }

        case '/status': {
            const systemPrompt = buildSystemPrompt();
            const messages = [{ role: 'system', content: systemPrompt }, ...state.history];
            const ctxTokens = estimatePayloadTokens(messages);
            const ctxPercent = Math.min(100, Math.round((ctxTokens / state.maxContext) * 100));
            const approvedList = Array.from(state.approvedTools);

            const statusMsg = [
                `Model: ${state.provider}/${state.currentModel}`,
                `Context (estimated): ${ctxTokens.toLocaleString()} / ${state.maxContext.toLocaleString()} (${ctxPercent}%)`,
                `Loaded Files: ${state.loadedFiles.length}`,
                `Persona: ${state.personaEnabled ? 'ON' : 'OFF'}`,
                `Thinking: ${state.thinkMode.toUpperCase()}`,
                `Always Allow Tools: ${approvedList.length === 0 ? 'none' : approvedList.join(', ')}`,
                `Available MCP Tools: ${state.availableTools.length}`,
                `Verbose Mode: ${state.isVerbose ? 'ON' : 'OFF'}`
            ].join('\n');
            p.note(statusMsg, 'Status');
            break;
        }

        case '/think': {
            const modes = ['show', 'hidden', 'off'];
            if (args[1] && modes.includes(args[1])) {
                state.thinkMode = args[1];
            } else {
                state.thinkMode = modes[(modes.indexOf(state.thinkMode) + 1) % modes.length];
            }
            p.note(`Thinking mode is now ${state.thinkMode.toUpperCase()}.`, 'System');
            break;
        }

        case '/verbose': {
            state.isVerbose = !state.isVerbose;
            p.note(`Verbose mode is now ${state.isVerbose ? 'ON' : 'OFF'}.`, 'System');
            break;
        }

        case '/debug': {
            const logFile = toggleLiveLogging();
            if (logFile) {
                p.note(`Live logging ENABLED.\n\nOpen a second terminal and paste this to watch:\n\nPowerShell:\nGet-Content -Path "${logFile}" -Wait\n\nBash/Zsh:\ntail -f "${logFile}"`, 'Debug Mode');
            } else {
                p.note('Live logging DISABLED.', 'Debug Mode');
            }
            break;
        }

        case '/persona': {
            if (args[1] === 'off') {
                state.personaEnabled = false;
                p.note('Persona context unloaded for this session.', 'System');
            } else {
                state.personaEnabled = true;
                p.note('Persona context loaded.', 'System');
            }
            break;
        }

        case '/memory': {
            const memo = args.slice(1).join(' ');
            if (!memo) {
                p.log.warn('Please provide text to save. Example: /memory Learn React hooks.');
            } else {
                const date = new Date().toISOString().split('T')[0];
                fs.appendFileSync(MEMORY_FILE, `\n- [${date}] ${memo}`, 'utf-8');
                invalidateMemoryCache();
                p.note('Added to persistent memory.', 'Memory Updated');
            }
            break;
        }

        case '/log': {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const logPath = path.join(process.cwd(), `blanketclaw-log-${timestamp}.json`);

            // Redact secrets in tool-result content before serializing. The
            // debug log path already does this, but /log exports raw history
            // which often contains tool outputs (e.g. `cat .env`) and could
            // leak API keys if the user later shares the file.
            const redactValue = (v) => {
                if (typeof v === 'string') return redactSecrets(v);
                return v;
            };
            const redactMessage = (m) => {
                if (!m) return m;
                const out = { ...m };
                if (typeof out.content === 'string') out.content = redactSecrets(out.content);
                if (Array.isArray(out.content)) {
                    out.content = out.content.map(p => {
                        if (typeof p === 'string') return redactSecrets(p);
                        if (p && typeof p === 'object') {
                            const c = { ...p };
                            if (typeof c.text === 'string') c.text = redactSecrets(c.text);
                            return c;
                        }
                        return p;
                    });
                }
                return out;
            };

            const logExport = {
                exportedAt: new Date().toISOString(),
                currentFilesLoaded: state.loadedFiles.map(f => ({ name: f.name, isProtected: f.isProtected })),
                sessionHistory: state.history.map(redactMessage),
                state: {
                    provider: state.provider,
                    model: state.currentModel,
                    thinkMode: state.thinkMode,
                    personaEnabled: state.personaEnabled,
                    approvedTools: Array.from(state.approvedTools)
                }
            };

            // Never serialize API keys into the export even if state ever
            // ends up holding them. Cheap belt-and-suspenders.
            const sanitizedJson = redactSecrets(JSON.stringify(logExport, (_k, v) => redactValue(v), 2));
            fs.writeFileSync(logPath, sanitizedJson, 'utf-8');
            p.note(`Session exported to:\n${logPath}`, 'Log Saved');
            break;
        }

        case '/model': {
            const providerNames = Object.keys(activeConfig.providers);
            const providerChoice = await p.select({
                message: pc.cyan('Select Provider:'),
                options: providerNames.map(p => ({ value: p, label: p }))
            });
            if (p.isCancel(providerChoice)) break;

            const models = activeConfig.providers[providerChoice].models;
            const modelChoice = await p.select({
                message: pc.cyan('Select Model:'),
                options: models.map(m => ({ value: m.id, label: `${m.name}${m.reasoning ? ' 🧠' : ''}` }))
            });
            if (p.isCancel(modelChoice)) break;

            activeConfig.activeProvider = providerChoice;
            activeConfig.activeModelId = modelChoice;
            saveConfig();

            state.provider = providerChoice;
            state.currentModel = modelChoice;
            state.modelConfig = models.find(m => m.id === modelChoice);
            // Defensive: if the model somehow isn't in the list (e.g. config
            // drift between sessions), fall back to a safe default rather
            // than dereferencing undefined.contextWindow and crashing.
            if (!state.modelConfig) {
                state.modelConfig = { reasoning: false };
                state.maxContext = 128000;
            } else {
                state.maxContext = state.modelConfig.contextWindow;
            }

            // Reset any "Always Allow" tool approvals when switching providers
            // or models — a tool the user trusted for model A might behave very
            // differently under model B's tool dispatcher.
            resetApprovals();

            if (!state.modelConfig.reasoning && state.thinkMode !== 'off') {
                state.thinkMode = 'off';
            } else if (state.modelConfig.reasoning && state.thinkMode === 'off') {
                state.thinkMode = 'show';
            }

            // Health-check the new provider so we fail fast if it's down.
            const health = await checkProviderHealth(activeConfig.providers[providerChoice]);
            const healthLine = health.ok ? pc.green(`Provider reachable: ${health.message}`) : pc.red(`Provider unreachable: ${health.message}`);

            p.note(`Switched to ${providerChoice}/${modelChoice}\n${healthLine}`, 'Model Changed');
            break;
        }

        default:
            p.log.warn(`Unknown command: ${command}`);
    }
}