import { promises as fs } from 'fs';
import * as path from 'path';
import { loadRequirements } from './embedder';

/** Folder scanned for requirement documents. */
export const REQUIREMENTS_DIR = path.resolve(process.cwd(), 'data', 'requirements');

/** File extensions that are ingested. */
const EXTENSIONS = new Set(['.txt', '.md']);

/** Chunk count for one ingested file. */
export interface IngestResult {
  file: string;
  chunks: number;
  /** Set if this file failed; other files are still ingested. */
  error?: string;
}

/**
 * Loads every .txt and .md file in data/requirements/ into ChromaDB and
 * prints the chunk count per file. A failure on one file does not stop the rest.
 *
 * @param dir - Folder to scan (default data/requirements/).
 * @returns One result per file.
 * @throws If the folder cannot be read.
 */
export async function ingestRequirements(dir: string = REQUIREMENTS_DIR): Promise<IngestResult[]> {
  try {
    const files = (await fs.readdir(dir))
      .filter((f) => EXTENSIONS.has(path.extname(f).toLowerCase()))
      .sort();

    if (files.length === 0) {
      console.warn(`No .txt or .md files found in ${dir}`);
      return [];
    }

    const results: IngestResult[] = [];
    for (const file of files) {
      try {
        const chunks = await loadRequirements(path.join(dir, file));
        results.push({ file, chunks });
        console.log(`  ${file.padEnd(40)} ${String(chunks).padStart(5)} chunks${chunks === 0 ? '  (file is empty)' : ''}`);
      } catch (error) {
        const message = (error as Error).message;
        results.push({ file, chunks: 0, error: message });
        console.error(`  ${file.padEnd(40)} FAILED: ${message}`);
      }
    }

    const total = results.reduce((sum, r) => sum + r.chunks, 0);
    const failed = results.filter((r) => r.error).length;
    console.log(`Loaded ${total} chunks from ${results.length - failed}/${results.length} file(s).`);
    return results;
  } catch (error) {
    throw new Error(`Failed to ingest requirements from "${dir}": ${(error as Error).message}`);
  }
}

// Run directly: npm run rag:ingest
if (require.main === module) {
  ingestRequirements()
    .then((results) => {
      if (results.some((r) => r.error)) process.exit(1);
    })
    .catch((error: Error) => {
      console.error(error.message);
      process.exit(1);
    });
}
