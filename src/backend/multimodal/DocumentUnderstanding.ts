/**
 * MYRAA — DocumentUnderstanding (Phase 8)
 *
 * Secure document parsing, outline extraction, and architecture understanding:
 *   - WORKSPACE BOUNDARY ENFORCEMENT: Blocks directory traversal (..) and invalid paths.
 *   - FILE SIZE LIMITS: Rejects documents > 25MB (MAX_DOC_BYTES).
 *   - ZIP-BOMB PROTECTION: Rejects decompressed streams > 5MB (MAX_DECOMPRESSED_BYTES).
 *   - FORMAT SUPPORT: Stream-based PDF extraction, Markdown outline & specs, JSON/YAML schemas.
 *   - PROMPT INJECTION DEFENSE: Treats all document contents as untrusted external inputs.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  DocumentAnalysisResult,
  DocumentType,
  MAX_DOC_BYTES,
  MAX_DECOMPRESSED_BYTES,
} from "./MultimodalTypes.ts";
import { PdfExtractor } from "../knowledge/PdfExtractor.ts";
import { contentSanitizer } from "../security/ContentSanitizer.ts";

export class DocumentUnderstanding {
  private _workspaceRoot = process.cwd();

  setWorkspaceRoot(root: string): void {
    this._workspaceRoot = path.resolve(root);
  }

  getWorkspaceRoot(): string {
    return this._workspaceRoot;
  }

  // ---------------------------------------------------------------------------
  // Path Safety Validation
  // ---------------------------------------------------------------------------

  /**
   * Validates that the target path is inside the permitted workspace directory
   * and prevents directory traversal attacks.
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

    // Ensure resolved path starts with workspace root (or scratch / allowed directory)
    const normalizedRoot = path.normalize(this._workspaceRoot).toLowerCase();
    const normalizedTarget = path.normalize(resolved).toLowerCase();

    if (!normalizedTarget.startsWith(normalizedRoot)) {
      throw new Error(`PATH_TRAVERSAL_BLOCKED: Access to path '${targetPath}' outside workspace is prohibited.`);
    }

    return resolved;
  }

  // ---------------------------------------------------------------------------
  // Document Parsing Pipeline
  // ---------------------------------------------------------------------------

  /**
   * Analyzes and parses a document (PDF, Markdown, code, or config file).
   */
  async analyzeDocument(targetPath: string): Promise<DocumentAnalysisResult> {
    const resolvedPath = this.validatePath(targetPath);

    // Check file stats and enforce MAX_DOC_BYTES
    let stat;
    try {
      stat = await fs.stat(resolvedPath);
    } catch {
      throw new Error(`FILE_NOT_FOUND: Document '${targetPath}' does not exist.`);
    }

    if (stat.isDirectory()) {
      throw new Error(`INVALID_FILE: Path '${targetPath}' is a directory, not a document.`);
    }

    if (stat.size > MAX_DOC_BYTES) {
      throw new Error(
        `FILE_TOO_LARGE: Document size (${(stat.size / (1024 * 1024)).toFixed(1)}MB) exceeds maximum limit of 25MB.`
      );
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const buffer = await fs.readFile(resolvedPath);

    if (ext === ".pdf") {
      return this._parsePdf(resolvedPath, buffer);
    }

    if (ext === ".md" || ext === ".markdown" || ext === ".mdx") {
      return this._parseMarkdown(resolvedPath, buffer.toString("utf-8"));
    }

    // Default: Plain text / Code / JSON / YAML
    return this._parseTextDocument(resolvedPath, buffer.toString("utf-8"), ext);
  }

  // ---------------------------------------------------------------------------
  // Format Parsers
  // ---------------------------------------------------------------------------

  private _parsePdf(filePath: string, buffer: Buffer): DocumentAnalysisResult {
    // Check for decompression bomb limits
    let extracted;
    try {
      extracted = PdfExtractor.extractText(buffer, MAX_DECOMPRESSED_BYTES);
    } catch (err: any) {
      throw new Error(`PDF_EXTRACTION_FAILED: ${err?.message || err}`);
    }

    const title = path.basename(filePath, ".pdf");
    const headings: string[] = [];
    const outline: string[] = [];
    const actionItems: string[] = [];

    // Extract outline and headings from lines starting with numbered sections or uppercase
    const lines = extracted.text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^(?:\d+\.|\d+\.\d+|\bChapter\b|\bSection\b|\bTable of Contents\b)/i.test(trimmed)) {
        headings.push(trimmed);
        outline.push(trimmed);
      }
      if (/^\s*(?:TODO|Action Item|Deliverable):/i.test(trimmed)) {
        actionItems.push(trimmed);
      }
    }

    const sandbox = contentSanitizer.sanitizeDocumentContent(extracted.text, {
      filePath,
      title,
    });

    return {
      filePath,
      fileType: "pdf",
      title,
      headings,
      outline,
      codeBlocks: [],
      tables: [],
      actionItems,
      characterCount: extracted.characterCount,
      pageCount: extracted.pageCount,
      isUntrusted: true,
      fencedContent: sandbox.fencedText,
      injectionScan: {
        hasInjectionAttempt: sandbox.injectionScan.hasInjectionAttempt,
        score: sandbox.injectionScan.score,
        matchedPatterns: sandbox.injectionScan.matchedPatterns,
      },
    };
  }

  private _parseMarkdown(filePath: string, content: string): DocumentAnalysisResult {
    let title = path.basename(filePath);
    const headings: string[] = [];
    const outline: string[] = [];
    const codeBlocks: string[] = [];
    const tables: string[] = [];
    const actionItems: string[] = [];

    const lines = content.split("\n");
    let inCode = false;
    let currentCode: string[] = [];
    let inTable = false;
    let currentTable: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Code fences
      if (trimmed.startsWith("```")) {
        if (inCode) {
          codeBlocks.push(currentCode.join("\n"));
          currentCode = [];
          inCode = false;
        } else {
          inCode = true;
        }
        continue;
      }

      if (inCode) {
        currentCode.push(line);
        continue;
      }

      // Markdown Tables
      if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
        inTable = true;
        currentTable.push(trimmed);
        continue;
      } else if (inTable) {
        tables.push(currentTable.join("\n"));
        currentTable = [];
        inTable = false;
      }

      // Headings
      if (trimmed.startsWith("#")) {
        const headingText = trimmed.replace(/^#+\s*/, "").trim();
        if (trimmed.startsWith("# ") && title === path.basename(filePath)) {
          title = headingText;
        }
        headings.push(headingText);
        outline.push(trimmed);
      }

      // Task list / Action items
      if (/^[-*]\s*\[\s*[x ]?\s*\]/i.test(trimmed) || /\b(TODO|FIXME|ACTION):\b/i.test(trimmed)) {
        actionItems.push(trimmed);
      }
    }

    if (currentCode.length > 0) codeBlocks.push(currentCode.join("\n"));
    if (currentTable.length > 0) tables.push(currentTable.join("\n"));

    const sandbox = contentSanitizer.sanitizeDocumentContent(content, {
      filePath,
      title,
    });

    return {
      filePath,
      fileType: "markdown",
      title,
      headings,
      outline,
      codeBlocks,
      tables,
      actionItems,
      characterCount: content.length,
      isUntrusted: true,
      fencedContent: sandbox.fencedText,
      injectionScan: {
        hasInjectionAttempt: sandbox.injectionScan.hasInjectionAttempt,
        score: sandbox.injectionScan.score,
        matchedPatterns: sandbox.injectionScan.matchedPatterns,
      },
    };
  }

  private _parseTextDocument(filePath: string, content: string, ext: string): DocumentAnalysisResult {
    const title = path.basename(filePath);
    const headings: string[] = [];
    const actionItems: string[] = [];

    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (/\b(TODO|FIXME|ACTION|NOTE):\b/i.test(trimmed)) {
        actionItems.push(trimmed);
      }
    }

    let fileType: DocumentType = "unknown";
    if (/\.(ts|js|py|go|rs|cpp|c|java|json|yaml|yml|sql)$/i.test(ext)) {
      fileType = "code";
    }

    const sandbox = contentSanitizer.sanitizeDocumentContent(content, {
      filePath,
      title,
    });

    return {
      filePath,
      fileType,
      title,
      headings,
      outline: [],
      codeBlocks: fileType === "code" ? [content] : [],
      tables: [],
      actionItems,
      characterCount: content.length,
      isUntrusted: true,
      fencedContent: sandbox.fencedText,
      injectionScan: {
        hasInjectionAttempt: sandbox.injectionScan.hasInjectionAttempt,
        score: sandbox.injectionScan.score,
        matchedPatterns: sandbox.injectionScan.matchedPatterns,
      },
    };
  }
}

export const documentUnderstanding = new DocumentUnderstanding();
