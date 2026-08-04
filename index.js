#!/usr/bin/env node
import * as p from '@clack/prompts';
import pc from 'picocolors';
import readline from 'readline';
import fg from 'fast-glob';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { state, scheduleHistoryWrite } from './lib/state.js';
import { initializeGlobalDirectory, loadConfig, GLOBAL_DIR, activeConfig } from './lib/config.js';
import { buildSystemPrompt } from './lib/prompt.js';
import { streamOllama, streamOpenRouter } from './lib/api.js';
import { executeTool, setupMcp, checkProviderHealth } from './lib/tools.js';
import { handleCommand } from './lib/commands.js';
import { logDebug } from './lib/logger.js';
import { gracefulShutdown } from './lib/lifecycle.js';

// ---------- Visual state helpers -----------------------------------------
//
// We render the assistant's response inside a vertical box drawn with `│`.
// Every time we start a turn we open the box; every time we exit (clean,
// error, or tool dispatch) we MUST close it so a stray error mid-stream
// doesn't leave the terminal visually broken.
let boxOpen = false;

function openBox() {
    if (boxOpen) return;
    process.stdout.write(pc.gray('│\n') + pc.magenta('◆  ') + pc.green('BlanketClaw\n') + pc.gray('│  '));
    boxOpen = true;
}

function closeBox() {
    if (!boxOpen) return;
    process.stdout.write('\n' + pc.gray('│\n'));
    boxOpen = false;
}

function closeThinking(inThinking) {
    if (!inThinking) return;
    if (state.thinkMode === 'show') {
        process.stdout.write(pc.dim('\n') + pc.gray('│  ') + pc.dim('└─ [Done]\n') + pc.gray('│  '));
    }
}

// ---------- LLM trigger ---------------------------------------------------
//
// retryCount limits the "model thought but said nothing" auto-retry. We
// previously recursed synchronously, stacking user-turn warnings. Now we
// dedupe them: at most one warning is queued per attempt, and the retry
// uses the same history without inserting extra user turns.
async function triggerLLM(retryCount = 0) {
    const systemPrompt = buildSystemPrompt();
    const apiMessages = [
        { role: 'system', content: systemPrompt },
        ...state.history
    ];

    logDebug('system', 'Triggering LLM with conversation state', { historyLength: state.history.length, provider: state.provider });

    openBox();

    // Visual feedback while we wait for the first token. We use a tiny
    // self-managed spinner (frame rotation) so we don't fight @clack/prompts'
    // spinner for the box-drawn output stream — mixing them caused the
    // vertical-bar prefix to mis-align in earlier iterations.
    const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let spinnerFrameIdx = 0;
    let spinnerActive = false;
    let spinnerInterval = null;
    const startSpinner = () => {
        if (spinnerActive) return;
        spinnerActive = true;
        process.stdout.write(pc.cyan(spinnerFrames[0]));
        spinnerInterval = setInterval(() => {
            spinnerFrameIdx = (spinnerFrameIdx + 1) % spinnerFrames.length;
            process.stdout.write('\r' + pc.cyan(spinnerFrames[spinnerFrameIdx]));
        }, 80);
    };
    const stopSpinner = () => {
        if (!spinnerActive) return;
        spinnerActive = false;
        if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
        // Erase the spinner glyph so the response renders cleanly.
        process.stdout.write('\r\x1b[K');
    };
    startSpinner();

    let fullResponse = "";
    let fullThinking = "";
    let toolCalls = [];
    let _streamErrors = {};

    let inThinking = false;
    let inCodeBlock = false;

    function printNormal(text) {
        const parts = text.split('```');

        for (let i = 0; i < parts.length; i++) {
            if (i > 0) inCodeBlock = !inCodeBlock;

            const chunk = parts[i];

            const lines = chunk.split('\n');
            for (let j = 0; j < lines.length; j++) {
                let lineText = lines[j];

                if (inCodeBlock) {
                    lineText = pc.cyan(lineText);
                } else {
                    // Use the regex replacement string `'$1'` so the backref
                    // is preserved literally. (This was previously a source
                    // of confusion; the old code worked because it was
                    // already inside a .replace call.)
                    lineText = lineText.replace(/\*\*(.*?)\*\*/g, pc.bold(pc.white('$1')));
                    lineText = lineText.replace(/`([^`]+)`/g, pc.yellow('$1'));
                }

                process.stdout.write(lineText);

                if (j < lines.length - 1) {
                    process.stdout.write('\n' + pc.gray('│  '));
                }
            }
        }
    }

    function printThink(text) {
        if (state.thinkMode !== 'show') return;
        const parts = text.split('\n');
        for (let i = 0; i < parts.length; i++) {
            process.stdout.write(pc.dim(parts[i]));
            if (i < parts.length - 1) {
                process.stdout.write('\n' + pc.gray('│  ') + pc.dim('│  '));
            }
        }
    }

    const onChunkCallback = (contentToken, thinkingToken) => {
        // First token cancels the wait spinner.
        stopSpinner();
        if (thinkingToken) {
            if (!inThinking) {
                inThinking = true;
                if (state.thinkMode === 'show') {
                    process.stdout.write(pc.dim('\n') + pc.gray('│  ') + pc.dim('┌─ [Thinking]\n') + pc.gray('│  ') + pc.dim('│  '));
                }
            }
            fullThinking += thinkingToken;
            printThink(thinkingToken);
        }

        if (contentToken) {
            if (inThinking) {
                inThinking = false;
                if (state.thinkMode === 'show') {
                    process.stdout.write(pc.dim('\n') + pc.gray('│  ') + pc.dim('└─ [Done]\n') + pc.gray('│  '));
                }
            }

            fullResponse += contentToken;
            printNormal(contentToken);
        }
    };

    try {
        if (state.provider === 'ollama') {
            // Verify provider reachability before streaming — fail fast.
            const health = await checkProviderHealth(activeConfig.providers.ollama);
            if (!health.ok) {
                stopSpinner();
                closeThinking(inThinking);
                closeBox();
                process.stdout.write(pc.red(`│  Cannot reach Ollama: ${health.message}\n`));
                return;
            }
            const result = await streamOllama(apiMessages, onChunkCallback);
            toolCalls = result.toolCalls;
            _streamErrors = result.errors;
        } else if (state.provider === 'openrouter') {
            if (!activeConfig.providers.openrouter.apiKey || activeConfig.providers.openrouter.apiKey === "YOUR_OPENROUTER_KEY") {
                stopSpinner();
                closeThinking(inThinking);
                closeBox();
                process.stdout.write(pc.red(`│  Error: Please set your OpenRouter API Key in ~/.blanketclaw/config.json\n`));
                return;
            }
            const result = await streamOpenRouter(apiMessages, onChunkCallback);
            toolCalls = result.toolCalls;
            _streamErrors = result.errors;
        } else {
            logDebug('error', `Unknown provider '${state.provider}'`);
            stopSpinner();
            closeThinking(inThinking);
            closeBox();
            process.stdout.write(pc.red(`│  Error: Unknown provider '${state.provider}'\n`));
            return;
        }
    } catch (error) {
        logDebug('fatal_error', 'triggerLLM Stream Failure', { message: error.message });
        stopSpinner();
        closeThinking(inThinking);
        closeBox();
        process.stdout.write(pc.red(`│  Error: ${error.message}\n`));
        return;
    }

    closeThinking(inThinking);

    // Ensure each captured tool call has an id (some providers omit it).
    if (toolCalls && toolCalls.length > 0) {
        for (const tc of toolCalls) {
            if (!tc.id) tc.id = `call_${Math.random().toString(36).substring(2, 11)}`;
        }
    }

    if (fullResponse.trim() !== "" || (toolCalls && toolCalls.length > 0)) {
        closeBox();

        const assistantMessage = { role: 'assistant', content: fullResponse.trim() };

        if (toolCalls && toolCalls.length > 0) {
            assistantMessage.tool_calls = toolCalls;
        }

        if (assistantMessage.content !== "" || (toolCalls && toolCalls.length > 0)) {
            state.history.push(assistantMessage);
        }
    } else {
        logDebug('warn', 'LLM returned empty response and no tools.');
        closeBox();
        process.stdout.write(pc.yellow(`│  [System: Model generated reasoning but failed to output a response or call a tool.]\n`));

        if (retryCount < 3) {
            process.stdout.write(pc.cyan(`│  [Auto-Retry ${retryCount + 1}/3]: Prompting model to use native tools...\n`));
            process.stdout.write(pc.gray('│\n'));

            // Find the LAST occurrence of the warning we added so we don't
            // stack duplicates if retryCount > 0. This prevents the bug where
            // history ended up with N stacked warnings for N retries.
            const warningMsg = "SYSTEM WARNING: You generated a thought process but did not output any text or invoke any tools. You MUST invoke a native tool to complete the action.";
            const lastWarningIdx = (() => {
                for (let i = state.history.length - 1; i >= 0; i--) {
                    if (state.history[i]?.role === 'user' && state.history[i]?.content === warningMsg) {
                        return i;
                    }
                }
                return -1;
            })();

            if (lastWarningIdx === -1) {
                state.history.push({ role: 'user', content: warningMsg });
            }
            await triggerLLM(retryCount + 1);
            return;
        } else {
            process.stdout.write(pc.red(`│  [System]: AI failed to execute correctly after 3 attempts. Aborting.\n`));
            process.stdout.write(pc.gray('│\n'));
        }
    }

    if (toolCalls && toolCalls.length > 0) {
        const errors = _streamErrors || {};

        for (const tc of toolCalls) {
            // If we couldn't parse the args, surface that as a tool error
            // message so the LLM can self-correct on the next turn rather
            // than us silently calling a tool with `{}`.
            if (errors[tc.id]) {
                state.history.push({
                    role: 'tool',
                    name: tc.function.name,
                    content: `Error: ${errors[tc.id]}`,
                    tool_call_id: tc.id
                });
                continue;
            }

            const toolResult = await executeTool(tc);

            state.history.push({
                role: 'tool',
                name: tc.function.name,
                content: String(toolResult),
                tool_call_id: tc.id
            });
        }

        await triggerLLM(0);
    }
}

// ---------- Main REPL -----------------------------------------------------

async function mainLoop() {
    // History file lives next to global config so up-arrow recall works
    // across sessions. We persist between runs.
    const historyFile = path.join(os.homedir(), '.blanketclaw', 'input-history');
    let history = [];
    try {
        if (fs.existsSync(historyFile)) {
            history = fs.readFileSync(historyFile, 'utf-8').split('\n').filter(Boolean).reverse();
        }
    } catch (_) { /* ignore */ }

    const commands = ['/help', '/model', '/quit', '/clear', '/clear all', '/load', '/load all', '/load all **', '/tools', '/status', '/think', '/verbose', '/persona', '/persona off', '/memory', '/log', '/debug'];

    while (true) {
        const input = await new Promise((resolve) => {
            let lines = [];
            let pasteTimeout;
            let isResolved = false;

            process.stdin.resume();

            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
                history: history,
                historySize: 500,
                completer: (line, callback) => {
                    if (line.startsWith('/load ')) {
                        const search = line.replace('/load ', '');
                        // Use the same depth as /load all (currently 1) for
                        // completion parity. Users can still pass '**' to the
                        // /load command itself for recursive globs.
                        fg(search ? `${search}*` : '*', { dot: true, onlyFiles: false, deep: 1 })
                            .then(files => {
                                const hits = files.map(f => `/load ${f}`);
                                callback(null, [hits.length ? hits : [], line]);
                            })
                            .catch(() => callback(null, [[], line]));
                        return;
                    }
                    if (line.startsWith('/')) {
                        const hits = commands.filter((c) => c.startsWith(line));
                        callback(null, [hits.length ? hits : [], line]);
                        return;
                    }
                    callback(null, [[], line]);
                }
            });

            process.stdout.write(pc.cyan('◇  You\n'));
            rl.setPrompt(pc.gray('│  '));
            rl.prompt();

            rl.on('line', (line) => {
                if (isResolved) return;

                lines.push(line);

                if (pasteTimeout) clearTimeout(pasteTimeout);

                pasteTimeout = setTimeout(() => {
                    const currentText = lines.join('\n');

                    const codeBlocks = (currentText.match(/```/g) || []).length;
                    const hasUnclosedBlock = codeBlocks % 2 !== 0;
                    const lastLineEndsWithSlash = lines[lines.length - 1].trim().endsWith('\\');

                    if (hasUnclosedBlock || lastLineEndsWithSlash) {
                        rl.setPrompt(pc.gray('│  ... '));
                        rl.prompt();
                    } else {
                        isResolved = true;
                        rl.close();

                        let finalInput = currentText.trim();
                        if (finalInput.endsWith('\\')) {
                            finalInput = finalInput.slice(0, -1).trim();
                        }
                        resolve(finalInput);
                    }
                }, 150);
            });

            rl.on('SIGINT', () => {
                rl.close();
                gracefulShutdown();
            });

            rl.on('close', () => {
                if (!isResolved) {
                    gracefulShutdown();
                }
            });
        });

        if (!input) continue;

        // Persist into history so up-arrow works next time. Writes are
        // debounced so we don't fsync on every keystroke.
        try {
            if (history[0] !== input) {
                history.unshift(input);
                history = history.slice(0, 500);
                scheduleHistoryWrite(history, historyFile);
            }
        } catch (_) { /* ignore */ }

        if (input.startsWith('/')) {
            await handleCommand(input);
            process.stdout.write(pc.gray('│\n'));
            continue;
        }

        logDebug('user_input', input);
        state.history.push({ role: 'user', content: input });
        await triggerLLM();
    }
}

// ---------- Lifecycle -----------------------------------------------------
// gracefulShutdown lives in lib/lifecycle.js so the /quit command handler
// can import it without a cyclic import into index.js.

async function run() {
    console.clear();
    p.intro(pc.bgCyan(pc.black(' BlanketClaw ')));

    initializeGlobalDirectory();
    p.log.success(`Initialized global config at ${GLOBAL_DIR}`);

    const config = loadConfig();
    state.provider = config.activeProvider || 'ollama';
    state.currentModel = config.activeModelId || 'default-model';

    const providerData = config.providers?.[state.provider];
    const modelData = providerData?.models?.find(m => m.id === state.currentModel);

    if (modelData) {
        state.modelConfig = modelData;
        state.maxContext = modelData.contextWindow;
    } else {
        state.modelConfig = { reasoning: false };
        state.maxContext = 128000;
        logDebug('warn', `Configured model '${state.currentModel}' not found in provider '${state.provider}'. Using safe defaults.`);
    }

    if (!state.modelConfig.reasoning) {
        state.thinkMode = 'off';
    }

    p.log.message(pc.magenta(`Active Model: ${state.provider}/${state.currentModel}`));

    // Provider health check at boot so the user sees connection issues
    // before they type their first prompt.
    const health = await checkProviderHealth(providerData);
    if (health.ok) {
        p.log.success(pc.green(`Provider reachable: ${health.message}`));
    } else {
        p.log.warn(pc.yellow(`Provider unreachable: ${health.message}`));
    }
    process.stdout.write(pc.gray('│\n'));

    const s = p.spinner();
    s.start('Connecting to MCP Servers...');
    await setupMcp();
    s.stop(`MCP Servers Connected (${state.availableTools.length} tools).`);

    await mainLoop();
}

run();