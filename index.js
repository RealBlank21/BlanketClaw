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
    let hasNativeThinking = false;

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
            hasNativeThinking = true;
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
            let cleanToken = contentToken;

            if (hasNativeThinking && inThinking) {
                inThinking = false;
                if (state.thinkMode === 'show') {
                    process.stdout.write(pc.dim('\n') + pc.gray('│  ') + pc.dim('└─ [Done]\n') + pc.gray('│  '));
                }
            }
            
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
            
            fullResponse += contentToken;
            
            if (cleanToken) {
                if (inThinking) {
                     printThink(cleanToken);
                } else {
                     printNormal(cleanToken);
                }
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

    let codeBlocks = [];
    const codeBlockRegex = /```(\w*)\r?\n([\s\S]*?)```/g;
    let match;
    let blockIndex = 1;
    while ((match = codeBlockRegex.exec(fullResponse)) !== null) {
        let ext = match[1].trim() || "txt";
        if (ext.length > 10) ext = "txt";
        const code = match[2].trim();
        const cachePath = path.join(CACHE_DIR, `cached_code_${blockIndex}.${ext}`);
        fs.writeFileSync(cachePath, code, 'utf-8');
        codeBlocks.push(cachePath.replace(/\\/g, '/'));
        blockIndex++;
    }

    if (fullResponse.trim() !== "" || (toolCalls && toolCalls.length > 0)) {
        process.stdout.write('\n' + pc.gray('│\n'));
        
        let cleanHistoryContent = fullResponse.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
        
        const assistantMessage = { role: 'assistant', content: cleanHistoryContent };
        
        if (toolCalls && toolCalls.length > 0) {
            assistantMessage.tool_calls = toolCalls;
        }
        
        if (cleanHistoryContent !== "" || (toolCalls && toolCalls.length > 0)) {
            state.history.push(assistantMessage);
        }

        if (codeBlocks.length > 0 && (!toolCalls || toolCalls.length === 0)) {
            if (retryCount === 0) {
                process.stdout.write(pc.yellow(`│  [System: Code block(s) detected with no tool calls. Safely cached.]\n`));
                process.stdout.write(pc.cyan(`│  [Auto-Prompt]: Asking AI if it wants to save the cached code...\n`));
                process.stdout.write(pc.gray('│\n'));

                state.history.push({
                    role: 'user',
                    content: `SYSTEM: You generated code block(s) but did not call any tools to save them. Are you sure the code isn't supposed to be saved?\n\nIf you intended to save it, I have automatically cached your code block(s) here:\n${codeBlocks.map(p => `- ${p}`).join('\n')}\n\nYou can now use the \`move_file\` tool to move the cached file(s) into their actual intended directory (e.g., source: "${codeBlocks[0]}", destination: "actual/path/to/file"). If it was just for explanation and no saving is needed, just say so.`
                });

                await triggerLLM(retryCount + 1);
                return;
            }
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
            let lineReceived = false;
            
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
                completer: (line) => {
                    const commands = ['/help', '/model', '/quit', '/clear', '/clear all', '/load', '/load all', '/status', '/think', '/verbose', '/persona', '/persona off', '/memory', '/log', '/debug'];
                    
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