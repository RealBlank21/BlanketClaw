import { state } from './state.js';
import { activeConfig } from './config.js';
import { tools } from './tools.js';

export async function streamOllama(messages, onChunk) {
    const providerConfig = activeConfig.providers[state.provider];
    
    const payload = {
        model: state.currentModel,
        messages: messages,
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
                
                if (parsed.message && parsed.message.tool_calls) {
                    capturedToolCalls = parsed.message.tool_calls;
                } else if (parsed.message) {
                    onChunk(parsed.message.content || "", parsed.message.thinking || "");
                }
            } catch (e) {
            }
        }
    }

    return capturedToolCalls;
}

export async function streamOpenRouter(messages, onChunk) {
    const providerConfig = activeConfig.providers.openrouter;
    
    const payload = {
        model: state.currentModel,
        messages: messages,
        stream: true,
        tools: tools
    };

    const response = await fetch(`${providerConfig.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${providerConfig.apiKey}`,
            'HTTP-Referer': 'http://localhost', // Required by OpenRouter
            'X-Title': 'BlanketClaw'            // Optional identifier
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
                    // OpenRouter streams tool calls in chunks, we must buffer them
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
                } else {
                    // OpenRouter provides reasoning in `delta.reasoning`
                    const contentToken = delta.content || "";
                    const thinkingToken = delta.reasoning || "";
                    
                    if (contentToken || thinkingToken) {
                        onChunk(contentToken, thinkingToken);
                    }
                }
            } catch (e) {
                // Silently ignore split JSON chunks in SSE
            }
        }
    }

    // Parse the accumulated string arguments back into JSON objects before returning
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