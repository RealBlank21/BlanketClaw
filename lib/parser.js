import fs from 'fs/promises';
import path from 'path';
import { MAX_FILE_SIZE, isBinaryFile } from './tools.js';
import { logDebug } from './logger.js';

// Parse a file into plain text suitable for stuffing into the LLM context.
// We support:
//   - plain text (any extension, unless it's a known binary blob)
//   - PDFs (unpdf)
//   - Office documents (officeparser) — .docx, .pptx, .xlsx, .doc, .ppt, .xls
//
// For binary blobs we throw a friendly error rather than dumping base64 garbage
// into the context window.
export async function parseFileContent(filePath) {
    const ext = path.extname(filePath).toLowerCase();

    // Hard cap on file size — protects against accidental load of a 5GB log.
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_FILE_SIZE) {
        throw new Error(`File is ${(stat.size / 1024 / 1024).toFixed(1)} MB; the cap is ${MAX_FILE_SIZE / 1024 / 1024} MB. Use a tool to read it in chunks instead.`);
    }

    try {
        if (ext === '.pdf') {
            logDebug('parser', `PDF Extraction: ${filePath}`);
            const { extractText, getDocumentProxy } = await import('unpdf');
            const buffer = await fs.readFile(filePath);
            const pdf = await getDocumentProxy(new Uint8Array(buffer));
            const { text } = await extractText(pdf, { mergePages: true });
            return text;
        } else if (['.docx', '.pptx', '.xlsx', '.doc', '.ppt', '.xls'].includes(ext)) {
            logDebug('parser', `Office Extraction: ${filePath}`);
            const officeParser = (await import('officeparser')).default;
            return await officeParser.parseOfficeAsync(filePath);
        } else if (isBinaryFile(filePath)) {
            throw new Error(`Refusing to load binary file (${ext}). Use a dedicated tool to handle ${path.basename(filePath)}.`);
        } else {
            logDebug('parser', `Standard Text Extraction: ${filePath}`);
            return await fs.readFile(filePath, 'utf-8');
        }
    } catch (error) {
        logDebug('parser_error', `Failed to parse ${filePath}`, { error: error.message });
        throw new Error(`Extraction failed: ${error.message}`);
    }
}