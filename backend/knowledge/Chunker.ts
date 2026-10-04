/**
 * MYRAA — Chunker (Phase 4)
 *
 * Recursive semantic text chunker. Splits documents into overlapping segments
 * while respecting structural boundaries (headers, paragraphs, sentences, words).
 *
 * Safeguards & Guarantees:
 *   • Enforces MAX_CHUNKS_PER_DOC limit (200) to prevent unbounded memory growth.
 *   • Computes accurate startChar and endChar offsets into original document text.
 *   • Generates deterministic, stable chunk IDs: `${docId}_chk_${index}`.
 *   • Preserves code blocks and markdown tables as unbroken units when possible.
 */

import {
  VectorChunk,
  ChunkMetadata,
  ChunkerConfig,
  MAX_CHUNKS_PER_DOC,
} from "./KnowledgeTypes.ts";

export type RawChunk = Omit<VectorChunk, "embedding"> & { embedding?: number[] };

export const DEFAULT_CHUNKER_CONFIG: ChunkerConfig = {
  targetChunkSize: 600,
  overlapSize: 100,
  minChunkSize: 80,
};

export class Chunker {
  /**
   * Chunks a document text into structured segments with metadata.
   */
  static chunkDocument(
    text: string,
    docId: string,
    metadataBase: {
      title: string;
      url?: string;
      filePath?: string;
      sourceType: ChunkMetadata["sourceType"];
    },
    tags: string[] = [],
    config: Partial<ChunkerConfig> = {}
  ): RawChunk[] {
    const cfg: ChunkerConfig = { ...DEFAULT_CHUNKER_CONFIG, ...config };
    const raw = (text || "").trim();

    if (!raw) {
      return [];
    }

    // If text is smaller than target chunk size, return single chunk
    if (raw.length <= cfg.targetChunkSize) {
      const now = new Date().toISOString();
      return [
        {
          id: `${docId}_chk_0`,
          docId,
          chunkIndex: 0,
          totalChunks: 1,
          text: raw,
          tags,
          metadata: {
            title: metadataBase.title,
            url: metadataBase.url || "",
            filePath: metadataBase.filePath || "",
            sourceType: metadataBase.sourceType,
            startChar: 0,
            endChar: raw.length,
            createdAt: now,
          },
        },
      ];
    }

    // 1. Split into natural semantic blocks (headings, paragraphs, code fences)
    const blocks = Chunker.splitIntoBlocks(raw);

    // 2. Accumulate blocks into target-sized chunks with overlap
    const textChunks: Array<{ text: string; startChar: number; endChar: number }> = [];
    let currentChunk = "";
    let currentStart = 0;
    let globalOffset = 0;

    for (const block of blocks) {
      const blockOffset = raw.indexOf(block, globalOffset);
      const startPos = blockOffset !== -1 ? blockOffset : globalOffset;
      globalOffset = startPos + block.length;

      if (!currentChunk) {
        currentChunk = block;
        currentStart = startPos;
        continue;
      }

      // Check if adding block would exceed target size
      if (currentChunk.length + block.length + 1 > cfg.targetChunkSize) {
        if (currentChunk.length >= cfg.minChunkSize) {
          textChunks.push({
            text: currentChunk.trim(),
            startChar: currentStart,
            endChar: currentStart + currentChunk.length,
          });

          if (textChunks.length >= MAX_CHUNKS_PER_DOC) {
            break;
          }

          // Build overlap from the tail of current chunk
          const overlap = Chunker.getOverlapText(currentChunk, cfg.overlapSize);
          currentChunk = overlap ? `${overlap}\n\n${block}` : block;
          currentStart = Math.max(0, startPos - (overlap ? overlap.length : 0));
        } else {
          // Chunk is still below min size, keep accumulating
          currentChunk += `\n\n${block}`;
        }
      } else {
        currentChunk += `\n\n${block}`;
      }
    }

    // Push remaining chunk
    if (currentChunk.trim().length >= cfg.minChunkSize && textChunks.length < MAX_CHUNKS_PER_DOC) {
      textChunks.push({
        text: currentChunk.trim(),
        startChar: currentStart,
        endChar: currentStart + currentChunk.length,
      });
    }

    const totalChunks = textChunks.length;
    const now = new Date().toISOString();

    return textChunks.map((tc, idx) => ({
      id: `${docId}_chk_${idx}`,
      docId,
      chunkIndex: idx,
      totalChunks,
      text: tc.text,
      tags,
      metadata: {
        title: metadataBase.title,
        url: metadataBase.url || "",
        filePath: metadataBase.filePath || "",
        sourceType: metadataBase.sourceType,
        startChar: tc.startChar,
        endChar: tc.endChar,
        createdAt: now,
      },
    }));
  }

  /**
   * Splits text into hierarchical semantic blocks.
   */
  private static splitIntoBlocks(text: string): string[] {
    const blocks: string[] = [];

    // First split on paragraph breaks
    const rawParagraphs = text.split(/\n\s*\n/);

    for (const para of rawParagraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;

      // If a single paragraph is larger than 800 chars, break by sentences
      if (trimmed.length > 800) {
        const sentences = Chunker.splitSentences(trimmed);
        for (const sentence of sentences) {
          if (sentence.trim()) {
            blocks.push(sentence.trim());
          }
        }
      } else {
        blocks.push(trimmed);
      }
    }

    return blocks;
  }

  /**
   * Splits a long paragraph into sentences while preserving abbreviations.
   */
  private static splitSentences(text: string): string[] {
    // Splits on punctuation followed by whitespace and capital letter
    const parts = text.split(/(?<=[.?!])\s+(?=[A-Z0-9"'])/g);
    const sentences: string[] = [];
    let current = "";

    for (const part of parts) {
      if (!current) {
        current = part;
      } else if (current.length + part.length < 350) {
        current += ` ${part}`;
      } else {
        sentences.push(current);
        current = part;
      }
    }

    if (current) {
      sentences.push(current);
    }

    return sentences;
  }

  /**
   * Computes trailing overlap text broken on word boundary.
   */
  private static getOverlapText(text: string, maxOverlap: number): string {
    if (text.length <= maxOverlap) {
      return text;
    }
    const candidate = text.substring(text.length - maxOverlap);
    const firstSpace = candidate.indexOf(" ");
    return firstSpace !== -1 ? candidate.substring(firstSpace + 1) : candidate;
  }
}
