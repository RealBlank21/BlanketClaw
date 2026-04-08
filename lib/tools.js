import { exec } from 'child_process';
import { promisify } from 'util';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { state } from './state.js';

const execAsync = promisify(exec);

export const tools = [
    {
        type: "function",
        function: {
            name: "execute_shell",
            description: "Executes a shell command in the current working directory. Returns stdout on success, and stderr on failure. If a command fails, read the stderr carefully and attempt to fix the error.",
            parameters: {
                type: "object",
                properties: {
                    command: {
                        type: "string",
                        description: "The shell command to execute."
                    }
                },
                required: ["command"]
            }
        }
    }
];

export async function executeTool(toolCall) {
    if (toolCall.function.name === 'execute_shell') {
        const args = toolCall.function.arguments;
        const command = args.command;

        if (state.isVerbose) {
            p.log.message(pc.magenta(`[Tool Requested: execute_shell -> ${command}]`));
        }

        let isApproved = state.alwaysAllowShell;

        if (!isApproved) {
            const action = await p.select({
                message: pc.yellow(`BlanketClaw wants to run: ${pc.bold(command)}`),
                options: [
                    { value: 'allow', label: 'Allow Once' },
                    { value: 'always', label: 'Always Allow (Session)' },
                    { value: 'deny', label: 'Deny' }
                ]
            });

            if (p.isCancel(action) || action === 'deny') {
                return "User denied execution of this command.";
            }

            if (action === 'always') {
                state.alwaysAllowShell = true;
            }
            
            isApproved = true;
        }

        if (isApproved) {
            const s = p.spinner();
            s.start(`Executing: ${command}`);
            try {
                const { stdout, stderr } = await execAsync(command, { cwd: process.cwd() });
                s.stop(`Executed: ${command}`);
                return stdout || stderr || "Command executed successfully with no output.";
            } catch (error) {
                s.stop(`Execution Failed: ${command}`);
                return `Error: ${error.stderr || error.message}`;
            }
        }
    }
    return "Unknown tool.";
}