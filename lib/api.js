import { state } from './state.js';
import { activeConfig } from './config.js';
import { tools } from './tools.js';

export async function streamOllama(messages, onChunk) {
    const providerConfig = activeConfig.providers[state.provider];
    
    // Ollama accepts tool arguments as Native Objects, but we should strip the name field from tool results
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

    const response = await fetch(`${providerConfig.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        throw new Error(`API Error: ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let capturedToolCalls = [];

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.trim() !== '');
        
        for (const line of lines) {
            try {
                const parsed = JSON.parse(line);
                
                if (parsed.message) {
                    // Prevent overwriting with an empty array on the final chunk
                    if (parsed.message.tool_calls && parsed.message.tool_calls.length > 0) {
                        capturedToolCalls = parsed.message.tool_calls;
                    }
                    if (parsed.message.content || parsed.message.thinking) {
                        onChunk(parsed.message.content || "", parsed.message.thinking || "");
                    }
                }
            } catch (e) {
            }
        }
    }

    return capturedToolCalls;
}

export async function streamOpenRouter(messages, onChunk) {
    const providerConfig = activeConfig.providers.openrouter;
    
    const openAiMessages = messages.map(msg => {
        const newMsg = { ...msg };
        
        // Strict OpenAI Schema: role 'tool' MUST NOT have a 'name' field
        if (newMsg.role === 'tool') {
            delete newMsg.name;
        }

        // Strict OpenAI Schema: assistant message with tool calls MUST have a content string
        if (newMsg.role === 'assistant' && !newMsg.content && newMsg.tool_calls) {
            newMsg.content = "";
        }

        // Strict OpenAI Schema: arguments MUST be stringified JSON
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
        throw new Error(`OpenRouter API Error: ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let capturedToolCalls = [];

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.trim() !== '');
        
        for (const line of lines) {
            if (line === 'data: [DONE]') continue;
            if (!line.startsWith('data: ')) continue;
            
            try {
                const dataStr = line.replace(/^data: /, '');
                const parsed = JSON.parse(dataStr);
                const delta = parsed.choices[0]?.delta;
                
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
                const thinkingToken = delta.reasoning || "";
                
                if (contentToken || thinkingToken) {
                    onChunk(contentToken, thinkingToken);
                }
                
            } catch (e) {
            }
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

    return finalToolCalls;
}