import fs from 'fs';
import path from 'path';
import fg from 'fast-glob';
import { state } from './state.js';
import { parseFileContent } from './parser.js';

// Sandboxed file loader. All paths are resolved relative to process.cwd()
// and rejected if they escape it. This closes the glob-injection hole where
// `/load ../../etc/passwd` would have worked.
function safeResolve(p) {
    const resolved = path.resolve(process.cwd(), p);
    const root = path.resolve(process.cwd());
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
        throw new Error(`Path '${p}' escapes the current working directory.`);
    }
    return resolved;
}

// Verify a path is inside CWD using fs.realpath (resolves symlinks). Throws
// if the link target points outside CWD. Returns the resolved real path.
// This closes the symlink-escape hole where `safeResolve` would pass a path
// like `sneaky -> /etc/passwd` because the textual path was inside CWD.
function realpathInsideCwd(fullPath) {
    let real;
    try {
        real = fs.realpathSync(fullPath);
    } catch (_) {
        // If the path doesn't exist, let downstream stat fail naturally.
        return fullPath;
    }
    const root = path.resolve(process.cwd());
    if (!real.startsWith(root + path.sep) && real !== root) {
        throw new Error(`Symlink '${fullPath}' resolves outside the current working directory.`);
    }
    return real;
}

// Single source of truth for the `/load` command. Replaces the old
// implementation in commands.js AND the dead code in the original files.js.
//
// `options.recursive` lets callers request deep directory traversal when
// the user passes `/load all **`. Defaults to false so existing call sites
// (and the deep:1 behaviour they expect) are unchanged.
export async function loadFiles(pattern, { allowAll = true, recursive = false } = {}) {
    let patterns;
    if (pattern === 'all') {
        if (!allowAll) return { loaded: 0, protected: 0, names: [], tokens: 0 };
        patterns = ['*'];
    } else {
        patterns = [pattern];
    }

    let files;
    try {
        // When recursive is requested (e.g. `/load all **`), scan without a
        // depth limit. Otherwise match files only and at the top level so we
        // stay consistent with the documented `/load` behaviour.
        const opts = recursive
            ? { dot: true, onlyFiles: true, cwd: process.cwd() }
            : { dot: true, onlyFiles: true, deep: 1, cwd: process.cwd() };
        files = fg.sync(patterns, opts);
    } catch (e) {
        throw new Error(`Invalid glob: ${e.message}`);
    }

    if (files.length === 0) return { loaded: 0, protected: 0, names: [], tokens: 0 };

    // Pre-resolve every path's real (symlink-free) location before we do any
    // IO so we can parallelize the actual file reads safely. Anything that
    // fails the sandbox check is collected for a single aggregated error
    // below rather than silently dropped.
    const resolved = [];
    const skipped = [];
    for (const relative of files) {
        let full;
        try { full = safeResolve(relative); } catch (e) { skipped.push(`${relative}: ${e.message}`); continue; }
        let safeFull;
        try { safeFull = realpathInsideCwd(full); } catch (e) { skipped.push(`${relative}: ${e.message}`); continue; }
        resolved.push({ relative, safeFull });
    }

    let loaded = 0;
    let protectedCount = 0;
    let totalTokens = 0;
    const names = [];

    // Process files in parallel — parseFileContent is the dominant cost and
    // it's safe to fan out (each call is independent).
    const results = await Promise.all(resolved.map(async ({ relative, safeFull }) => {
        const basename = path.basename(safeFull);
        const isProtected = basename.startsWith('.');

        // Replace existing entry if any (refresh-on-load semantics).
        const existingIdx = state.loadedFiles.findIndex(f => f.name === relative);
        if (existingIdx !== -1) state.loadedFiles.splice(existingIdx, 1);

        if (isProtected) {
            state.loadedFiles.push({
                name: relative,
                content: '(Content withheld for security)',
                isProtected: true
            });
            return { ok: false, protected: true, relative };
        }

        let stat;
        try { stat = fs.statSync(safeFull); } catch (_) { return { ok: false, relative }; }
        if (!stat.isFile()) return { ok: false, relative };

        try {
            const content = await parseFileContent(safeFull);
            state.loadedFiles.push({
                name: relative,
                content,
                isProtected: false
            });
            return { ok: true, relative, tokens: Math.ceil(content.length / 4) };
        } catch (err) {
            return { ok: false, relative };
        }
    }));

    for (const r of results) {
        if (r.ok) {
            loaded++;
            names.push(r.relative);
            totalTokens += r.tokens;
        } else if (r.protected) {
            protectedCount++;
        }
    }

    // If we had any skipped paths, surface a single aggregated error so the
    // user understands why their `/load ../...` produced zero results
    // (previously it was a silent no-op).
    if (loaded === 0 && protectedCount === 0 && skipped.length > 0) {
        throw new Error(`Skipped ${skipped.length} path(s): ${skipped.join('; ')}`);
    }

    return { loaded, protected: protectedCount, names, tokens: totalTokens };
}