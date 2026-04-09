import * as p from '@clack/prompts';
import pc from 'picocolors';
import { state } from './state.js';
import { logDebug } from './logger.js';
import { CACHE_DIR } from './config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export let tools = [];
const mcpClients = {};

const mcpServers = [
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

export async function setupMcp() {
    for (const config of mcpServers) {
        try {
            const transport = new StdioClientTransport({
                command: config.command,
                args: config.args,
                env: process.env,
                stderr: 'ignore' 
            });

            const client = new Client(
                { name: "blanketclaw", version: "1.0.0" },
                { capabilities: { tools: {} } }
            );

            await client.connect(transport);
            const toolsResponse = await client.listTools();

            for (const tool of toolsResponse.tools) {
                if (!tools.find(t => t.function.name === tool.name)) {
                    tools.push({
                        type: "function",
                        function: {
                            name: tool.name,
                            description: tool.description,
                            parameters: tool.inputSchema
                        }
                    });
                }
                mcpClients[tool.name] = client;
            }
            logDebug('mcp', `Connected to MCP server: ${config.name}`);
        } catch (error) {
            logDebug('mcp_error', `Failed to connect to MCP server: ${config.name}`, { error: error.message });
        }
    }
}

export async function executeTool(toolCall) {
    const name = toolCall.function.name;
    const args = toolCall.function.arguments;

    logDebug('tool_exec', `Requested ${name}`, args);

    if (state.isVerbose) {
        p.log.message(pc.magenta(`[Tool Requested: ${name}]`));
    }

    const client = mcpClients[name];
    if (!client) {
        return `Error: Unknown tool '${name}' or MCP server disconnected.`;
    }

    let isApproved = state.alwaysAllowShell;
    const isReadTool = name.includes('read') || name.includes('list') || name.includes('search') || name.includes('info');

    if (!isApproved && !isReadTool) {
        const displayArg = JSON.stringify(args);
        const action = await p.select({
            message: pc.yellow(`BlanketClaw wants to run ${pc.bold(name)} with args: ${pc.dim(displayArg.substring(0, 100))}${displayArg.length > 100 ? '...' : ''}`),
            options: [
                { value: 'allow', label: 'Allow Once' },
                { value: 'always', label: 'Always Allow (Session)' },
                { value: 'deny', label: 'Deny' }
            ]
        });

        if (p.isCancel(action) || action === 'deny') {
            return "User denied execution of this tool.";
        }
        if (action === 'always') state.alwaysAllowShell = true;
    }

    const s = p.spinner();
    s.start(`Executing: ${name}`);

    try {
        const result = await client.callTool({
            name: name,
            arguments: args
        });
        s.stop(`Executed: ${name}`);

        if (result.isError) {
            return `Error: ${result.content.map(c => c.text).join('\n')}`;
        }

        return result.content.map(c => c.text).join('\n');
    } catch (error) {
        s.stop(`Execution Failed: ${name}`);
        return `Error: ${error.message}`;
    }
}