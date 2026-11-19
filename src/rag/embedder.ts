import { promises as fs } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { DefaultEmbeddingFunction, IEmbeddingFunction } from 'chromadb';

dotenv.config();

/**
 * Embeddings are produced locally by Chroma's DefaultEmbeddingFunction
 * (all-MiniLM-L6-v2), so no API key is needed here. GEMINI_API_KEY is used
 * only by the generation side (src/generators/claudeClient.ts).
 */

/** Name of the ChromaDB collection that holds requirement chunks. */
export const COLLECTION_NAME = 'banking_requirements';

/** Size of each chunk, in characters. */
export const CHUNK_SIZE = 500;

/** Number of characters shared between consecutive chunks. */
export const CHUNK_OVERLAP = 50;

/** Max records sent to ChromaDB in a single upsert call. */
const UPSERT_BATCH_SIZE = 100;

/** Metadata stored alongside each chunk. */
export interface ChunkMetadata {
  source: string;
  chunkIndex: number;
  start: number;
  end: number;
  [key: string]: string | number;
}

/** A single chunk of text with its position in the source document. */
export interface TextChunk {
  text: string;
  start: number;
  end: number;
}

/** A stored record: the chunk text, its metadata, and its embedding. */
interface StoredRecord {
  document: string;
  metadata: ChunkMetadata;
  embedding: number[];
}

/**
 * In-memory stand-in for a Chroma collection (the JS chromadb client has no
 * EphemeralClient; it only speaks HTTP). It exposes the same upsert/query
 * shape used below, embeds with Chroma's DefaultEmbeddingFunction, and ranks
 * by squared L2 distance (Chroma's default metric). Data lives only for the
 * lifetime of the process.
 */
class InMemoryCollection {
  private readonly records = new Map<string, StoredRecord>();

  constructor(
    readonly name: string,
    private readonly embedder: IEmbeddingFunction,
  ) {}

  /** Number of stored records. */
  get size(): number {
    return this.records.size;
  }

  async upsert(params: { ids: string[]; documents: string[]; metadatas: ChunkMetadata[] }): Promise<void> {
    const { ids, documents, metadatas } = params;
    if (ids.length !== documents.length || ids.length !== metadatas.length) {
      throw new Error('ids, documents and metadatas must have the same length');
    }
    const embeddings = await this.embedder.generate(documents);
    ids.forEach((id, i) => {
      this.records.set(id, { document: documents[i], metadata: metadatas[i], embedding: embeddings[i] });
    });
  }

  async query(params: { queryTexts: string[]; nResults: number }): Promise<{ documents: (string | null)[][] }> {
    const queryEmbeddings = await this.embedder.generate(params.queryTexts);
    const all = [...this.records.values()];
    const documents = queryEmbeddings.map((q) =>
      all
        .map((r) => ({ doc: r.document, dist: squaredL2(q, r.embedding) }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, params.nResults)
        .map((r) => r.doc),
    );
    return { documents };
  }
}

/** Squared Euclidean distance between two vectors of equal length. */
function squaredL2(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum;
}

const embeddingFunction = new DefaultEmbeddingFunction();
let collection: InMemoryCollection | null = null;

/**
 * Returns the in-memory "banking_requirements" collection, creating it if needed.
 * The handle is cached so repeated calls reuse one collection object.
 *
 * @returns The collection.
 * @throws If the collection cannot be created.
 */
async function getCollection(): Promise<InMemoryCollection> {
  try {
    if (!collection) collection = new InMemoryCollection(COLLECTION_NAME, embeddingFunction);
    return collection;
  } catch (error) {
    collection = null;
    throw new Error(`Failed to get collection "${COLLECTION_NAME}": ${(error as Error).message}`);
  }
}

/**
 * Splits text into fixed-size chunks that overlap by a set number of characters.
 *
 * @param text - The text to split.
 * @param chunkSize - Characters per chunk (default 500).
 * @param overlap - Characters shared between consecutive chunks (default 50).
 * @returns The chunks in order, with start/end offsets into the original text.
 * @throws If chunkSize is not positive or overlap is not smaller than chunkSize.
 */
export function chunkText(
  text: string,
  chunkSize: number = CHUNK_SIZE,
  overlap: number = CHUNK_OVERLAP,
): TextChunk[] {
  try {
    if (chunkSize <= 0) throw new Error('chunkSize must be greater than 0');
    if (overlap < 0 || overlap >= chunkSize) throw new Error('overlap must be >= 0 and smaller than chunkSize');

    const chunks: TextChunk[] = [];
    const step = chunkSize - overlap;

    for (let start = 0; start < text.length; start += step) {
      const end = Math.min(start + chunkSize, text.length);
      const slice = text.slice(start, end);
      if (slice.trim().length > 0) chunks.push({ text: slice, start, end });
      if (end === text.length) break;
    }
    return chunks;
  } catch (error) {
    throw new Error(`Failed to chunk text: ${(error as Error).message}`);
  }
}

/**
 * Reads a requirements text file, splits it into 500-character chunks with a
 * 50-character overlap, and stores them in the "banking_requirements" collection.
 *
 * Chunk IDs are derived from the file name and chunk index, so loading the same
 * file again updates its chunks instead of duplicating them.
 *
 * @param filePath - Path to the text file to load.
 * @returns The number of chunks stored.
 * @throws If the file cannot be read or ChromaDB rejects the write.
 */
export async function loadRequirements(filePath: string): Promise<number> {
  try {
    const text = await fs.readFile(filePath, 'utf-8');
    const chunks = chunkText(text);
    if (chunks.length === 0) return 0;

    const collection = await getCollection();
    const source = path.basename(filePath);

    for (let i = 0; i < chunks.length; i += UPSERT_BATCH_SIZE) {
      const batch = chunks.slice(i, i + UPSERT_BATCH_SIZE);
      await collection.upsert({
        ids: batch.map((_, j) => `${source}::${i + j}`),
        documents: batch.map((c) => c.text),
        metadatas: batch.map(
          (c, j): ChunkMetadata => ({ source, chunkIndex: i + j, start: c.start, end: c.end }),
        ),
      });
    }

    return chunks.length;
  } catch (error) {
    throw new Error(`Failed to load requirements from "${filePath}": ${(error as Error).message}`);
  }
}

/** The in-progress or finished auto-load, shared so concurrent queries load only once. */
let autoLoad: Promise<void> | null = null;

/**
 * Loads data/requirements/ into the collection. Called by retrieve() when the
 * store is empty, because the in-memory store starts empty in every new process.
 * ingest.ts is imported lazily because it imports this module.
 */
function autoLoadRequirements(): Promise<void> {
  if (!autoLoad) {
    autoLoad = (async () => {
      console.log('Requirements not loaded in this process yet; loading data/requirements/...');
      const { ingestRequirements } = await import('./ingest');
      await ingestRequirements();
    })().catch((error: Error) => {
      autoLoad = null; // allow a retry on the next query
      throw error;
    });
  }
  return autoLoad;
}

/**
 * Finds the requirement chunks most similar to a query. If nothing is loaded
 * yet in this process, loads data/requirements/ first.
 *
 * @param query - The search text.
 * @param topK - How many chunks to return (default 5).
 * @returns The matching chunk texts, most relevant first.
 * @throws If the query is empty, topK is invalid, or the ChromaDB query fails.
 */
export async function retrieve(query: string, topK: number = 5): Promise<string[]> {
  try {
    if (!query.trim()) throw new Error('query must not be empty');
    if (!Number.isInteger(topK) || topK < 1) throw new Error('topK must be a positive integer');

    const collection = await getCollection();
    if (collection.size === 0) await autoLoadRequirements();
    if (collection.size === 0) {
      throw new Error('no requirements are loaded: add .txt or .md files to data/requirements/');
    }
    const results = await collection.query({ queryTexts: [query], nResults: topK });

    return (results.documents[0] ?? []).filter((doc): doc is string => typeof doc === 'string');
  } catch (error) {
    throw new Error(`Failed to retrieve chunks for query "${query}": ${(error as Error).message}`);
  }
}
