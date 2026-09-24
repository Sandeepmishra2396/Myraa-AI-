/**
 * MYRAA — StudyDocumentEngine (Phase 9 — AI Study Companion: Stage 1)
 *
 * Secure ingestion, page pagination, and question/diagram extraction for study documents:
 *   - Boundary validation (blocks path traversal, null bytes, out-of-workspace files)
 *   - File size ceiling (25MB) and zip-bomb decompression protection (5MB)
 *   - Multi-page extraction for PDFs, Markdown, and plain text
 *   - Automatic per-page parsing into StudyPage with questions, diagrams, and sections
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  StudyDocument,
  StudyPage,
  StudySection,
  StudyDocumentType,
  MAX_STUDY_DOC_BYTES,
  MAX_STUDY_DECOMPRESSED_BYTES,
  MAX_STUDY_PAGES,
  MAX_PAGE_TEXT_CHARS,
} from "./StudyTypes.ts";
import { QuestionParser } from "./QuestionParser.ts";
import { DiagramAnalyzer } from "./DiagramAnalyzer.ts";
import { PdfExtractor } from "../knowledge/PdfExtractor.ts";

export class StudyDocumentEngine {
  private _workspaceRoot = process.cwd();

  setWorkspaceRoot(root: string): void {
    this._workspaceRoot = path.resolve(root);
  }

  getWorkspaceRoot(): string {
    return this._workspaceRoot;
  }

  /**
   * Validates target document file path against directory traversal and null byte injection.
   */
  validatePath(targetPath: string): string {
    if (!targetPath || typeof targetPath !== "string") {
      throw new Error("INVALID_PATH: File path must be a non-empty string.");
    }

    if (targetPath.includes("\0")) {
      throw new Error("INVALID_PATH: Null byte injection detected.");
    }

    const resolved = path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(this._workspaceRoot, targetPath);

    const normalizedRoot = path.normalize(this._workspaceRoot).toLowerCase();
    const normalizedTarget = path.normalize(resolved).toLowerCase();

    if (!normalizedTarget.startsWith(normalizedRoot)) {
      throw new Error(
        `PATH_TRAVERSAL_BLOCKED: Access to path '${targetPath}' outside workspace is prohibited.`,
      );
    }

    return resolved;
  }

  /**
   * Loads and parses a study document from disk (PDF, Markdown, or text).
   */
  async loadDocument(targetPath: string): Promise<StudyDocument> {
    const resolvedPath = this.validatePath(targetPath);

    let stat;
    try {
      stat = await fs.stat(resolvedPath);
    } catch {
      throw new Error(`FILE_NOT_FOUND: Study document '${targetPath}' does not exist.`);
    }

    if (stat.isDirectory()) {
      throw new Error(`INVALID_FILE: Path '${targetPath}' is a directory, not a document.`);
    }

    if (stat.size > MAX_STUDY_DOC_BYTES) {
      throw new Error(
        `FILE_TOO_LARGE: Document size (${(stat.size / (1024 * 1024)).toFixed(1)}MB) exceeds maximum limit of 25MB.`,
      );
    }

    const buffer = await fs.readFile(resolvedPath);
    return this.loadDocumentFromBuffer(buffer, path.basename(resolvedPath), resolvedPath);
  }

  /**
   * Loads and parses a study document directly from an in-memory buffer (e.g. uploaded file).
   */
  async loadDocumentFromBuffer(
    buffer: Buffer,
    originalFilename: string,
    resolvedPath = originalFilename,
  ): Promise<StudyDocument> {
    if (!buffer || buffer.length === 0) {
      throw new Error("EMPTY_DOCUMENT: Document buffer is empty.");
    }

    if (buffer.length > MAX_STUDY_DOC_BYTES) {
      throw new Error(
        `FILE_TOO_LARGE: Document buffer size exceeds maximum limit of 25MB.`,
      );
    }

    const ext = path.extname(originalFilename).toLowerCase();
    const title = path.basename(originalFilename, ext);
    const docId = `doc-${crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 12)}`;

    let fileType: StudyDocumentType = "text";
    let rawPagesText: string[] = [];

    if (ext === ".pdf") {
      fileType = "pdf";
      rawPagesText = this._extractPdfPages(buffer);
    } else if (ext === ".md" || ext === ".markdown") {
      fileType = "markdown";
      rawPagesText = this._paginateText(buffer.toString("utf-8"), "markdown");
    } else {
      fileType = "text";
      rawPagesText = this._paginateText(buffer.toString("utf-8"), "text");
    }

    // Limit pages to MAX_STUDY_PAGES
    const pageCount = Math.min(rawPagesText.length, MAX_STUDY_PAGES);
    const pages: StudyPage[] = [];

    let totalQuestions = 0;
    let totalDiagrams = 0;
    let characterCount = 0;

    for (let pIdx = 0; pIdx < pageCount; pIdx++) {
      const pageNumber = pIdx + 1;
      let rawText = rawPagesText[pIdx] || "";
      if (rawText.length > MAX_PAGE_TEXT_CHARS) {
        rawText = rawText.slice(0, MAX_PAGE_TEXT_CHARS);
      }

      // Neutralize potential null bytes or escape chars
      const sanitizedText = rawText.replace(/\0/g, "").trim();
      const lines = sanitizedText.split(/\r?\n/);
      const sections = this._extractSections(lines, pageNumber);
      const questions = QuestionParser.parsePageQuestions(lines, pageNumber);
      const diagrams = DiagramAnalyzer.parsePageDiagrams(lines, pageNumber);

      totalQuestions += questions.length;
      totalDiagrams += diagrams.length;
      characterCount += sanitizedText.length;

      pages.push({
        pageNumber,
        text: rawText,
        sanitizedText,
        lines,
        sections,
        questions,
        diagrams,
        characterCount: sanitizedText.length,
        lineCount: lines.length,
      });
    }

    return {
      id: docId,
      title,
      filePath: resolvedPath,
      fileType,
      pageCount,
      pages,
      totalQuestions,
      totalDiagrams,
      characterCount,
      loadedAt: Date.now(),
      isUntrusted: true,
    };
  }

  /**
   * PDF page segmentation:
   * Uses stream-based extraction or splits text streams across pages.
   */
  private _extractPdfPages(buffer: Buffer): string[] {
    const extracted = PdfExtractor.extractText(buffer, MAX_STUDY_DECOMPRESSED_BYTES);
    const text = extracted.text;

    // Check if text has form-feed characters (\f) or page breaks
    if (text.includes("\f")) {
      const parts = text.split("\f").map((p) => p.trim()).filter(Boolean);
      if (parts.length > 0) return parts;
    }

    // Check for explicit "Page X of Y" or "Page X" markers
    const pageMarkerRegex = /(?:\n\s*---\s*Page\s+\d+\s*---\s*\n|\f)/i;
    if (pageMarkerRegex.test(text)) {
      const parts = text.split(pageMarkerRegex).map((p) => p.trim()).filter(Boolean);
      if (parts.length > 0) return parts;
    }

    // Fallback: Paginate into ~45 lines per page or ~2000 chars per page
    return this._paginateText(text, "text");
  }

  /**
   * Paginate Markdown or plain text into discrete study pages.
   */
  private _paginateText(content: string, type: "markdown" | "text"): string[] {
    if (!content.trim()) return [""];

    // Check for manual page breaks: \f, <!-- pagebreak -->, or === PAGE X ===
    const pageSplitRegex = /\f|<!--\s*pagebreak\s*-->|(?:\n\s*={3,}\s*Page\s+\d+\s*={3,}\s*\n)|(?:\n\s*-{3,}\s*Page\s+\d+\s*-{3,}\s*\n)/i;
    if (pageSplitRegex.test(content)) {
      const split = content.split(pageSplitRegex).map((s) => s.trim()).filter(Boolean);
      if (split.length > 0) return split;
    }

    const lines = content.split(/\r?\n/);
    const pages: string[] = [];
    const LINES_PER_PAGE = 45;

    let currentLines: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // In markdown, a level-1 heading (# Title) can trigger a new page if page has enough content
      if (type === "markdown" && line.startsWith("# ") && currentLines.length >= 20) {
        pages.push(currentLines.join("\n").trim());
        currentLines = [line];
        continue;
      }

      currentLines.push(line);
      if (currentLines.length >= LINES_PER_PAGE) {
        pages.push(currentLines.join("\n").trim());
        currentLines = [];
      }
    }

    if (currentLines.length > 0) {
      pages.push(currentLines.join("\n").trim());
    }

    return pages.length > 0 ? pages : [content];
  }

  /**
   * Extracts logical sections from lines of a page.
   */
  private _extractSections(lines: string[], pageNumber: number): StudySection[] {
    const sections: StudySection[] = [];
    let currentSec: {
      title: string;
      lineStart: number;
      lines: string[];
    } | null = null;

    const flush = (endIdx: number) => {
      if (!currentSec || currentSec.lines.length === 0) return;
      sections.push({
        id: `sec-p${pageNumber}-${sections.length + 1}`,
        title: currentSec.title,
        lineStart: currentSec.lineStart,
        lineEnd: endIdx,
        content: currentSec.lines.join("\n").trim(),
      });
      currentSec = null;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Heading detection: # Markdown headings or numbered chapter/section
      const isHeading =
        /^#{1,4}\s+(.+)/.test(trimmed) ||
        /^(?:Chapter|Section|Unit|Topic)\s+\d+[:\.\-]?\s*(.+)/i.test(trimmed);

      if (isHeading) {
        flush(i);
        const titleMatch =
          trimmed.match(/^#{1,4}\s+(.+)/) ||
          trimmed.match(/^(?:Chapter|Section|Unit|Topic)\s+\d+[:\.\-]?\s*(.+)/i);
        const title = titleMatch ? titleMatch[1].trim() : trimmed;

        currentSec = {
          title,
          lineStart: i + 1,
          lines: [],
        };
        continue;
      }

      if (currentSec) {
        currentSec.lines.push(line);
      } else {
        currentSec = {
          title: `Page ${pageNumber} Opening`,
          lineStart: i + 1,
          lines: [line],
        };
      }
    }

    flush(lines.length);
    return sections;
  }
}

export const studyDocumentEngine = new StudyDocumentEngine();
