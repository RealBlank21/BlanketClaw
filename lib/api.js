import { state } from './state.js';
import { activeConfig } from './config.js';
import { tools } from './tools.js';
import { logDebug } from './logger.js';

export async function streamOllama(messages, onChunk) {
    const providerConfig = activeConfig.providers[state.provider];
    
    const ollamaMessages = messages.map(msg => {
        const newMsg = { ...msg };
        if (newMsg.role === 'tool') {
            delete newMsg.name;
        }
        return newMsg;
    });

    const payload = {
        model: state.currentModel,
        messages: ollamaMessages,
        stream: true,
        tools: tools,
        options: {
            num_ctx: state.maxContext
        }
    };

    if (state.thinkMode !== 'off' && state.modelConfig.reasoning) {
        payload.think = true;
    }

    const headers = { 'Content-Type': 'application/json' };
    if (providerConfig.apiKey) {
        headers['Authorization'] = `Bearer ${providerConfig.apiKey}`;
    }

    logDebug('ollama_req', 'Sending Request to Ollama', { url: `${providerConfig.baseUrl}/api/chat`, model: payload.model });

    const response = await fetch(`${providerConfig.baseUrl}/api/chat`, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errText = await response.text();
        logDebug('ollama_err', `HTTP Error: ${response.status}`, errText);
        throw new Error(`API Error: ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let capturedToolCalls = [];
    let buffer = '';

    const processLine = (line) => {
        if (!line.trim()) return;
        try {
            const parsed = JSON.parse(line);
            
            if (parsed.message) {
                if (parsed.message.tool_calls && parsed.message.tool_calls.length > 0) {
                    capturedToolCalls = parsed.message.tool_calls;
                    logDebug('ollama_tool', 'Captured Tool Call', capturedToolCalls);
                }
                if (parsed.message.content || parsed.message.thinking) {
                    onChunk(parsed.message.content || "", parsed.message.thinking || "");
                }
            }
        } catch (e) {
            logDebug('ollama_parse_err', 'Failed to parse stream chunk', line);
        }
    };

    while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
            buffer += decoder.decode();
            const lines = buffer.split('\n');
            for (const line of lines) {
                processLine(line);
            }
            break;
        }
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        
        for (const line of lines) {
            processLine(line);
        }
    }

    return capturedToolCalls;
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

    const payload = {
        model: state.currentModel,
        messages: openAiMessages,
        stream: true,
        tools: tools
    };

    logDebug('openrouter_req', 'Sending Request to OpenRouter', { model: payload.model });

    const response = await fetch(`${providerConfig.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${providerConfig.apiKey}`,
            'HTTP-Referer': 'http://localhost',
            'X-Title': 'BlanketClaw'
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errText = await response.text();
        logDebug('openrouter_err', `HTTP Error: ${response.status}`, errText);
        throw new Error(`OpenRouter API Error: ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let capturedToolCalls = [];
    let buffer = '';

    const processLine = (line) => {
        if (line.trim() === 'data: [DONE]') return;
        if (!line.startsWith('data: ')) return;
        
        try {
            const dataStr = line.replace(/^data: /, '');
            const parsed = JSON.parse(dataStr);
            const delta = parsed.choices[0]?.delta;
            
            if (!delta) return;

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
            const thinkingToken = delta.reasoning || "";
            
            if (contentToken || thinkingToken) {
                onChunk(contentToken, thinkingToken);
            }
            
        } catch (e) {
            logDebug('openrouter_parse_err', 'Failed to parse stream chunk', line);
        }
    };

    while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
            buffer += decoder.decode();
            const lines = buffer.split('\n');
            for (const line of lines) {
                processLine(line);
            }
            break;
        }
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        
        for (const line of lines) {
            processLine(line);
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