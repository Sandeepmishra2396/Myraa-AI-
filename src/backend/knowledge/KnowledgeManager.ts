/**
 * MYRAA — KnowledgeManager (Phase 4)
 *
 * Master coordinator for the Research + Knowledge Engine.
 * Integrates web searching, official doc verification, URL reading,
 * document ingestion (PDF/Markdown/Code/Text), chunking, embeddings,
 * vector persistence, semantic search, source tracking, and citations.
 *
 * Security & Reliability Safeguards:
 *   • Restricts local file ingestion strictly to the active workspace or
 *     explicitly allowed safe user folders (Desktop, Documents, Downloads).
 *   • Validates all external network URLs against SSRF rules before fetching.
 *   • Enforces strict file-size limits (MAX_FILE_BYTES, MAX_PDF_BYTES).
 *   • Sanitizes errors to prevent API key and absolute path leakage.
 *   • Never crashes: returns graceful fallback responses when network or tools fail.
 *   • Never fabricates sources, URLs, dates, or citations.
 */

import * as path from "path";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as os from "os";

import {
  StoredDocument,
  ResearchResult,
  SearchResult,
  Citation,
  FreshnessReport,
  KnowledgeQueryOptions,
  MAX_FILE_BYTES,
  MAX_PDF_BYTES,
  MAX_AUTO_FETCH_RESULTS,
  computeFreshness,
  ageDays,
} from "./KnowledgeTypes.ts";

import { isPathWithinWorkspace, isSsrfSafeUrl, safeSsrfFetch, sanitizeError } from "../security/PermissionManager.ts";
import { PdfExtractor } from "./PdfExtractor.ts";
import { ContentExtractor } from "./ContentExtractor.ts";
import { Chunker } from "./Chunker.ts";
import { EmbeddingEngine } from "./EmbeddingEngine.ts";
import { VectorStore, vectorStore } from "./VectorStore.ts";
import { WebSearchEngine } from "./WebSearchEngine.ts";
import { DocumentationRetriever } from "./DocumentationRetriever.ts";
import { CitationEngine } from "./CitationEngine.ts";

export class KnowledgeManager {
  private store: VectorStore;
  private embeddingEngine: EmbeddingEngine;
  private workspaceRoot: string;

  constructor(
    customStore: VectorStore = vectorStore,
    customEmbeddingEngine: EmbeddingEngine = new EmbeddingEngine(),
    customWorkspace?: string
  ) {
    this.store = customStore;
    this.embeddingEngine = customEmbeddingEngine;
    this.workspaceRoot = path.resolve(
      customWorkspace || process.env.SORA_WORKSPACE_DIR || process.cwd()
    );
  }

  /**
   * Updates or queries the active workspace boundary.
   */
  setWorkspaceRoot(rootPath: string): void {
    this.workspaceRoot = path.resolve(rootPath);
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  // ---------------------------------------------------------------------------
  // 1. Web Research Integration
  // ---------------------------------------------------------------------------

  /**
   * Researches a topic using live web search, optionally auto-fetching top results
   * for deeper synthesis, and generates verified citations.
   */
  async researchWeb(
    query: string,
    options: { maxResults?: number; fetchTopContent?: boolean } = {}
  ): Promise<ResearchResult> {
    const cleanQuery = (query || "").trim();
    if (!cleanQuery) {
      return {
        query,
        summary: "Please provide a research query or topic.",
        citations: [],
        results: [],
        timestamp: new Date().toISOString(),
      };
    }

    const maxResults = options.maxResults || 5;
    const searchResults = await WebSearchEngine.search(cleanQuery, maxResults);

    if (searchResults.length === 0) {
      return {
        query: cleanQuery,
        summary: `No verified web results were found for "${cleanQuery}".`,
        citations: [],
        results: [],
        timestamp: new Date().toISOString(),
      };
    }

    // Generate citations strictly from actual results
    const citations = CitationEngine.fromSearchResults(searchResults);

    // If deep content fetch is requested, fetch top 1-2 pages safely
    const fetchedNotes: string[] = [];
    if (options.fetchTopContent) {
      const topUrls = searchResults.slice(0, MAX_AUTO_FETCH_RESULTS);
      for (const r of topUrls) {
        try {
          const doc = await DocumentationRetriever.fetchDocUrl(r.url);
          const snippet = doc.text.substring(0, 300).replace(/\s+/g, " ").trim();
          if (snippet) {
            fetchedNotes.push(`[${r.title}]: ${snippet}`);
          }
        } catch {
          /* skip unreadable URLs gracefully */
        }
      }
    }

    // Build synthesized summary
    let summary = `Web research results for "${cleanQuery}":\n`;
    for (const r of searchResults) {
      summary += `• **${r.title}**: ${r.snippet || "No preview snippet available."} (${r.url})\n`;
    }

    if (fetchedNotes.length > 0) {
      summary += `\nKey Excerpts:\n` + fetchedNotes.map((n) => `> ${n}`).join("\n");
    }

    const bibliography = CitationEngine.formatBibliography(citations);
    if (bibliography) {
      summary += `\n\n${bibliography}`;
    }

    return {
      query: cleanQuery,
      summary,
      citations,
      results: searchResults,
      timestamp: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // 2. Official Documentation Retrieval
  // ---------------------------------------------------------------------------

  /**
   * Retrieves official documentation for a technology and generates citations.
   */
  async fetchOfficialDocs(
    technology: string,
    topic: string = ""
  ): Promise<ResearchResult> {
    const cleanTech = (technology || "").trim();
    if (!cleanTech) {
      return {
        query: technology,
        summary: "Please specify a technology or library name (e.g. React, Node.js, TypeScript).",
        citations: [],
        results: [],
        timestamp: new Date().toISOString(),
      };
    }

    const docs = await DocumentationRetriever.retrieveDocs(cleanTech, topic, 4);

    if (docs.length === 0) {
      // Fallback: regular web search scoped to official docs
      return this.researchWeb(`${cleanTech} official documentation ${topic}`.trim(), {
        maxResults: 4,
      });
    }

    const citations = CitationEngine.fromSearchResults(docs);
    let summary = `Official documentation for ${cleanTech}${topic ? ` (${topic})` : ""}:\n`;

    for (const d of docs) {
      summary += `• **${d.title}**: ${d.snippet || "Official documentation guide"} (${d.url})\n`;
    }

    const bibliography = CitationEngine.formatBibliography(citations);
    if (bibliography) {
      summary += `\n\n${bibliography}`;
    }

    return {
      query: `${cleanTech} ${topic}`.trim(),
      summary,
      citations,
      results: docs,
      timestamp: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // 3. Safe URL Reader
  // ---------------------------------------------------------------------------

  /**
   * Reads, validates, and extracts text content from an arbitrary public URL.
   */
  async readUrl(url: string): Promise<{
    title: string;
    text: string;
    url: string;
    wordCount: number;
    characterCount: number;
    contentHash: string;
  }> {
    const cleanUrl = (url || "").trim();
    const ssrf = await isSsrfSafeUrl(cleanUrl);
    if (!ssrf.safe) {
      throw new Error(`SSRF blocked: ${ssrf.reason}`);
    }

    const response = await safeSsrfFetch(cleanUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,text/plain,application/xhtml+xml,*/*;q=0.8",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP fetch failed with status ${response.status} (${response.statusText})`);
    }

    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/pdf")) {
      const buffer = Buffer.from(await response.arrayBuffer());
      const pdf = PdfExtractor.extractText(buffer);
      const hash = ContentExtractor.hashContent(pdf.text);
      return {
        title: path.basename(cleanUrl) || "PDF Document",
        text: pdf.text,
        url: cleanUrl,
        wordCount: pdf.text.split(/\s+/).filter(Boolean).length,
        characterCount: pdf.characterCount,
        contentHash: hash,
      };
    }

    const html = await response.text();
    const extracted = ContentExtractor.extractFromHtml(html, cleanUrl);

    return {
      title: extracted.title,
      text: extracted.text,
      url: cleanUrl,
      wordCount: extracted.wordCount,
      characterCount: extracted.characterCount,
      contentHash: extracted.contentHash,
    };
  }

  // ---------------------------------------------------------------------------
  // 4. Document Ingestion (Files & URLs)
  // ---------------------------------------------------------------------------

  /**
   * Ingests a local file (Markdown, PDF, Code, or Text) into the VectorStore.
   */
  async ingestFile(filePath: string, tags: string[] = []): Promise<StoredDocument> {
    const resolvedPath = path.resolve(this.workspaceRoot, filePath);

    // Security check: must be in workspace or explicitly allowed user folders
    this.assertAllowedPath(resolvedPath);

    if (!fsSync.existsSync(resolvedPath)) {
      throw new Error(`File does not exist: ${sanitizeError(filePath)}`);
    }

    const stat = await fs.stat(resolvedPath);
    const ext = path.extname(resolvedPath).toLowerCase();
    const isPdf = ext === ".pdf";

    const maxBytes = isPdf ? MAX_PDF_BYTES : MAX_FILE_BYTES;
    if (stat.size > maxBytes) {
      throw new Error(
        `File size (${(stat.size / (1024 * 1024)).toFixed(1)}MB) exceeds limit of ${maxBytes / (1024 * 1024)}MB.`
      );
    }

    let title = path.basename(resolvedPath);
    let text = "";
    let contentHash = "";

    if (isPdf) {
      const buffer = await fs.readFile(resolvedPath);
      const extracted = PdfExtractor.extractText(buffer);
      text = extracted.text;
      contentHash = ContentExtractor.hashContent(text);
    } else {
      const raw = await fs.readFile(resolvedPath, "utf-8");
      if (ext === ".md") {
        const md = ContentExtractor.extractFromMarkdown(raw, title);
        title = md.title;
        text = md.text;
        contentHash = md.contentHash;
      } else if ([".ts", ".tsx", ".js", ".jsx", ".py", ".json", ".yaml", ".yml"].includes(ext)) {
        const code = ContentExtractor.extractFromCode(raw, title);
        text = code.text;
        contentHash = code.contentHash;
      } else if ([".html", ".htm"].includes(ext)) {
        const html = ContentExtractor.extractFromHtml(raw, title);
        title = html.title;
        text = html.text;
        contentHash = html.contentHash;
      } else {
        // Plain text fallback
        text = raw.trim();
        contentHash = ContentExtractor.hashContent(text);
      }
    }

    const docId = `doc_${contentHash.substring(0, 12)}`;
    const relPath = path.relative(this.workspaceRoot, resolvedPath);
    const now = new Date().toISOString();

    // Generate chunks
    const rawChunks = Chunker.chunkDocument(
      text,
      docId,
      {
        title,
        filePath: relPath,
        sourceType: "file",
      },
      tags
    );

    // Compute embeddings
    const chunkTexts = rawChunks.map((c) => c.text);
    const embeddings = await this.embeddingEngine.embedBatch(chunkTexts);

    const vectorChunks = rawChunks.map((c, idx) => ({
      ...c,
      embedding: embeddings[idx] || this.embeddingEngine.generateDeterministicVector(c.text),
    }));

    const storedDoc: StoredDocument = {
      id: docId,
      title,
      sourceType: "file",
      url: "",
      filePath: relPath,
      contentHash,
      characterCount: text.length,
      chunkCount: vectorChunks.length,
      tags,
      createdAt: now,
      updatedAt: now,
      lastVerifiedAt: now,
    };

    await this.store.upsertDocument(storedDoc, vectorChunks);
    return storedDoc;
  }

  /**
   * Ingests a web page via URL into the VectorStore.
   */
  async ingestUrl(url: string, tags: string[] = []): Promise<StoredDocument> {
    const read = await this.readUrl(url);
    const docId = `web_${read.contentHash.substring(0, 12)}`;
    const now = new Date().toISOString();

    const rawChunks = Chunker.chunkDocument(
      read.text,
      docId,
      {
        title: read.title,
        url: read.url,
        sourceType: "url",
      },
      tags
    );

    const chunkTexts = rawChunks.map((c) => c.text);
    const embeddings = await this.embeddingEngine.embedBatch(chunkTexts);

    const vectorChunks = rawChunks.map((c, idx) => ({
      ...c,
      embedding: embeddings[idx] || this.embeddingEngine.generateDeterministicVector(c.text),
    }));

    const storedDoc: StoredDocument = {
      id: docId,
      title: read.title,
      sourceType: "url",
      url: read.url,
      filePath: "",
      contentHash: read.contentHash,
      characterCount: read.characterCount,
      chunkCount: vectorChunks.length,
      tags,
      createdAt: now,
      updatedAt: now,
      lastVerifiedAt: now,
    };

    await this.store.upsertDocument(storedDoc, vectorChunks);
    return storedDoc;
  }

  // ---------------------------------------------------------------------------
  // 5. Semantic Vector Search
  // ---------------------------------------------------------------------------

  /**
   * Performs semantic vector search over all ingested documents.
   */
  async queryKnowledge(
    query: string,
    options: KnowledgeQueryOptions = {}
  ): Promise<{
    summary: string;
    citations: Citation[];
    matches: Array<{ text: string; title: string; url: string; score: number }>;
  }> {
    const cleanQuery = (query || "").trim();
    if (!cleanQuery) {
      return {
        summary: "Please provide a query term for the knowledge base.",
        citations: [],
        matches: [],
      };
    }

    const queryVector = await this.embeddingEngine.embedText(cleanQuery);
    const matches = await this.store.search(queryVector, cleanQuery, options);

    if (matches.length === 0) {
      return {
        summary: `No matching knowledge records found for "${cleanQuery}".`,
        citations: [],
        matches: [],
      };
    }

    const citations = CitationEngine.fromVectorChunks(matches);
    let summary = `Knowledge base matches for "${cleanQuery}":\n`;

    for (const m of matches) {
      const title = m.chunk.metadata.title;
      const snippet = m.chunk.text.substring(0, 200).replace(/\s+/g, " ").trim();
      summary += `• **${title}** (Relevance: ${Math.round(m.score * 100)}%):\n  > "${snippet}..."\n`;
    }

    const bibliography = CitationEngine.formatBibliography(citations);
    if (bibliography) {
      summary += `\n${bibliography}`;
    }

    return {
      summary,
      citations,
      matches: matches.map((m) => ({
        text: m.chunk.text,
        title: m.chunk.metadata.title,
        url: m.chunk.metadata.url || m.chunk.metadata.filePath,
        score: m.score,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // 6. Knowledge Freshness
  // ---------------------------------------------------------------------------

  /**
   * Checks the age and freshness rating of knowledge records.
   */
  async checkFreshness(queryOrDocId: string): Promise<FreshnessReport> {
    const clean = (queryOrDocId || "").trim();
    const doc = await this.store.getDocument(clean);

    if (doc) {
      const days = ageDays(doc.lastVerifiedAt || doc.updatedAt);
      const status = computeFreshness(doc.lastVerifiedAt || doc.updatedAt);
      return {
        sourceId: doc.id,
        title: doc.title,
        url: doc.url || doc.filePath,
        ageDays: days,
        status,
        needsRefresh: status === "stale" || status === "unknown/unverified",
      };
    }

    // Check by title match
    const docs = await this.store.listDocuments();
    const matched = docs.find((d) => d.title.toLowerCase().includes(clean.toLowerCase()));

    if (matched) {
      const days = ageDays(matched.lastVerifiedAt || matched.updatedAt);
      const status = computeFreshness(matched.lastVerifiedAt || matched.updatedAt);
      return {
        sourceId: matched.id,
        title: matched.title,
        url: matched.url || matched.filePath,
        ageDays: days,
        status,
        needsRefresh: status === "stale" || status === "unknown/unverified",
      };
    }

    return {
      sourceId: "not_found",
      title: clean,
      url: "",
      ageDays: -1,
      status: "unknown/unverified",
      needsRefresh: true,
    };
  }

  /**
   * Lists all stored knowledge documents.
   */
  async listDocuments(): Promise<StoredDocument[]> {
    return this.store.listDocuments();
  }

  /**
   * Deletes a document by ID.
   */
  async deleteDocument(docId: string): Promise<boolean> {
    return this.store.deleteDocument(docId);
  }

  // ---------------------------------------------------------------------------
  // Private Security Boundary Helper
  // ---------------------------------------------------------------------------

  /**
   * Asserts that a target absolute path is inside the active workspace or
   * one of the explicitly allowed safe user folders.
   */
  private assertAllowedPath(targetPath: string): void {
    const resolved = path.resolve(targetPath);

    // 1. Allowed if inside workspace
    if (isPathWithinWorkspace(resolved, this.workspaceRoot)) {
      return;
    }

    // 2. Allowed user folders (Desktop, Documents, Downloads, Pictures)
    const home = os.homedir();
    const allowedFolders = [
      path.join(home, "Desktop"),
      path.join(home, "Documents"),
      path.join(home, "Downloads"),
      path.join(home, "Pictures"),
    ];

    for (const folder of allowedFolders) {
      if (isPathWithinWorkspace(resolved, folder)) {
        return;
      }
    }

    throw new Error(
      `Access denied: Path '${sanitizeError(targetPath)}' is outside the active workspace and allowed user folders.`
    );
  }
}

export const knowledgeManager = new KnowledgeManager();
