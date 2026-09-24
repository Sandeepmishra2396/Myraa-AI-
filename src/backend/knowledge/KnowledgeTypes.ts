/**
 * MYRAA — KnowledgeTypes (Phase 4)
 *
 * Central type definitions for the Research + Knowledge Engine.
 * All other Phase 4 modules import from here; nothing in this file
 * imports from Phase 4 siblings (no circular dependencies).
 *
 * Safeguard notes:
 *   • PublicationDate is `string | "unknown/unverified"` — never fabricated.
 *   • Freshness computation is time-based only, derived from actual fetch timestamps.
 *   • Citations reference only confirmed sources from actual HTTP responses.
 */

// ---------------------------------------------------------------------------
// Source types
// ---------------------------------------------------------------------------

export type KnowledgeSourceType =
  | "web"          // fetched via live web search
  | "official_doc" // fetched from a known authoritative documentation hub
  | "file"         // local file ingested from workspace or allowed user folder
  | "url"          // arbitrary URL read explicitly by user/Myraa
  | "manual";      // manually provided text snippet

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

/** Age classification for knowledge freshness. */
export type FreshnessStatus = "fresh" | "recent" | "stale" | "unknown/unverified";

/**
 * Computes freshness status from a fetch/ingest timestamp.
 * Uses actual timestamp — never fabricated dates.
 */
export function computeFreshness(fetchedAt: string): FreshnessStatus {
  try {
    const timestamp = new Date(fetchedAt).getTime();
    if (Number.isNaN(timestamp)) {
      return "unknown/unverified";
    }
    const age = Date.now() - timestamp;
    const days = age / (1000 * 60 * 60 * 24);
    if (days < 7) return "fresh";
    if (days < 30) return "recent";
    return "stale";
  } catch {
    return "unknown/unverified";
  }
}

/**
 * Age in days from a fetch timestamp, or -1 if unknown.
 */
export function ageDays(fetchedAt: string): number {
  try {
    const timestamp = new Date(fetchedAt).getTime();
    if (Number.isNaN(timestamp)) {
      return -1;
    }
    const age = Date.now() - timestamp;
    return Math.floor(age / (1000 * 60 * 60 * 24));
  } catch {
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Stored document (after ingestion)
// ---------------------------------------------------------------------------

export interface StoredDocument {
  /** Unique document ID (random, stable). */
  id: string;
  /** Human-readable title. May be empty string — never fabricated. */
  title: string;
  /** How this document was sourced. */
  sourceType: KnowledgeSourceType;
  /** Public URL, or empty string for local files. */
  url: string;
  /**
   * Sanitised local file path (relative to workspace or allowed folder).
   * Empty for web/URL sources.
   */
  filePath: string;
  /** SHA-256 hex of the extracted text content. Used to detect stale copies. */
  contentHash: string;
  /** Character count of extracted text. */
  characterCount: number;
  /** Number of chunks generated. */
  chunkCount: number;
  /** Optional topic/technology tags (e.g. ["react", "authentication"]). */
  tags: string[];
  /** ISO 8601 timestamp of initial ingestion. */
  createdAt: string;
  /** ISO 8601 timestamp of most recent re-ingestion. */
  updatedAt: string;
  /** ISO 8601 timestamp of last SSRF-validated fetch. */
  lastVerifiedAt: string;
}

// ---------------------------------------------------------------------------
// Vector chunks
// ---------------------------------------------------------------------------

export interface ChunkMetadata {
  /** Document title (from StoredDocument). */
  title: string;
  /** Public URL of source document. Empty for local files. */
  url: string;
  /** Safe local path relative to workspace. Empty for web sources. */
  filePath: string;
  /** Source type from StoredDocument. */
  sourceType: KnowledgeSourceType;
  /** Character offset of chunk start in the full extracted text. */
  startChar: number;
  /** Character offset of chunk end in the full extracted text. */
  endChar: number;
  /** ISO 8601 timestamp of when this chunk was created/updated. */
  createdAt: string;
}

export interface VectorChunk {
  /** Deterministic ID: `${docId}_chk_${index}`. */
  id: string;
  /** Parent document ID. */
  docId: string;
  /** 0-based chunk index within the document. */
  chunkIndex: number;
  /** Total number of chunks in the document. */
  totalChunks: number;
  /** The raw text of this chunk (up to ~700 chars). */
  text: string;
  /**
   * Embedding vector.
   * When EmbeddingEngine is in Gemini online mode: true semantic embedding.
   * When in deterministic fallback mode: lexical character/word n-gram
   * projection (NOT true semantic embedding — documented limitation).
   */
  embedding: number[];
  /** Tags inherited from the parent StoredDocument. */
  tags: string[];
  /** Structural metadata for citation and result display. */
  metadata: ChunkMetadata;
}

// ---------------------------------------------------------------------------
// Search results from web and documentation retrieval
// ---------------------------------------------------------------------------

export interface SearchResult {
  /** Page title — from actual HTTP response, never fabricated. */
  title: string;
  /** Resolved destination URL (unwrapped from search engine redirects). */
  url: string;
  /** Text snippet from the search engine result — from actual response. */
  snippet: string;
  /**
   * Publication or indexing date string.
   * Set to "unknown/unverified" if not present in the search result.
   * Never fabricated.
   */
  publishedDate: string;
  /** Name of the data source (e.g. "DuckDuckGo", "react.dev"). */
  source: string;
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

export interface Citation {
  /** 1-based citation number for inline references [1], [2], etc. */
  index: number;
  /** Document or page title. Never fabricated. */
  title: string;
  /** Resolved destination URL. */
  url: string;
  /** Extracted text snippet used for the citation. */
  snippet: string;
  /** Cosine similarity score (0–1) from vector search. */
  score: number;
  /** ISO 8601 timestamp of when content was fetched. */
  fetchedAt: string;
  /** Freshness status derived strictly from fetchedAt timestamp. */
  freshness: FreshnessStatus;
}

// ---------------------------------------------------------------------------
// Research result returned to Gemini / ToolOrchestrator
// ---------------------------------------------------------------------------

export interface ResearchResult {
  /** The original query. */
  query: string;
  /** Synthesized summary text (safe to return to Gemini). */
  summary: string;
  /** Ranked citations. */
  citations: Citation[];
  /** Raw search engine results (title, url, snippet). */
  results: SearchResult[];
  /** ISO 8601 timestamp of the research session. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Freshness report
// ---------------------------------------------------------------------------

export interface FreshnessReport {
  /** Document ID from VectorStore, or "query_based" for topic queries. */
  sourceId: string;
  /** Document title. */
  title: string;
  /** Source URL. */
  url: string;
  /** Age in days since last fetch. -1 if unknown. */
  ageDays: number;
  /** Computed freshness classification. */
  status: FreshnessStatus;
  /** True when status is "stale" or "unknown/unverified". */
  needsRefresh: boolean;
}

// ---------------------------------------------------------------------------
// Official documentation hub definition
// ---------------------------------------------------------------------------

export interface DocumentationHub {
  /** Unique hub ID. */
  id: string;
  /** Human-readable name (e.g. "React", "Node.js"). */
  name: string;
  /** Authoritative domain(s) associated with this hub. */
  domains: string[];
  /** Base URL of the documentation root (used for search and fetch). */
  docRoot: string;
  /** Optional search URL template with `{query}` placeholder. */
  searchUrlTemplate?: string;
}

// ---------------------------------------------------------------------------
// Embedding engine configuration
// ---------------------------------------------------------------------------

/** Embedding mode — determined at runtime based on API key availability. */
export type EmbeddingMode = "gemini_online" | "deterministic_fallback";

export interface EmbeddingEngineConfig {
  /**
   * Gemini embedding model name.
   * Configurable via SORA_EMBEDDING_MODEL env var.
   * Defaults to "gemini-embedding-001". Also supports "gemini-embedding-2".
   */
  model: string;
  /** Output dimensionality. Default 256. */
  outputDimensionality: number;
}

// ---------------------------------------------------------------------------
// Chunker configuration
// ---------------------------------------------------------------------------

export interface ChunkerConfig {
  /** Target chunk size in characters. Default 600. */
  targetChunkSize: number;
  /** Overlap between adjacent chunks in characters. Default 100. */
  overlapSize: number;
  /** Minimum chunk size — chunks below this are merged with next. Default 80. */
  minChunkSize: number;
}

// ---------------------------------------------------------------------------
// Ingest options
// ---------------------------------------------------------------------------

export interface IngestOptions {
  /** Topic/technology tags to attach. */
  tags?: string[];
  /**
   * Force re-ingest even if content hash matches an existing stored document.
   * Default false.
   */
  forceRefresh?: boolean;
}

// ---------------------------------------------------------------------------
// Knowledge query options
// ---------------------------------------------------------------------------

export interface KnowledgeQueryOptions {
  /**
   * Maximum number of chunks to return.
   * Capped at 20 server-side.
   * Default 5.
   */
  limit?: number;
  /** Minimum cosine similarity threshold. Default 0.3. */
  minScore?: number;
  /** Filter by sourceType. */
  sourceTypes?: KnowledgeSourceType[];
  /** Filter by tags (any match). */
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Limits and safety caps (shared constants)
// ---------------------------------------------------------------------------

/** Maximum local file size for ingestion (10 MB). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Maximum PDF file size for ingestion (25 MB). */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;

/** Maximum decompressed text length after PDF/zlib extraction (5 MB). */
export const MAX_DECOMPRESSED_BYTES = 5 * 1024 * 1024;

/** Maximum number of DuckDuckGo search results to fetch and parse. */
export const MAX_SEARCH_RESULTS = 10;

/** Maximum number of web search results to auto-fetch body content for. */
export const MAX_AUTO_FETCH_RESULTS = 3;

/** HTTP fetch timeout in milliseconds for external URLs. */
export const FETCH_TIMEOUT_MS = 10_000;

/** Maximum response body size to read from external URLs (2 MB). */
export const MAX_RESPONSE_BODY_BYTES = 2 * 1024 * 1024;

/** Maximum chunks per document. */
export const MAX_CHUNKS_PER_DOC = 200;

/** Maximum query results from VectorStore per search. */
export const MAX_VECTOR_RESULTS = 20;
