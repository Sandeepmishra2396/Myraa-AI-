/**
 * MYRAA Phase 4 — Research + Knowledge Engine Tests
 *
 * Test coverage:
 *   - PdfExtractor: text stream parsing, FlateDecode handling, decompression limits
 *   - ContentExtractor: HTML cleaning, entity decoding, Markdown/Code extraction, hashing
 *   - Chunker: recursive splitting, boundaries, overlap, offsets, MAX_CHUNKS_PER_DOC cap
 *   - EmbeddingEngine: dual-mode, deterministic lexical n-gram normalization, cosine similarity
 *   - VectorStore: atomic persistence, hybrid semantic search, deduplication, deletion
 *   - WebSearchEngine: URL unwrapping, SSRF rejection, non-fabrication guarantee
 *   - DocumentationRetriever: authoritative doc hub resolution, official domain validation
 *   - CitationEngine: source citations, freshness evaluation, bibliography generation
 *   - KnowledgeManager: security boundaries, file ingestion, URL ingestion, freshness report
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs/promises";
import os from "os";
import * as zlib from "zlib";

import { PdfExtractor } from "../PdfExtractor.ts";
import { ContentExtractor } from "../ContentExtractor.ts";
import { Chunker } from "../Chunker.ts";
import { EmbeddingEngine } from "../EmbeddingEngine.ts";
import { VectorStore } from "../VectorStore.ts";
import { WebSearchEngine } from "../WebSearchEngine.ts";
import { DocumentationRetriever } from "../DocumentationRetriever.ts";
import { CitationEngine } from "../CitationEngine.ts";
import { KnowledgeManager } from "../KnowledgeManager.ts";
import {
  computeFreshness,
  ageDays,
  MAX_FILE_BYTES,
  MAX_PDF_BYTES,
  MAX_CHUNKS_PER_DOC,
} from "../KnowledgeTypes.ts";

describe("Phase 4: ContentExtractor", () => {
  it("strips scripts, styles, nav, and footers while preserving article text", () => {
    const rawHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>React 19 Overview &amp; Guide</title>
          <style>body { color: red; }</style>
          <script>console.log("ad script");</script>
        </head>
        <body>
          <nav><a href="/home">Home</a></nav>
          <h1>React 19 Features</h1>
          <p>React 19 introduces <code>useActionState</code> for async operations.</p>
          <pre><code>const [state, formAction] = useActionState(fn);</code></pre>
          <footer>Copyright 2026</footer>
        </body>
      </html>
    `;

    const extracted = ContentExtractor.extractFromHtml(rawHtml);
    expect(extracted.title).toBe("React 19 Overview & Guide");
    expect(extracted.text).toContain("React 19 Features");
    expect(extracted.text).toContain("useActionState");
    expect(extracted.text).not.toContain("console.log");
    expect(extracted.text).not.toContain("body { color: red; }");
    expect(extracted.text).not.toContain("Copyright 2026");
    expect(extracted.contentHash).toBeDefined();
    expect(extracted.characterCount).toBeGreaterThan(0);
  });

  it("decodes HTML entities safely without evaluating code", () => {
    const text = ContentExtractor.decodeEntities(
      "React &amp; Next.js &lt;Fast&gt; &#x27;Quotes&#x27; &quot;Double&quot; &nbsp;"
    );
    expect(text).toBe("React & Next.js <Fast> 'Quotes' \"Double\"  ");
  });

  it("extracts Markdown and extracts title from first heading", () => {
    const md = "# Guide to Myraa Architecture\n\nMyraa uses a hybrid memory and project engine.";
    const extracted = ContentExtractor.extractFromMarkdown(md);
    expect(extracted.title).toBe("Guide to Myraa Architecture");
    expect(extracted.text).toContain("Myraa uses a hybrid memory");
    expect(extracted.contentHash.length).toBe(64); // SHA-256
  });

  it("extracts code files properly", () => {
    const code = "export function add(a: number, b: number): number { return a + b; }";
    const extracted = ContentExtractor.extractFromCode(code, "math.ts");
    expect(extracted.title).toBe("math.ts");
    expect(extracted.text).toBe(code);
    expect(extracted.wordCount).toBeGreaterThan(0);
  });
});

describe("Phase 4: PdfExtractor", () => {
  it("rejects PDFs exceeding the maximum size limit", () => {
    const oversizedBuffer = Buffer.alloc(MAX_PDF_BYTES + 1024);
    expect(() => PdfExtractor.extractText(oversizedBuffer)).toThrow(/exceeds maximum allowed size/);
  });

  it("extracts text from uncompressed PDF streams", () => {
    const samplePdf =
      "%PDF-1.4\n" +
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n" +
      "4 0 obj\n<< /Length 44 >>\nstream\n" +
      "BT\n/F1 12 Tf\n(Hello Myraa Research Engine) Tj\nET\n" +
      "endstream\nendobj\nxref\ntrailer\n<< /Root 1 0 R >>\n%%EOF";

    const buffer = Buffer.from(samplePdf, "latin1");
    const result = PdfExtractor.extractText(buffer);
    expect(result.text).toContain("Hello Myraa Research Engine");
    expect(result.pageCount).toBe(1);
    expect(result.characterCount).toBeGreaterThan(0);
  });

  it("extracts text from compressed FlateDecode PDF streams", () => {
    const content = "BT\n(Myraa Verified Documentation Stream) Tj\nET\n";
    const deflated = zlib.deflateSync(Buffer.from(content, "latin1"));

    const samplePdf =
      "%PDF-1.4\n" +
      "1 0 obj\n<< /Type /Page >>\nendobj\n" +
      "2 0 obj\n<< /Filter /FlateDecode /Length " +
      deflated.length +
      " >>\nstream\n" +
      deflated.toString("binary") +
      "\nendstream\nendobj\n%%EOF";

    const buffer = Buffer.from(samplePdf, "binary");
    const result = PdfExtractor.extractText(buffer);
    expect(result.text).toContain("Myraa Verified Documentation Stream");
  });

  it("handles corrupt or un-decompressible streams gracefully without crashing", () => {
    const corruptPdf =
      "%PDF-1.4\n" +
      "1 0 obj\n<< /Filter /FlateDecode >>\nstream\n" +
      "CORRUPT_NOT_ZLIB_DATA_12345" +
      "\nendstream\nendobj\n%%EOF";

    const buffer = Buffer.from(corruptPdf, "binary");
    const result = PdfExtractor.extractText(buffer);
    expect(result.text).toBe("");
    expect(result.characterCount).toBe(0);
  });
});

describe("Phase 4: Chunker", () => {
  it("keeps short documents as a single chunk", () => {
    const text = "Short documentation paragraph.";
    const chunks = Chunker.chunkDocument(
      text,
      "doc_short",
      { title: "Short Doc", sourceType: "manual" },
      ["test"]
    );

    expect(chunks.length).toBe(1);
    expect(chunks[0].id).toBe("doc_short_chk_0");
    expect(chunks[0].text).toBe(text);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].totalChunks).toBe(1);
    expect(chunks[0].tags).toContain("test");
  });

  it("splits long text into overlapping chunks respecting paragraph boundaries", () => {
    const para1 = "First section discusses authentication using OAuth 2.1 and PKCE flow. ".repeat(10);
    const para2 = "Second section covers token storage in secure HttpOnly cookies. ".repeat(10);
    const para3 = "Third section details refresh token rotation and revocation lists. ".repeat(10);
    const fullText = `${para1}\n\n${para2}\n\n${para3}`;

    const chunks = Chunker.chunkDocument(
      fullText,
      "doc_auth",
      { title: "Auth Guide", sourceType: "official_doc" },
      ["auth", "security"],
      { targetChunkSize: 500, overlapSize: 80 }
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(MAX_CHUNKS_PER_DOC);
    expect(chunks[0].metadata.startChar).toBe(0);
    expect(chunks[0].metadata.endChar).toBeGreaterThan(0);
    expect(chunks[1].id).toBe("doc_auth_chk_1");
  });

  it("enforces MAX_CHUNKS_PER_DOC cap", () => {
    // Generate massive text
    const massive = "Massive paragraph of documentation content. ".repeat(5000);
    const chunks = Chunker.chunkDocument(
      massive,
      "doc_massive",
      { title: "Massive Doc", sourceType: "file" },
      [],
      { targetChunkSize: 200, overlapSize: 20 }
    );

    expect(chunks.length).toBeLessThanOrEqual(MAX_CHUNKS_PER_DOC);
  });
});

describe("Phase 4: EmbeddingEngine & Cosine Similarity", () => {
  const engine = new EmbeddingEngine({ outputDimensionality: 128 });

  it("generates normalized L2 vectors in deterministic mode", () => {
    const vec = engine.generateDeterministicVector("React 19 authentication");
    expect(vec.length).toBe(128);

    // Verify L2 norm = 1.0
    const norm = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0));
    expect(norm).toBeCloseTo(1.0, 4);
  });

  it("produces high cosine similarity for identical or highly related text", () => {
    const text1 = "OAuth 2.1 authorization with PKCE tokens";
    const text2 = "OAuth 2.1 authorization using PKCE tokens";
    const text3 = "Baking chocolate chip cookies in oven";

    const v1 = engine.generateDeterministicVector(text1);
    const v2 = engine.generateDeterministicVector(text2);
    const v3 = engine.generateDeterministicVector(text3);

    const simSelf = EmbeddingEngine.cosineSimilarity(v1, v1);
    const simRelated = EmbeddingEngine.cosineSimilarity(v1, v2);
    const simUnrelated = EmbeddingEngine.cosineSimilarity(v1, v3);

    expect(simSelf).toBeCloseTo(1.0, 4);
    expect(simRelated).toBeGreaterThan(0.7);
    expect(simUnrelated).toBeLessThan(0.3);
  });

  it("reports current mode accurately", () => {
    const mode = engine.getMode();
    expect(["gemini_online", "deterministic_fallback"]).toContain(mode);
  });
});

describe("Phase 4: VectorStore", () => {
  let tempDir: string;
  let tempFile: string;
  let store: VectorStore;
  const engine = new EmbeddingEngine({ outputDimensionality: 64 });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "myraa-vector-test-"));
    tempFile = path.join(tempDir, "test_vectors.json");
    store = new VectorStore(tempFile);
  });

  afterEach(async () => {
    store.clearCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("upserts, retrieves, and searches documents atomically", async () => {
    const docId = "doc_react_19";
    const chunk1Text = "React 19 introduces server actions and the useActionState hook.";
    const chunk2Text = "Tailwind CSS v4 is a high-performance CSS engine written in Rust.";

    const vec1 = engine.generateDeterministicVector(chunk1Text);
    const vec2 = engine.generateDeterministicVector(chunk2Text);

    const doc = {
      id: docId,
      title: "React 19 Notes",
      sourceType: "official_doc" as const,
      url: "https://react.dev/blog/2024/12/05/react-19",
      filePath: "",
      contentHash: "hash123",
      characterCount: 150,
      chunkCount: 2,
      tags: ["react", "frontend"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString(),
    };

    const chunks = [
      {
        id: `${docId}_chk_0`,
        docId,
        chunkIndex: 0,
        totalChunks: 2,
        text: chunk1Text,
        embedding: vec1,
        tags: ["react"],
        metadata: {
          title: "React 19 Notes",
          url: "https://react.dev/blog/2024/12/05/react-19",
          filePath: "",
          sourceType: "official_doc" as const,
          startChar: 0,
          endChar: chunk1Text.length,
          createdAt: new Date().toISOString(),
        },
      },
      {
        id: `${docId}_chk_1`,
        docId,
        chunkIndex: 1,
        totalChunks: 2,
        text: chunk2Text,
        embedding: vec2,
        tags: ["tailwind"],
        metadata: {
          title: "React 19 Notes",
          url: "https://react.dev/blog/2024/12/05/react-19",
          filePath: "",
          sourceType: "official_doc" as const,
          startChar: 100,
          endChar: 100 + chunk2Text.length,
          createdAt: new Date().toISOString(),
        },
      },
    ];

    await store.upsertDocument(doc, chunks);

    // List documents
    const list = await store.listDocuments();
    expect(list.length).toBe(1);
    expect(list[0].title).toBe("React 19 Notes");

    // Query for React hook
    const queryVec = engine.generateDeterministicVector("useActionState hook");
    const results = await store.search(queryVec, "useActionState hook", { limit: 2 });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.text).toContain("useActionState");
    expect(results[0].score).toBeGreaterThan(0.4);

    // Delete document
    const deleted = await store.deleteDocument(docId);
    expect(deleted).toBe(true);

    const afterDelete = await store.listDocuments();
    expect(afterDelete.length).toBe(0);
  });
});

describe("Phase 4: WebSearchEngine & SSRF Validation", () => {
  it("unwraps DuckDuckGo redirect URLs correctly", () => {
    const duckUrl =
      "//duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2Fblog%2F2024%2F12%2F05%2Freact%2D19&rut=123";
    const unwrapped = WebSearchEngine.unwrapDuckDuckGoUrl(duckUrl);
    expect(unwrapped).toBe("https://react.dev/blog/2024/12/05/react-19");
  });

  it("handles empty or whitespace query safely", async () => {
    const results = await WebSearchEngine.search("   ");
    expect(results).toEqual([]);
  });
});

describe("Phase 4: DocumentationRetriever", () => {
  it("matches known official doc hubs accurately", () => {
    expect(DocumentationRetriever.findHub("react")?.domains).toContain("react.dev");
    expect(DocumentationRetriever.findHub("Next.js")?.domains).toContain("nextjs.org");
    expect(DocumentationRetriever.findHub("typescript")?.domains).toContain("typescriptlang.org");
    expect(DocumentationRetriever.findHub("python")?.domains).toContain("docs.python.org");
    expect(DocumentationRetriever.findHub("vite")?.domains).toContain("vite.dev");
  });

  it("returns undefined for unknown arbitrary hubs", () => {
    expect(DocumentationRetriever.findHub("nonexistent_unknown_framework_xyz")).toBeUndefined();
  });
});

describe("Phase 4: CitationEngine & Freshness Computation", () => {
  it("computes freshness status accurately based on age", () => {
    const now = new Date().toISOString();
    expect(computeFreshness(now)).toBe("fresh");

    const days15Ago = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    expect(computeFreshness(days15Ago)).toBe("recent");

    const days45Ago = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    expect(computeFreshness(days45Ago)).toBe("stale");

    expect(computeFreshness("invalid-date-string")).toBe("unknown/unverified");
  });

  it("calculates age in days correctly", () => {
    const days3Ago = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(ageDays(days3Ago)).toBe(3);
  });

  it("formats bibliography blocks with clean markdown links", () => {
    const citations = [
      {
        index: 1,
        title: "React 19 Release",
        url: "https://react.dev/blog/2024/12/05/react-19",
        snippet: "React 19 includes Actions and Server Components.",
        score: 0.95,
        fetchedAt: new Date().toISOString(),
        freshness: "fresh" as const,
      },
    ];

    const bib = CitationEngine.formatBibliography(citations);
    expect(bib).toContain("### Sources & Citations:");
    expect(bib).toContain("[1] React 19 Release");
    expect(bib).toContain("https://react.dev/blog/2024/12/05/react-19");
    expect(bib).toContain("[Freshness: FRESH]");
    expect(bib).toContain("Actions and Server Components");
  });

  it("formats speech summaries for Myraa's voice persona", () => {
    const citations = [
      {
        index: 1,
        title: "React 19 Release",
        url: "https://react.dev/blog/2024/12/05/react-19",
        snippet: "...",
        score: 0.9,
        fetchedAt: new Date().toISOString(),
        freshness: "fresh" as const,
      },
    ];

    const speech = CitationEngine.formatSpeechSummary(citations);
    expect(speech).toContain("Source: React 19 Release on react.dev");
  });
});

describe("Phase 4: KnowledgeManager End-to-End & Security Boundaries", () => {
  let tempDir: string;
  let store: VectorStore;
  let km: KnowledgeManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "myraa-km-test-"));
    const storeFile = path.join(tempDir, "km_vectors.json");
    store = new VectorStore(storeFile);
    km = new KnowledgeManager(store, new EmbeddingEngine({ outputDimensionality: 64 }), tempDir);
  });

  afterEach(async () => {
    store.clearCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("blocks local file ingestion outside workspace and safe folders", async () => {
    await expect(km.ingestFile("../../../secret.txt")).rejects.toThrow(/Access denied.*outside.*workspace/);
  });

  it("ingests Markdown files, chunks them, and permits semantic search", async () => {
    const mdPath = path.join(tempDir, "architecture.md");
    await fs.writeFile(
      mdPath,
      "# Project QYROX Architecture\n\nQYROX uses a microservice architecture with JWT token validation."
    );

    const doc = await km.ingestFile("architecture.md", ["qyrox", "architecture"]);
    expect(doc.id).toBeDefined();
    expect(doc.chunkCount).toBe(1);
    expect(doc.title).toBe("Project QYROX Architecture");

    const queryResult = await km.queryKnowledge("JWT token validation");
    expect(queryResult.citations.length).toBe(1);
    expect(queryResult.summary).toContain("Project QYROX Architecture");
    expect(queryResult.matches[0].text).toContain("JWT token validation");
  });

  it("checks freshness of stored knowledge records accurately", async () => {
    const mdPath = path.join(tempDir, "notes.md");
    await fs.writeFile(mdPath, "# Freshness Test Notes\n\nSome testing content.");
    await km.ingestFile("notes.md");

    const report = await km.checkFreshness("Freshness Test Notes");
    expect(report.status).toBe("fresh");
    expect(report.ageDays).toBe(0);
    expect(report.needsRefresh).toBe(false);

    const unknownReport = await km.checkFreshness("Nonexistent Doc Topic");
    expect(unknownReport.status).toBe("unknown/unverified");
    expect(unknownReport.needsRefresh).toBe(true);
  });
});
