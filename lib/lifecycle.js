// Lifecycle helpers shared between the REPL loop and the command handler.
// Extracted so we don't introduce a circular import between index.js and
// commands.js (commands.js needs gracefulShutdown for /quit; index.js
// needs it for Ctrl-C).

import * as p from '@clack/prompts';
import pc from 'picocolors';
import { shutdownMcp } from './tools.js';
import { flushHistoryWrite } from './state.js';

export async function gracefulShutdown() {
    // Flush any pending history write so we don't lose the last entry.
    try { flushHistoryWrite(); } catch (_) { /* ignore */ }
    try { await shutdownMcp(); } catch (_) { /* ignore */ }
    p.outro(pc.green('Goodbye!'));
    process.exit(0);
}