import * as p from '@clack/prompts';
import pc from 'picocolors';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { state } from './state.js';
import { logDebug, logToolCall } from './logger.js';
import { CACHE_DIR } from './config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const GLOBAL_DIR = path.join(os.homedir(), '.blanketclaw');

// MCP server configs. These are spawned lazily on startup. If a server fails
// to come up we log it and move on rather than crashing the whole CLI.
const mcpServerConfigs = [
    {
        name: "filesystem",
        command: "npx",
        args: ["-y", "-q", "@modelcontextprotocol/server-filesystem", process.cwd(), CACHE_DIR]
    },
    {
        name: "shell",
        command: "npx",
        args: ["-y", "-q", "mcp-shell-server"]
    }
];

// Refined read-only tool allowlist. Replaces the old substring-based heuristic
// (`name.includes('read')`) which was bypassable by a tool named `read_and_delete`.
//
// This list is the SOURCE OF TRUTH for which tools never trigger the security
// gate. Anything not in here will prompt the user the first time it's called.
const READ_ONLY_TOOLS = new Set([
    'read_file', 'read_text_file', 'read_media_file',
    'read_multiple_files', 'list_directory', 'list_directory_with_sizes',
    'directory_tree', 'search_files', 'get_file_info',
    'list_allowed_directories', 'list_tools'
]);

// Binary-file extensions and oversized files shouldn't be slurped into context
// even if the user explicitly requests them. PDF/Office go through the parser;
// everything else that's binary just gets a friendly refusal.
const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico',
    '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov', '.avi',
    '.zip', '.tar', '.gz', '.rar', '.7z',
    '.exe', '.dll', '.so', '.dylib', '.bin',
    '.woff', '.woff2', '.ttf', '.otf'
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB safety cap

export async function setupMcp() {
    // Reset so a /model switch can re-init cleanly if we ever call this twice.
    state.availableTools = [];
    state.mcpClients = {};
    state.mcpServers = {};

    await Promise.all(mcpServerConfigs.map(async (config) => {
        try {
            const logPath = (() => {
                try { fs.mkdirSync(GLOBAL_DIR, { recursive: true }); } catch (_) { /* ignore */ }
                const ts = new Date().toISOString().replace(/[:.]/g, '-');
                return path.join(GLOBAL_DIR, `mcp-${config.name}-${ts}.log`);
            })();
            const logStream = (() => {
                try { return fs.createWriteStream(logPath, { flags: 'a' }); }
                catch (_) { return null; }
            })();

            const transport = new StdioClientTransport({
                command: config.command,
                args: config.args,
                env: process.env,
                stderr: logStream ? 'pipe' : 'ignore'
            });

            if (logStream && transport.stderr) {
                let buf = '';
                transport.stderr.on('data', (chunk) => {
                    buf += chunk.toString();
                    if (buf.length > 4096) buf = buf.slice(-4096);
                    logStream.write(chunk);
                    logDebug(`mcp_stderr_${config.name}`, 'MCP server stderr', buf);
                });
                transport.stderr.on('end', () => { try { logStream.end(); } catch (_) { /* ignore */ } });
            }

            const client = new Client(
                { name: "blanketclaw", version: "1.0.0" },
                { capabilities: { tools: {} } }
            );

            await client.connect(transport);
            const toolsResponse = await client.listTools();

            for (const tool of toolsResponse.tools) {
                // Property (12) on the original bug list: if two servers expose
                // the same tool name, the newer one wins. We log a duplicate
                // warning so the user can rename one server's tool.
                if (state.availableTools.find(t => t.function.name === tool.name)) {
                    logDebug('mcp_duplicate', `Tool '${tool.name}' already registered; skipping from server '${config.name}'.`, { existingServer: state.mcpServers[tool.name] });
                    continue;
                }

                state.availableTools.push({
                    type: "function",
                    function: {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.inputSchema
                    },
                    serverName: config.name,
                    isReadOnly: READ_ONLY_TOOLS.has(tool.name)
                });
                state.mcpClients[tool.name] = client;
                state.mcpServers[tool.name] = config.name;
            }
            logDebug('mcp', `Connected to MCP server: ${config.name} (${toolsResponse.tools.length} tools)`);
        } catch (error) {
            logDebug('mcp_error', `Failed to connect to MCP server: ${config.name}`, { error: error.message });
        }
    }));
}

// Graceful shutdown: close every MCP transport so we don't leak npx children.
export async function shutdownMcp() {
    const seen = new Set();
    for (const client of Object.values(state.mcpClients)) {
        if (seen.has(client)) continue;
        seen.add(client);
        try { await client.close(); } catch (_) { /* ignore */ }
    }
    state.mcpClients = {};
    state.availableTools = [];
    state.mcpServers = {};
}

// Public accessor that the API layer uses to discover tools.
export function getTools() {
    return state.availableTools.length > 0 ? state.availableTools : undefined;
}

// Health-check a provider's base URL. We do a quick HEAD/GET so users get a
// clear error at startup instead of a cryptic 403 mid-conversation.
export async function checkProviderHealth(provider) {
    if (!provider?.baseUrl) return { ok: false, message: 'No baseUrl configured' };
    try {
        const url = provider.baseUrl.replace(/\/+$/, '');
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 3000);
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timeout);
        // We don't care about the status code, just that something answered.
        return { ok: true, message: `Reachable (HTTP ${res.status})` };
    } catch (e) {
        return { ok: false, message: `Unreachable: ${e.message}. Is the provider running?` };
    }
}

export function isBinaryFile(filename) {
    const ext = filename.toLowerCase().substring(filename.lastIndexOf('.'));
    return BINARY_EXTENSIONS.has(ext);
}

export function isReadOnlyTool(name) {
    const tool = state.availableTools.find(t => t.function.name === name);
    if (tool) return tool.isReadOnly;
    // Unknown tool: be conservative and treat as not-read-only.
    return false;
}

export async function executeTool(toolCall) {
    const name = toolCall.function.name;
    const args = toolCall.function.arguments;

    logDebug('tool_exec', `Requested ${name}`, args);

    // Defensive: an empty tool name from a misbehaving provider should
    // surface a self-correction-friendly error to the LLM rather than
    // masquerading as a generic "Unknown tool" failure.
    if (!name || typeof name !== 'string' || !name.trim()) {
        logToolCall('<empty>', args, 'Empty tool name', 'deny');
        return `Error: Model emitted a tool call with an empty name. Re-issue the call with a valid tool name from the available tools list.`;
    }

    if (state.isVerbose) {
        p.log.message(pc.magenta(`[Tool Requested: ${name}]`));
    }

    const client = state.mcpClients[name];
    if (!client) {
        logToolCall(name, args, 'Unknown tool', 'deny');
        return `Error: Unknown tool '${name}' or MCP server disconnected. Available tools: ${state.availableTools.map(t => t.function.name).join(', ')}`;
    }

    // Approval gate. Per-tool auto-approve (was: global flag).
    const isApproved = state.approvedTools.has(name);
    const readOnly = isReadOnlyTool(name);

    if (!isApproved && !readOnly) {
        const displayArg = JSON.stringify(args);
        const action = await p.select({
            message: pc.yellow(`BlanketClaw wants to run ${pc.bold(name)} with args: ${pc.dim(displayArg.substring(0, 100))}${displayArg.length > 100 ? '...' : ''}`),
            options: [
                { value: 'allow', label: 'Allow Once' },
                { value: 'always', label: `Always Allow ${name} (Session)` },
                { value: 'deny', label: 'Deny' }
            ]
        });

        if (p.isCancel(action) || action === 'deny') {
            logToolCall(name, args, 'User denied', 'deny');
            return "User denied execution of this tool.";
        }
        if (action === 'always') state.approvedTools.add(name);
    }

    const s = p.spinner();
    s.start(`Executing: ${name}`);

    // Bound tool execution time. A hung MCP server would otherwise block the
    // session indefinitely. 60s is generous for filesystem/shell ops and
    // protects the REPL from wedge states.
    const TOOL_TIMEOUT_MS = 60_000;

    try {
        // Wrap the tool call so we can capture a possible late rejection
        // (the timeout fires first, but the underlying call might still
        // resolve later) and surface it as an unhandled-rejection-safe
        // marker without poisoning the race.
        let lateError = null;
        const toolCallPromise = client.callTool({
            name: name,
            arguments: args
        }).catch(err => { lateError = err; return undefined; });

        let timer;
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Tool '${name}' timed out after ${TOOL_TIMEOUT_MS / 1000}s.`)), TOOL_TIMEOUT_MS);
        });

        let result;
        try {
            result = await Promise.race([toolCallPromise, timeoutPromise]);
        } finally {
            clearTimeout(timer);
        }

        if (result === undefined) {
            // The tool call rejected (without timing out). lateError from
            // the .catch above holds the real error.
            throw lateError || new Error(`Tool '${name}' returned no result.`);
        }

        if (result.isError) {
            const text = result.content.map(c => c.text).join('\n');
            logToolCall(name, args, text, 'error');
            s.stop(`Execution Failed: ${name}`);
            return `Error: ${text}`;
        }

        let text = result.content.map(c => c.text).join('\n');
        // Tool-result sanitization: a malicious MCP server could send a 50MB
        // string; cap it so we don't blow the context window in one shot.
        if (text.length > 100000) {
            text = text.slice(0, 100000) + `\n\n[TRUNCATED: tool returned ${text.length.toLocaleString()} chars; showing first 100,000]`;
        }
        logToolCall(name, args, text, 'ok');
        s.stop(`Executed: ${name}`);
        return text;
    } catch (error) {
        logToolCall(name, args, error.message, 'error');
        s.stop(`Execution Failed: ${name}`);
        return `Error: ${error.message}`;
    }
}

export const MAX_FILE_SIZE = MAX_FILE_BYTES;