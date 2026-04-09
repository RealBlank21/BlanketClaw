import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile } from 'fs/promises';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { state } from './state.js';
import { logDebug } from './logger.js';
import { parseFileContent } from './parser.js';

const execAsync = promisify(exec);

export const tools = [
    {
        type: "function",
        function: {
            name: "execute_shell",
            description: "Executes a shell command in the current working directory.",
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string" }
                },
                required: ["command"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "read_file",
            description: "Reads the contents of a specified file.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string" }
                },
                required: ["path"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "write_file",
            description: "Writes content to a file. DO NOT pass the code in the arguments! Write the code in a markdown block (e.g., ```python ... ```) in your text response, then call this tool with ONLY the 'path'.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "The path to the file." }
                },
                required: ["path"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "edit_file",
            description: "Replaces text in a file. Use plain strings for find/replace. For complex multiline edits, use write_file to overwrite the entire file instead.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string" },
                    find: { type: "string" },
                    replace: { type: "string" }
                },
                required: ["path", "find", "replace"]
            }
        }
    }
];

export async function executeTool(toolCall) {
    const name = toolCall.function.name;
    const args = toolCall.function.arguments;

    logDebug('tool_exec', `Requested ${name}`, args);

    if (state.isVerbose) {
        p.log.message(pc.magenta(`[Tool Requested: ${name}]`));
    }

    let isApproved = state.alwaysAllowShell;

    if (!isApproved && name !== 'read_file') {
        const displayArg = name === 'execute_shell' ? args.command : args.path;
        const action = await p.select({
            message: pc.yellow(`BlanketClaw wants to run ${pc.bold(name)} on: ${pc.bold(displayArg)}`),
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
        isApproved = true;
    }

    if (isApproved || name === 'read_file') {
        const s = p.spinner();
        s.start(`Executing: ${name}`);
        try {
            if (name === 'execute_shell') {
                const { stdout, stderr } = await execAsync(args.command, { cwd: process.cwd() });
                s.stop(`Executed: ${name}`);
                return stdout || stderr || "Command executed successfully with no output.";
            } else if (name === 'read_file') {
                const content = await parseFileContent(args.path);
                s.stop(`Read: ${args.path}`);
                return content;
            } else if (name === 'write_file') {
                // THE HACK: Extract content from the assistant's text response!
                const lastMessage = state.history[state.history.length - 1];
                const textContent = lastMessage?.content || "";
                
                const codeBlockRegex = /```[\w]*\n([\s\S]*?)```/g;
                let match;
                let extractedContent = "";
                
                // Grab the LAST code block generated in the text
                while ((match = codeBlockRegex.exec(textContent)) !== null) {
                    extractedContent = match[1];
                }

                // Fallback if the AI stubbornly puts it in the args anyway
                if (!extractedContent && args.content) {
                    extractedContent = Array.isArray(args.content) ? args.content.join('\n') : args.content;
                }
                
                if (!extractedContent) {
                    s.stop(`Write Failed: ${args.path}`);
                    return `Error: No markdown code block found. Write the code in a markdown block first, then call write_file with ONLY the path.`;
                }
                
                await writeFile(args.path, extractedContent.trim(), 'utf-8');
                s.stop(`Written: ${args.path}`);
                return `Successfully wrote to ${args.path}`;
            } else if (name === 'edit_file') {
                let content = await readFile(args.path, 'utf-8');
                if (!content.includes(args.find)) {
                    s.stop(`Edit Failed: ${args.path}`);
                    return `Error: Exact string not found.`;
                }
                content = content.replace(args.find, args.replace);
                await writeFile(args.path, content, 'utf-8');
                s.stop(`Edited: ${args.path}`);
                return `Successfully edited ${args.path}`;
            }
        } catch (error) {
            s.stop(`Execution Failed: ${name}`);
            return `Error: ${error.message}`;
        }
    }
    return "Unknown tool.";
}