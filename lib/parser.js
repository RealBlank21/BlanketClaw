import fs from 'fs/promises';
import path from 'path';
import officeParser from 'officeparser';
import { extractText, getDocumentProxy } from 'unpdf';
import { logDebug } from './logger.js';

export async function parseFileContent(filePath) {
    const ext = path.extname(filePath).toLowerCase();

    try {
        if (ext === '.pdf') {
            logDebug('parser', `Modern PDF Extraction: ${filePath}`);
            
            const buffer = await fs.readFile(filePath);
            // Load the PDF into a proxy object
            const pdf = await getDocumentProxy(new Uint8Array(buffer));
            // Extract text from all pages and merge them
            const { text } = await extractText(pdf, { mergePages: true });
            
            return text;
            
        } else if (['.docx', '.pptx', '.xlsx', '.doc', '.ppt', '.xls'].includes(ext)) {
            logDebug('parser', `Office Extraction: ${filePath}`);
            return await officeParser.parseOfficeAsync(filePath);
            
        } else {
            logDebug('parser', `Standard Text Extraction: ${filePath}`);
            return await fs.readFile(filePath, 'utf-8');
        }
    } catch (error) {
        logDebug('parser_error', `Failed to parse ${filePath}`, { error: error.message });
        throw new Error(`Extraction failed. The file might be corrupted or in an unsupported format. (${error.message})`);
    }
}