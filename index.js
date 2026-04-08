#!/usr/bin/env node
import * as p from '@clack/prompts';
import pc from 'picocolors';
import readline from 'readline';
import fg from 'fast-glob';

import { state } from './lib/state.js';
import { initializeGlobalDirectory, loadConfig, GLOBAL_DIR, activeConfig } from './lib/config.js';
import { buildSystemPrompt } from './lib/prompt.js';
import { streamOllama, streamOpenRouter } from './lib/api.js';
import { executeTool } from './lib/tools.js';
import { handleCommand } from './lib/commands.js';

async function triggerLLM() {
    const systemPrompt = buildSystemPrompt();
    const apiMessages = [
        { role: 'system', content: systemPrompt },
        ...state.history
    ];

    process.stdout.write(pc.gray('│\n') + pc.magenta('◆  ') + pc.green('BlanketClaw\n') + pc.gray('│  '));

    let fullResponse = "";
    let fullThinking = "";
    let toolCalls = [];
    
    let inThinking = false;

    function printNormal(text) {
        const parts = text.split('\n');
        for (let i = 0; i < parts.length; i++) {
            process.stdout.write(parts[i]);
            if (i < parts.length - 1) {
                process.stdout.write('\n' + pc.gray('│  '));
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
        if (thinkingToken && !inThinking) {
            inThinking = true;
            if (state.thinkMode === 'show') {
                process.stdout.write(pc.dim('\n') + pc.gray('│  ') + pc.dim('┌─ [Thinking]\n') + pc.gray('│  ') + pc.dim('│  '));
            }
        }

        if (thinkingToken) {
            fullThinking += thinkingToken;
            printThink(thinkingToken);
        } 
        else if (contentToken) {
            let cleanToken = contentToken;
            
            if (cleanToken.includes('<think>')) {
                if (!inThinking) {
                    inThinking = true;
                    if (state.thinkMode === 'show') {
                        process.stdout.write(pc.dim('\n') + pc.gray('│  ') + pc.dim('┌─ [Thinking]\n') + pc.gray('│  ') + pc.dim('│  '));
                    }
                }
                cleanToken = cleanToken.replace(/<think>/g, '');
            }

            if (cleanToken.includes('</think>')) {
                if (inThinking) {
                    inThinking = false;
                    if (state.thinkMode === 'show') {
                        process.stdout.write(pc.dim('\n') + pc.gray('│  ') + pc.dim('└─ [Done]\n') + pc.gray('│  '));
                    }
                }
                cleanToken = cleanToken.replace(/<\/think>/g, '');
            }

            if (inThinking && !contentToken.includes('<think>') && contentToken.trim() !== '') {
                inThinking = false;
                if (state.thinkMode === 'show') {
                    process.stdout.write(pc.dim('\n') + pc.gray('│  ') + pc.dim('└─ [Done]\n') + pc.gray('│  '));
                }
            }
            
            fullResponse += contentToken;
            
            if (cleanToken && inThinking) {
                 printThink(cleanToken);
            } else if (cleanToken) {
                 printNormal(cleanToken);
            }
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
            process.stdout.write(pc.red(`\n│  Error: Unknown provider '${state.provider}'`));
            return;
        }
    } catch (error) {
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

    if (fullResponse.trim() !== "" || fullThinking.length > 0 || (toolCalls && toolCalls.length > 0)) {
        process.stdout.write('\n' + pc.gray('│\n'));
        
        if (fullThinking.length > 0) {
            fullResponse = `<think>\n${fullThinking}\n</think>\n${fullResponse}`;
        }
        
        const assistantMessage = { role: 'assistant', content: fullResponse };
        
        if (toolCalls && toolCalls.length > 0) {
            assistantMessage.tool_calls = toolCalls;
        }
        
        state.history.push(assistantMessage);
    } else {
        process.stdout.write('\n');
    }

    if (toolCalls && toolCalls.length > 0) {
        for (const tc of toolCalls) {
            const toolResult = await executeTool(tc);
            
            // --- FIX: Strictly adhere to 'role', 'content', and 'tool_call_id' ---
            state.history.push({ 
                role: 'tool', 
                content: toolResult,
                tool_call_id: tc.id 
            });
        }

        await triggerLLM();
    }
}

async function mainLoop() {
    while (true) {
        const input = await new Promise((resolve) => {
            let lineReceived = false;
            
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
                completer: (line) => {
                    const commands = ['/help', '/model', '/quit', '/clear', '/clear all', '/load', '/load all', '/status', '/think', '/verbose', '/persona', '/persona off', '/memory', '/log'];
                    
                    if (line.startsWith('/load ')) {
                        const search = line.replace('/load ', '');
                        try {
                            const files = fg.sync(search ? `${search}*` : '*', { dot: true, onlyFiles: false, deep: 1 });
                            const hits = files.map(f => `/load ${f}`);
                            return [hits.length ? hits : [], line];
                        } catch (e) {
                            return [[], line];
                        }
                    }
                    
                    if (line.startsWith('/')) {
                        const hits = commands.filter((c) => c.startsWith(line));
                        return [hits.length ? hits : [], line];
                    }
                    return [[], line];
                }
            });

            process.stdout.write(pc.cyan('◇  You\n'));
            rl.setPrompt(pc.gray('│  '));
            rl.prompt();

            rl.on('line', (line) => {
                lineReceived = true;
                rl.close();
                resolve(line.trim());
            });

            rl.on('SIGINT', () => {
                rl.close();
                p.outro(pc.green('Goodbye!'));
                process.exit(0);
            });

            rl.on('close', () => {
                if (!lineReceived) {
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

    await mainLoop();
}

run();