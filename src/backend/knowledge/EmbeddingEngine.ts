/**
 * MYRAA — EmbeddingEngine (Phase 4)
 *
 * Dual-mode vector embedding provider:
 *   1. Online Mode (Google Gemini API):
 *      Uses `text-embedding-004` (or configured via SORA_EMBEDDING_MODEL) via @google/genai.
 *      Produces true semantic dense embeddings.
 *
 *   2. Offline / Fallback Mode (Deterministic Lexical n-gram Projection):
 *      ========================================================================
 *      IMPORTANT ARCHITECTURAL NOTE:
 *      The deterministic fallback produces lexical n-gram hash projection
 *      vectors, NOT true semantic embeddings.
 *      It captures token overlap, morphology, and character subwords to enable
 *      lexical similarity matching offline or in test environments without an API key.
 *      It should NOT be confused with a deep semantic neural embedding.
 *      ========================================================================
 *
 * Security & Reliability Safeguards:
 *   • Sanitizes errors to prevent Gemini API keys from leaking into logs.
 *   • Never throws on network or quota errors — gracefully falls back to deterministic mode.
 *   • Output vectors are L2-normalized so dot product equals cosine similarity.
 */

import { GoogleGenAI } from "@google/genai";
import { getGeminiApiKey } from "../../../server_paths.ts";
import { sanitizeError } from "../security/PermissionManager.ts";
import {
  EmbeddingEngineConfig,
  EmbeddingMode,
} from "./KnowledgeTypes.ts";

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingEngineConfig = {
  model: process.env.SORA_EMBEDDING_MODEL || "gemini-embedding-001",
  outputDimensionality: 256,
};

export class EmbeddingEngine {
  private config: EmbeddingEngineConfig;

  constructor(config: Partial<EmbeddingEngineConfig> = {}) {
    this.config = {
      model: process.env.SORA_EMBEDDING_MODEL || "gemini-embedding-001",
      outputDimensionality: 256,
      ...config,
    };
  }

  /**
   * Reports the current operating mode based on API key availability.
   */
  getMode(): EmbeddingMode {
    const key = getGeminiApiKey();
    return key && key.length >= 15 ? "gemini_online" : "deterministic_fallback";
  }

  /**
   * Embeds a single text snippet.
   */
  async embedText(text: string): Promise<number[]> {
    const batch = await this.embedBatch([text]);
    return batch[0] || this.generateDeterministicVector(text);
  }

  /**
   * Embeds multiple text snippets in a single batch.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!texts || texts.length === 0) {
      return [];
    }

    // Refresh model dynamically if SORA_EMBEDDING_MODEL was updated in process.env
    const activeModel = process.env.SORA_EMBEDDING_MODEL || this.config.model;
    const apiKey = getGeminiApiKey();

    if (apiKey && apiKey.length >= 15) {
      try {
        console.log(
          `[EmbeddingEngine] Mode: NEURAL_EMBEDDING — Generating neural embeddings via Gemini model '${activeModel}' for ${texts.length} item(s).`
        );
        return await this.embedWithGemini(texts, apiKey, activeModel);
      } catch (err: any) {
        console.warn(
          `[EmbeddingEngine] Mode: LEXICAL_FALLBACK — Gemini neural embedContent failed, falling back to deterministic lexical n-gram vectors: ${sanitizeError(
            err?.message || err
          )}`
        );
        // Fallback gracefully on any API error
        return texts.map((t) => this.generateDeterministicVector(t));
      }
    }

    // No API key configured / offline — use deterministic lexical vectors
    console.log(
      `[EmbeddingEngine] Mode: LEXICAL_FALLBACK — No valid Gemini API key active. Using deterministic lexical n-gram vectors (NOT neural embeddings) for ${texts.length} item(s).`
    );
    return texts.map((t) => this.generateDeterministicVector(t));
  }

  /**
   * Online embedding via Google Gemini Developer API with a 10-second timeout guard.
   */
  private async embedWithGemini(
    texts: string[],
    apiKey: string,
    modelName: string
  ): Promise<number[][]> {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "myraa-research-engine",
        },
      },
    });

    const results: number[][] = [];

    // Process items sequentially with a timeout guard
    for (const text of texts) {
      const truncated = text.substring(0, 4000); // Respect model context budget

      // 10-second timeout guard per chunk embedding call
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Gemini embedContent call timed out after 10000ms")), 10_000)
      );

      const embedPromise = ai.models.embedContent({
        model: modelName,
        contents: truncated,
        config: {
          outputDimensionality: this.config.outputDimensionality,
        },
      });

      const response = await Promise.race([embedPromise, timeoutPromise]);

      const resp = response as any;
      const values: number[] | undefined =
        resp.embeddings?.[0]?.values ||
        resp.embedding?.values ||
        (Array.isArray(resp.values) ? resp.values : undefined);

      if (values && Array.isArray(values) && values.length > 0) {
        results.push(EmbeddingEngine.l2Normalize(values));
      } else {
        // Fallback for empty response
        console.warn("[EmbeddingEngine] Gemini returned empty embedding values; using lexical vector fallback for chunk.");
        results.push(this.generateDeterministicVector(text));
      }
    }

    return results;
  }

  /**
   * Generates a deterministic normalized lexical n-gram projection vector.
   *
   * ========================================================================
   * LIMITATION: This is lexical character/word n-gram hashing, NOT true
   * semantic embedding. It is deterministic, fast, zero-dependency, and works offline.
   * ========================================================================
   */
  generateDeterministicVector(text: string): number[] {
    const dim = this.config.outputDimensionality;
    const vec = new Float64Array(dim);

    if (!text || text.trim().length === 0) {
      vec[0] = 1.0;
      return Array.from(vec);
    }

    const clean = text.toLowerCase().trim();

    // 1. Word token hashing with position decay
    const words = clean.split(/[^a-z0-9_]+/i).filter((w) => w.length > 1);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const h1 = EmbeddingEngine.hashString(w);
      const h2 = EmbeddingEngine.hashString(`${w}_alt`);

      const index = Math.abs(h1) % dim;
      const sign = (h2 & 1) === 0 ? 1 : -1;
      const weight = 1.0 / Math.sqrt(i + 1);

      vec[index] += sign * weight * 1.5;
    }

    // 2. Character 3-grams for subword and morphological matching
    for (let i = 0; i <= clean.length - 3; i++) {
      const trigram = clean.substring(i, i + 3);
      const h = EmbeddingEngine.hashString(trigram);
      const index = Math.abs(h) % dim;
      const sign = (h & 2) === 0 ? 1 : -1;
      vec[index] += sign * 0.4;
    }

    // 3. Character 4-grams for technical phrase / identifier matching
    for (let i = 0; i <= clean.length - 4; i++) {
      const quadgram = clean.substring(i, i + 4);
      const h = EmbeddingEngine.hashString(quadgram);
      const index = Math.abs(h) % dim;
      const sign = (h & 4) === 0 ? 1 : -1;
      vec[index] += sign * 0.3;
    }

    return EmbeddingEngine.l2Normalize(Array.from(vec));
  }

  /**
   * Computes Cosine Similarity between two L2-normalized vectors.
   * For normalized vectors, cosine similarity equals the dot product.
   */
  static cosineSimilarity(a: number[], b: number[]): number {
    if (!a || !b || a.length !== b.length || a.length === 0) {
      return 0;
    }
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
    }
    // Clamp to [-1, 1] for numerical stability
    return Math.max(-1, Math.min(1, dot));
  }

  /**
   * Normalizes a vector to unit length (L2 norm = 1).
   */
  static l2Normalize(vec: number[]): number[] {
    let sumSq = 0;
    for (let i = 0; i < vec.length; i++) {
      sumSq += vec[i] * vec[i];
    }
    const norm = Math.sqrt(sumSq);
    if (norm === 0) {
      const fallback = new Array(vec.length).fill(0);
      fallback[0] = 1.0;
      return fallback;
    }
    return vec.map((v) => v / norm);
  }

  /**
   * 32-bit FNV-1a hash function.
   */
  private static hashString(str: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash;
  }
}
