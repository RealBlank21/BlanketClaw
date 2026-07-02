#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import readline from 'readline';
import fg from 'fast-glob';

import { state } from './lib/state.js';
import { initializeGlobalDirectory, loadConfig, GLOBAL_DIR, CACHE_DIR, activeConfig } from './lib/config.js';
import { buildSystemPrompt } from './lib/prompt.js';
import { streamOllama, streamOpenRouter } from './lib/api.js';
import { executeTool, setupMcp } from './lib/tools.js';
import { handleCommand } from './lib/commands.js';
import { logDebug } from './lib/logger.js';

async function triggerLLM(retryCount = 0) {
    const systemPrompt = buildSystemPrompt();
    const apiMessages = [
        { role: 'system', content: systemPrompt },
        ...state.history
    ];

    logDebug('system', 'Triggering LLM with conversation state', { historyLength: state.history.length, provider: state.provider });

    process.stdout.write(pc.gray('│\n') + pc.magenta('◆  ') + pc.green('BlanketClaw\n') + pc.gray('│  '));

    let fullResponse = "";
    let fullThinking = "";
    let toolCalls = [];
    
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
            toolCalls = await streamOllama(apiMessages, onChunkCallback);
        } else if (state.provider === 'openrouter') {
            if (!activeConfig.providers.openrouter.apiKey || activeConfig.providers.openrouter.apiKey === "YOUR_OPENROUTER_KEY") {
                process.stdout.write(pc.red(`\n│  Error: Please set your OpenRouter API Key in ~/.blanketclaw/config.json`));
                process.stdout.write('\n' + pc.gray('│\n'));
                return;
            }
            toolCalls = await streamOpenRouter(apiMessages, onChunkCallback);
        } else {
            logDebug('error', `Unknown provider '${state.provider}'`);
            process.stdout.write(pc.red(`\n│  Error: Unknown provider '${state.provider}'`));
            return;
        }
    } catch (error) {
        logDebug('fatal_error', 'triggerLLM Stream Failure', { message: error.message, stack: error.stack });
        process.stdout.write(pc.red(`\n│  Error: ${error.message}`));
        process.stdout.write('\n' + pc.gray('│\n'));
        return;
    }

    if (inThinking) {
        inThinking = false;
        if (state.thinkMode === 'show') {
            process.stdout.write(pc.dim('\n') + pc.gray('│  ') + pc.dim('└─ [Done]\n') + pc.gray('│  '));
        }
    }

    if (toolCalls && toolCalls.length > 0) {
        for (const tc of toolCalls) {
            if (!tc.id) {
                tc.id = `call_${Math.random().toString(36).substring(2, 11)}`;
            }
        }
    }

    if (fullResponse.trim() !== "" || (toolCalls && toolCalls.length > 0)) {
        process.stdout.write('\n' + pc.gray('│\n'));
        
        const assistantMessage = { role: 'assistant', content: fullResponse.trim() };
        
        if (toolCalls && toolCalls.length > 0) {
            assistantMessage.tool_calls = toolCalls;
        }
        
        if (assistantMessage.content !== "" || (toolCalls && toolCalls.length > 0)) {
            state.history.push(assistantMessage);
        }

    } else {
        logDebug('warn', 'LLM returned empty response and no tools.');
        process.stdout.write(pc.yellow(`\n│  [System: Model generated reasoning but failed to output a response or call a tool.]\n`));
        
        if (retryCount < 3) {
            process.stdout.write(pc.cyan(`│  [Auto-Retry ${retryCount + 1}/3]: Prompting model to use native tools...\n`));
            process.stdout.write(pc.gray('│\n'));
            
            state.history.push({
                role: 'user',
                content: "SYSTEM WARNING: You generated a thought process but did not output any text or invoke any tools. You MUST invoke a native tool to complete the action."
            });
            
            await triggerLLM(retryCount + 1);
            return;
        } else {
            process.stdout.write(pc.red(`│  [System]: AI failed to execute correctly after 3 attempts. Aborting.\n`));
            process.stdout.write(pc.gray('│\n'));
        }
    }

    if (toolCalls && toolCalls.length > 0) {
        for (const tc of toolCalls) {
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

async function mainLoop() {
    while (true) {
        const input = await new Promise((resolve) => {
            let lines = [];
            let pasteTimeout;
            let isResolved = false;
            
            // Force stdin to wake up. Prevents terminal freezing after inactivity.
            process.stdin.resume();
            
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
                
                // Using an async completer (2 parameters) prevents disk I/O from 
                // blocking the main thread, fixing the backspace/typing lag.
                completer: (line, callback) => {
                    const commands = ['/help', '/model', '/quit', '/clear', '/clear all', '/load', '/load all', '/status', '/think', '/verbose', '/persona', '/persona off', '/memory', '/log', '/debug'];
                    
                    if (line.startsWith('/load ')) {
                        const search = line.replace('/load ', '');
                        
                        // Async file system call
                        fg(search ? `${search}*` : '*', { dot: true, onlyFiles: false, deep: 1 })
                            .then(files => {
                                const hits = files.map(f => `/load ${f}`);
                                callback(null, [hits.length ? hits : [], line]);
                            })
                            .catch(() => {
                                callback(null, [[], line]);
                            });
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

                // Bumped to 50ms to comfortably handle chunky pastes over SSH/slow terminals
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
                }, 50);
            });

            rl.on('SIGINT', () => {
                rl.close();
                p.outro(pc.green('Goodbye!'));
                process.exit(0);
            });

            rl.on('close', () => {
                if (!isResolved) {
                    p.outro(pc.green('Goodbye!'));
                    process.exit(0);
                }
            });
        });

        if (!input) continue;

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
    }

    if (!state.modelConfig.reasoning) {
        state.thinkMode = 'off';
    }

    p.log.message(pc.magenta(`Active Model: ${state.provider}/${state.currentModel}`));
    process.stdout.write(pc.gray('│\n'));

    const s = p.spinner();
    s.start('Connecting to MCP Servers...');
    await setupMcp();
    s.stop('MCP Servers Connected.');

    await mainLoop();
}

run();