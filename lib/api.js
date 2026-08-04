import { state, estimatePayloadTokens } from './state.js';
import { activeConfig, redactSecrets } from './config.js';
import { getTools } from './tools.js';
import { logDebug } from './logger.js';
import OpenAI from 'openai';

// Result types for tool-argument parsing. We previously silently turned
// garbage into `{}` which caused the LLM to call tools with no args.
// Now we return either { ok: true, args } or { ok: false, error } so the
// caller can surface the failure to the model.
function safeJsonParse(jsonString) {
    if (!jsonString || jsonString.trim() === '') {
        return { ok: false, error: 'Empty arguments string from model.' };
    }
    try {
        return { ok: true, args: JSON.parse(jsonString) };
    } catch (e) {
        logDebug('json_heal', 'Initial JSON parse failed. Attempting to heal...', { jsonString });
        let healed = jsonString;
        healed = healed.replace(/\n/g, '\\n');
        healed = healed.replace(/\r/g, '\\r');
        healed = healed.replace(/\t/g, '\\t');
        healed = healed.replace(/,\s*([\]}])/g, '$1');
        try {
            const args = JSON.parse(healed);
            logDebug('json_heal_success', 'Successfully healed JSON!');
            return { ok: true, args };
        } catch (e2) {
            logDebug('json_heal_fail', 'JSON healing failed.', { healed });
            return { ok: false, error: `Could not parse tool arguments: ${e2.message}` };
        }
    }
}

// Convert a tool-call's argument string into a safe object before executing.
// If the model emitted garbage we surface a structured error message that the
// LLM can read and self-correct on the next turn.
function coerceToolArgs(toolCalls) {
    return toolCalls.map(tc => {
        const raw = tc.function.arguments;
        if (raw && typeof raw === 'object') return { tc, error: null };
        const result = safeJsonParse(raw);
        if (result.ok) {
            tc.function.arguments = result.args;
            return { tc, error: null };
        }
        return { tc, error: result.error };
    });
}

// Build a per-tool-call id -> error map from a coerced list. We use a stable
// synthetic key when no id is present yet, so the LLM loop can address each
// broken call individually (previously the OpenRouter path collapsed all
// errors into a single bag entry, silently dropping the rest).
function buildErrorMap(coerced) {
    const errorMap = {};
    for (const { tc, error } of coerced) {
        if (!error) continue;
        const key = tc.id || `name:${tc.function.name}`;
        errorMap[key] = error;
    }
    return errorMap;
}

export async function streamOllama(messages, onChunk) {
    const providerConfig = activeConfig.providers[state.provider];

    const ollamaMessages = messages.map(msg => {
        const newMsg = { ...msg };
        if (newMsg.role === 'tool') {
            delete newMsg.name;
        }
        // Ollama wants tool arguments as strings on the wire.
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
        defaultHeaders: { 'User-Agent': 'BlanketClaw/1.0' }
    });

    const availableTools = getTools();

    const payload = {
        model: state.currentModel,
        messages: ollamaMessages,
        stream: true,
        tools: availableTools,
    };

    const extraBody = { options: { num_ctx: state.maxContext } };

    // Be explicit: pass think=false when off, not just omit. Some providers
    // (notably Ollama on certain Qwen builds) default to think=true otherwise.
    if (state.modelConfig.reasoning) {
        extraBody.think = state.thinkMode !== 'off';
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

    const finalToolCalls = capturedToolCalls.filter(Boolean);
    const coerced = coerceToolArgs(finalToolCalls);
    const errorMap = buildErrorMap(coerced);

    if (finalToolCalls.length > 0) {
        logDebug('ollama_tool', 'Captured Final Tool Calls', finalToolCalls.map(t => ({ name: t.function.name, args: t.function.arguments })));
    }

    // Return as a plain object rather than attaching __errors to the array
    // (avoids any future prototype-shadowing hazard).
    return { toolCalls: finalToolCalls, errors: errorMap };
}

export async function streamOpenRouter(messages, onChunk) {
    const providerConfig = activeConfig.providers.openrouter;

    const openAiMessages = messages.map(msg => {
        const newMsg = { ...msg };
        if (newMsg.role === 'tool') delete newMsg.name;
        if (newMsg.role === 'assistant' && !newMsg.content && newMsg.tool_calls) newMsg.content = "";
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

    const availableTools = getTools();

    const payload = {
        model: state.currentModel,
        messages: openAiMessages,
        stream: true,
        tools: availableTools,
    };

    // OpenRouter supports a top-level `reasoning` flag ({enabled: bool}). We
    // pass it when the model is reasoning-capable so we don't rely on the
    // prompt instruction alone (which weaker models ignore).
    if (state.modelConfig.reasoning) {
        payload.reasoning = { enabled: state.thinkMode !== 'off' };
    }

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

    const finalToolCalls = capturedToolCalls.filter(Boolean);
    const coerced = coerceToolArgs(finalToolCalls);
    const errorMap = buildErrorMap(coerced);

    if (finalToolCalls.length > 0) {
        logDebug('openrouter_tool', 'Captured Final Tool Calls', finalToolCalls.map(t => ({ name: t.function.name, args: t.function.arguments })));
    }

    return { toolCalls: finalToolCalls, errors: errorMap };
}