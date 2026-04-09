import { state } from './state.js';
import { activeConfig } from './config.js';
import { tools } from './tools.js';
import { logDebug } from './logger.js';
import OpenAI from 'openai';

function safeJsonParse(jsonString) {
    try {
        // First try: The happy path where the AI actually followed instructions
        return JSON.parse(jsonString);
    } catch (e) {
        logDebug('json_heal', 'Initial JSON parse failed. Attempting to heal...', { jsonString });
        
        let healed = jsonString;

        // Fix 1: Escape physical newlines that the AI forgot to write as \n
        // We replace actual line breaks with the string literal "\n"
        healed = healed.replace(/\n/g, '\\n');
        healed = healed.replace(/\r/g, '\\r');
        healed = healed.replace(/\t/g, '\\t');

        // Fix 2: A common issue is trailing commas in JSON objects
        healed = healed.replace(/,\s*([\]}])/g, '$1');

        try {
            // Second try: Parse the healed string
            const result = JSON.parse(healed);
            logDebug('json_heal_success', 'Successfully healed JSON!');
            return result;
        } catch (e2) {
            // If it STILL fails, the JSON is completely mangled beyond simple repair.
            // We return an empty object, which will trigger the warning we added in index.js
            logDebug('json_heal_fail', 'JSON healing failed. It is too far gone.', { healed });
            return {}; 
        }
    }
}

export async function streamOllama(messages, onChunk) {
    const providerConfig = activeConfig.providers[state.provider];
    
    const ollamaMessages = messages.map(msg => {
        const newMsg = { ...msg };
        if (newMsg.role === 'tool') {
            delete newMsg.name;
        }
        
        // FIX: Ensure tool call arguments are strings when sending back to Ollama
        if (newMsg.tool_calls) {
            newMsg.tool_calls = newMsg.tool_calls.map(tc => ({
                ...tc,
                function: {
                    ...tc.function,
                    arguments: typeof tc.function.arguments === 'object' 
                        ? JSON.stringify(tc.function.arguments) 
                        : tc.function.arguments
                }
            }));
        }
        
        return newMsg;
    });

    const client = new OpenAI({
        baseURL: `${providerConfig.baseUrl}/v1/`,
        apiKey: providerConfig.apiKey || 'ollama',
        defaultHeaders: {
            'User-Agent': 'BlanketClaw/1.0',
        }
    });

    const payload = {
        model: state.currentModel,
        messages: ollamaMessages,
        stream: true,
        tools: tools.length > 0 ? tools : undefined
    };

    const extraBody = {
        options: {
            num_ctx: state.maxContext
        }
    };

    if (state.thinkMode !== 'off' && state.modelConfig.reasoning) {
        extraBody.think = true;
    }

    logDebug('ollama_req', 'Sending Request to Ollama', { url: client.baseURL, model: payload.model });

    const stream = await client.chat.completions.create(payload, { extra_body: extraBody });

    let capturedToolCalls = [];

    for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
                if (!capturedToolCalls[tc.index]) {
                    capturedToolCalls[tc.index] = {
                        id: tc.id || "",
                        type: "function",
                        function: { name: tc.function?.name || "", arguments: "" }
                    };
                }
                if (tc.function?.arguments) {
                    capturedToolCalls[tc.index].function.arguments += tc.function.arguments;
                }
            }
        }

        const contentToken = delta.content || "";
        const thinkingToken = delta.reasoning || delta.reasoning_content || "";

        if (contentToken || thinkingToken) {
            onChunk(contentToken, thinkingToken);
        }
    }

    const finalToolCalls = capturedToolCalls.filter(Boolean).map(tc => {
        tc.function.arguments = safeJsonParse(tc.function.arguments);
        return tc;
    });

    if (finalToolCalls.length > 0) {
        logDebug('ollama_tool', 'Captured Final Tool Calls', finalToolCalls);
    }

    return finalToolCalls;
}

export async function streamOpenRouter(messages, onChunk) {
    const providerConfig = activeConfig.providers.openrouter;
    
    const openAiMessages = messages.map(msg => {
        const newMsg = { ...msg };
        
        if (newMsg.role === 'tool') {
            delete newMsg.name;
        }

        if (newMsg.role === 'assistant' && !newMsg.content && newMsg.tool_calls) {
            newMsg.content = "";
        }

        // Ensure tool call arguments are strings when sending back to OpenRouter
        if (newMsg.tool_calls) {
            newMsg.tool_calls = newMsg.tool_calls.map(tc => ({
                ...tc,
                function: {
                    ...tc.function,
                    arguments: typeof tc.function.arguments === 'object' 
                        ? JSON.stringify(tc.function.arguments) 
                        : tc.function.arguments
                }
            }));
        }
        return newMsg;
    });

    const client = new OpenAI({
        baseURL: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey,
        defaultHeaders: {
            'HTTP-Referer': 'http://localhost',
            'X-Title': 'BlanketClaw',
            'User-Agent': 'BlanketClaw/1.0'
        }
    });

    const payload = {
        model: state.currentModel,
        messages: openAiMessages,
        stream: true,
        tools: tools.length > 0 ? tools : undefined
    };

    logDebug('openrouter_req', 'Sending Request to OpenRouter', { model: payload.model });

    const stream = await client.chat.completions.create(payload);

    let capturedToolCalls = [];

    for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        
        if (!delta) continue;

        if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
                if (!capturedToolCalls[tc.index]) {
                    capturedToolCalls[tc.index] = {
                        id: tc.id || "",
                        type: "function",
                        function: { name: tc.function?.name || "", arguments: "" }
                    };
                }
                if (tc.function?.arguments) {
                    capturedToolCalls[tc.index].function.arguments += tc.function.arguments;
                }
            }
        }
        
        const contentToken = delta.content || "";
        const thinkingToken = delta.reasoning || delta.reasoning_content || "";
        
        if (contentToken || thinkingToken) {
            onChunk(contentToken, thinkingToken);
        }
    }

    const finalToolCalls = capturedToolCalls.filter(Boolean).map(tc => {
        try {
            tc.function.arguments = JSON.parse(tc.function.arguments);
        } catch (e) {
            tc.function.arguments = {};
        }
        return tc;
    });

    if (finalToolCalls.length > 0) {
        logDebug('openrouter_tool', 'Captured Final Tool Calls', finalToolCalls);
    }

    return finalToolCalls;
}