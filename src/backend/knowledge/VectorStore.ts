/**
 * MYRAA — VectorStore (Phase 4)
 *
 * In-process persistent vector database for semantic retrieval.
 * Stores documents and chunk vectors in DATA_DIR/knowledge_vectors.json.
 *
 * Safeguards & Reliability:
 *   • Atomic persistence using a .tmp file + rename prevents corruption.
 *   • In-memory cache avoids redundant disk reads.
 *   • Hybrid scoring: blends vector cosine similarity with lexical token matching
 *     for high accuracy on technical identifiers, keywords, and code names.
 *   • Bounded result limits (capped at MAX_VECTOR_RESULTS = 20).
 *   • Tag and source-type filtering.
 */

import * as fs from "fs/promises";
import * as fsSync from "fs";
import { dataFile } from "../../../server_paths.ts";
import {
  StoredDocument,
  VectorChunk,
  KnowledgeQueryOptions,
  MAX_VECTOR_RESULTS,
} from "./KnowledgeTypes.ts";
import { EmbeddingEngine } from "./EmbeddingEngine.ts";

const STORE_FILE = dataFile("knowledge_vectors.json");

interface VectorDatabaseSchema {
  version: number;
  documents: Record<string, StoredDocument>;
  chunks: Record<string, VectorChunk>;
  updatedAt: string;
}

export class VectorStore {
  private filePath: string;
  private cache: VectorDatabaseSchema | null = null;

  constructor(customPath?: string) {
    this.filePath = customPath || STORE_FILE;
  }

  /**
   * Loads the vector database from disk (with in-memory caching).
   */
  async load(): Promise<VectorDatabaseSchema> {
    if (this.cache !== null) {
      return this.cache;
    }

    try {
      if (fsSync.existsSync(this.filePath)) {
        const raw = await fs.readFile(this.filePath, "utf-8");
        const parsed = JSON.parse(raw) as VectorDatabaseSchema;
        this.cache = {
          version: parsed.version || 1,
          documents: parsed.documents || {},
          chunks: parsed.chunks || {},
          updatedAt: parsed.updatedAt || new Date().toISOString(),
        };
        return this.cache;
      }
    } catch (err) {
      console.warn("[VectorStore] Failed to read knowledge_vectors.json, initializing empty store:", err);
    }

    this.cache = {
      version: 1,
      documents: {},
      chunks: {},
      updatedAt: new Date().toISOString(),
    };
    return this.cache;
  }

  /**
   * Persists database atomically to disk.
   */
  async save(): Promise<void> {
    if (!this.cache) return;

    this.cache.updatedAt = new Date().toISOString();
    const tmpFile = `${this.filePath}.tmp`;
    const serialized = JSON.stringify(this.cache, null, 2);

    try {
      await fs.writeFile(tmpFile, serialized, "utf-8");
      await fs.rename(tmpFile, this.filePath);
    } catch (err) {
      console.error("[VectorStore] Atomic save failed:", err);
      try {
        await fs.unlink(tmpFile);
      } catch {
        /* ignore cleanup */
      }
      throw err;
    }
  }

  /**
   * Clears the in-memory cache (useful for test isolation).
   */
  clearCache(): void {
    this.cache = null;
  }

  /**
   * Upserts a document and replaces any prior chunks for that document.
   */
  async upsertDocument(doc: StoredDocument, chunks: VectorChunk[]): Promise<void> {
    const db = await this.load();

    // Remove any previous chunks associated with this docId
    for (const chunkId of Object.keys(db.chunks)) {
      if (db.chunks[chunkId].docId === doc.id) {
        delete db.chunks[chunkId];
      }
    }

    // Insert new document record
    db.documents[doc.id] = { ...doc };

    // Insert new chunks
    for (const chunk of chunks) {
      db.chunks[chunk.id] = { ...chunk };
    }

    await this.save();
  }

  /**
   * Deletes a document and all of its associated chunks.
   */
  async deleteDocument(docId: string): Promise<boolean> {
    const db = await this.load();
    if (!db.documents[docId]) {
      return false;
    }

    delete db.documents[docId];

    for (const chunkId of Object.keys(db.chunks)) {
      if (db.chunks[chunkId].docId === docId) {
        delete db.chunks[chunkId];
      }
    }

    await this.save();
    return true;
  }

  /**
   * Retrieves a single stored document by ID.
   */
  async getDocument(docId: string): Promise<StoredDocument | undefined> {
    const db = await this.load();
    return db.documents[docId];
  }

  /**
   * Lists all stored documents sorted by most recently updated.
   */
  async listDocuments(): Promise<StoredDocument[]> {
    const db = await this.load();
    return Object.values(db.documents).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  /**
   * Retrieves all chunks for a document.
   */
  async getChunksByDocument(docId: string): Promise<VectorChunk[]> {
    const db = await this.load();
    return Object.values(db.chunks)
      .filter((c) => c.docId === docId)
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  /**
   * Performs hybrid semantic vector search with lexical score blending.
   */
  async search(
    queryVector: number[],
    queryText: string = "",
    options: KnowledgeQueryOptions = {}
  ): Promise<Array<{ chunk: VectorChunk; score: number; similarity: number; lexicalScore: number }>> {
    const db = await this.load();
    const chunks = Object.values(db.chunks);

    if (chunks.length === 0) {
      return [];
    }

    const limit = Math.min(options.limit || 5, MAX_VECTOR_RESULTS);
    const minScore = options.minScore !== undefined ? options.minScore : 0.25;
    const sourceTypes = options.sourceTypes ? new Set(options.sourceTypes) : null;
    const filterTags = options.tags ? new Set(options.tags.map((t) => t.toLowerCase())) : null;

    // Tokenize query text for lexical overlap scoring
    const queryTokens = queryText
      .toLowerCase()
      .split(/[^a-z0-9_]+/i)
      .filter((t) => t.length > 1);

    const scored: Array<{
      chunk: VectorChunk;
      score: number;
      similarity: number;
      lexicalScore: number;
    }> = [];

    for (const chunk of chunks) {
      // 1. Source type filter
      if (sourceTypes && !sourceTypes.has(chunk.metadata.sourceType)) {
        continue;
      }

      // 2. Tag filter
      if (filterTags && !chunk.tags.some((t) => filterTags.has(t.toLowerCase()))) {
        continue;
      }

      // 3. Cosine similarity
      const similarity = EmbeddingEngine.cosineSimilarity(queryVector, chunk.embedding);

      // 4. Lexical token overlap score
      let lexicalScore = 0;
      if (queryTokens.length > 0) {
        const chunkTextLower = chunk.text.toLowerCase();
        let matches = 0;
        for (const token of queryTokens) {
          if (chunkTextLower.includes(token)) {
            matches++;
          }
        }
        lexicalScore = matches / queryTokens.length;
      }

      // 5. Hybrid blend: 70% vector similarity + 30% lexical keyword overlap
      // Map cosine similarity from [-1, 1] to [0, 1]
      const normalizedSim = Math.max(0, (similarity + 1) / 2);
      const hybridScore = queryTokens.length > 0
        ? 0.7 * normalizedSim + 0.3 * lexicalScore
        : normalizedSim;

      if (hybridScore >= minScore) {
        scored.push({
          chunk,
          score: hybridScore,
          similarity,
          lexicalScore,
        });
      }
    }

    // Sort descending by hybrid score
    scored.sort((a, b) => b.score - a.score);

    // Document-level deduplication: avoid monopolizing all top slots with the same doc
    const seenDocs = new Map<string, number>();
    const deduplicated: typeof scored = [];

    for (const item of scored) {
      const docCount = seenDocs.get(item.chunk.docId) || 0;
      // Allow at most 2 chunks per document in top results unless total results is small
      if (docCount < 2 || deduplicated.length < limit / 2) {
        seenDocs.set(item.chunk.docId, docCount + 1);
        deduplicated.push(item);
      }
      if (deduplicated.length >= limit) {
        break;
      }
    }

    return deduplicated;
  }
}

export const vectorStore = new VectorStore();
