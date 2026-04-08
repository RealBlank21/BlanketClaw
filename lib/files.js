import fs from 'fs';
import path from 'path';
import fg from 'fast-glob';
import * as p from '@clack/prompts';
import { state } from './state.js';

export function handleLoadFiles(pattern) {
    let filesToProcess = [];
    
    if (pattern === 'all') {
        filesToProcess = fg.sync(['*'], { dot: true, onlyFiles: false, deep: 1 });
    } else {
        filesToProcess = fg.sync([pattern], { dot: true, onlyFiles: false });
    }

    if (filesToProcess.length === 0) {
        p.log.warn(`No files found matching: ${pattern}`);
        return null;
    }

    let loadedCount = 0;
    let protectedCount = 0;
    let loadedNames = [];
    let addedCharCount = 0; // Track the raw text size for token estimation

    for (const file of filesToProcess) {
        const fullPath = path.resolve(process.cwd(), file);
        const isDir = fs.statSync(fullPath).isDirectory();
        const basename = path.basename(file);
        const isProtected = basename.startsWith('.');

        const existingIndex = state.loadedFiles.findIndex(f => f.name === file);
        if (existingIndex > -1) {
            state.loadedFiles.splice(existingIndex, 1);
        }

        if (isProtected) {
            state.loadedFiles.push({
                name: isDir ? `${file}/` : file,
                content: isDir ? '(Directory withheld)' : '(Content withheld for security)',
                isProtected: true
            });
            protectedCount++;
        } else if (!isDir) {
            try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                state.loadedFiles.push({
                    name: file,
                    content: content,
                    isProtected: false
                });
                loadedNames.push(file);
                loadedCount++;
                addedCharCount += content.length; // Accumulate character length
            } catch (e) {
                p.log.warn(`Could not read text from ${file}`);
            }
        }
    }

    // 1 Token is roughly 4 characters
    const addedTokens = Math.ceil(addedCharCount / 4);

    p.note(`Loaded ${loadedCount} readable files. (+ ${addedTokens.toLocaleString()} Tokens)\nLogged ${protectedCount} protected hidden files/folders.`, 'File System');
    
    return { loadedCount, protectedCount, loadedNames };
}