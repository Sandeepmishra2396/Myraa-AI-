/**
 * MYRAA — PdfExtractor (Phase 4)
 *
 * Native stream-based PDF text extractor for Node.js.
 * Requires ZERO native bindings or third-party binary tools.
 *
 * Security & Reliability Safeguards:
 *   • Enforces MAX_PDF_BYTES input limit (25MB).
 *   • Enforces MAX_DECOMPRESSED_BYTES total decompressed payload limit (5MB)
 *     to prevent compression bomb (zip-bomb) attacks.
 *   • Decompression failures in individual streams are handled gracefully
 *     without crashing the process.
 *   • Handles /Filter /FlateDecode streams using native zlib.inflateSync.
 *   • Extracts PDF text operators: Tj, TJ, ' and " operators.
 *   • Decodes octal escapes (\ddd) and standard PDF escapes (\(, \), \\, \n, \r, \t).
 */

import * as zlib from "zlib";
import {
  MAX_PDF_BYTES,
  MAX_DECOMPRESSED_BYTES,
} from "./KnowledgeTypes.ts";

export interface PdfExtractResult {
  text: string;
  pageCount: number;
  characterCount: number;
  truncated: boolean;
}

export class PdfExtractor {
  /**
   * Extracts clean text content from a PDF Buffer.
   *
   * @param buffer Raw PDF file buffer
   * @param maxChars Optional limit on extracted characters (default 500,000)
   */
  static extractText(buffer: Buffer, maxChars: number = 500_000): PdfExtractResult {
    if (!buffer || buffer.length === 0) {
      return { text: "", pageCount: 0, characterCount: 0, truncated: false };
    }

    if (buffer.length > MAX_PDF_BYTES) {
      throw new Error(
        `PDF exceeds maximum allowed size of ${MAX_PDF_BYTES / (1024 * 1024)}MB (actual: ${(buffer.length / (1024 * 1024)).toFixed(1)}MB).`
      );
    }

    const pdfString = buffer.toString("binary");

    // Estimate page count via /Type /Page occurrences (ignoring /Pages catalog)
    const pageMatches = pdfString.match(/\/Type\s*\/Page\b(?!\s*s)/g);
    const estimatedPages = pageMatches ? pageMatches.length : 1;

    let totalDecompressedBytes = 0;
    const extractedTextParts: string[] = [];

    // Find all stream ... endstream blocks
    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let streamMatch: RegExpExecArray | null;

    while ((streamMatch = streamRegex.exec(pdfString)) !== null) {
      const streamStart = streamMatch.index + streamMatch[0].indexOf(streamMatch[1]);
      const rawStream = buffer.subarray(streamStart, streamStart + streamMatch[1].length);

      // Check preceding dictionary to see if FlateDecode is applied
      const dictSearchWindow = pdfString.substring(Math.max(0, streamMatch.index - 500), streamMatch.index);
      const isFlate = /\/Filter\s*(\/FlateDecode|\[\s*\/FlateDecode\s*\])/i.test(dictSearchWindow);

      let decodedBytes: Buffer;

      if (isFlate) {
        try {
          decodedBytes = zlib.inflateSync(rawStream);
        } catch {
          // If raw inflate fails, attempt raw inflate (without zlib header)
          try {
            decodedBytes = zlib.inflateRawSync(rawStream);
          } catch {
            // Ignore un-decompressible streams (e.g. image data or encrypted streams)
            continue;
          }
        }
      } else {
        decodedBytes = rawStream;
      }

      totalDecompressedBytes += decodedBytes.length;
      if (totalDecompressedBytes > MAX_DECOMPRESSED_BYTES) {
        // Stop extracting further to prevent decompression bomb
        break;
      }

      const streamContent = decodedBytes.toString("latin1");
      const text = PdfExtractor.extractTextFromStream(streamContent);
      if (text.trim().length > 0) {
        extractedTextParts.push(text.trim());
      }

      const currentTotalChars = extractedTextParts.reduce((sum, p) => sum + p.length, 0);
      if (currentTotalChars >= maxChars) {
        break;
      }
    }

    let fullText = extractedTextParts.join("\n\n");
    let truncated = false;

    if (fullText.length > maxChars) {
      fullText = fullText.substring(0, maxChars);
      truncated = true;
    }

    // Post-process to normalize whitespace while preserving paragraphs
    fullText = fullText
      .replace(/[ \t]+/g, " ")
      .replace(/(\r?\n){3,}/g, "\n\n")
      .trim();

    return {
      text: fullText,
      pageCount: Math.max(1, estimatedPages),
      characterCount: fullText.length,
      truncated,
    };
  }

  /**
   * Extracts text strings from PDF content stream instructions (BT ... ET blocks).
   */
  private static extractTextFromStream(stream: string): string {
    const textPieces: string[] = [];

    // Match all BT (begin text) ... ET (end text) blocks
    const btRegex = /BT\s+([\s\S]*?)\s+ET/g;
    let btMatch: RegExpExecArray | null;

    while ((btMatch = btRegex.exec(stream)) !== null) {
      const block = btMatch[1];

      // Extract string operands:
      // 1. (text) Tj
      // 2. [(t)(e)(x)(t)] TJ
      // 3. ' or " string operations
      const opRegex = /(?:\(([\s\S]*?)\)\s*Tj|\[([\s\S]*?)\]\s*TJ|'([\s\S]*?)'|"([\s\S]*?)")/g;
      let opMatch: RegExpExecArray | null;

      while ((opMatch = opRegex.exec(block)) !== null) {
        if (opMatch[1] !== undefined) {
          // (text) Tj
          textPieces.push(PdfExtractor.decodePdfString(opMatch[1]));
        } else if (opMatch[2] !== undefined) {
          // Array of strings and kerning offsets: [(string) -10 (another)] TJ
          const arrayContent = opMatch[2];
          const innerStrings = arrayContent.match(/\(([\s\S]*?)\)/g);
          if (innerStrings) {
            const combined = innerStrings
              .map((s) => PdfExtractor.decodePdfString(s.slice(1, -1)))
              .join("");
            textPieces.push(combined);
          }
        } else if (opMatch[3] !== undefined) {
          textPieces.push(PdfExtractor.decodePdfString(opMatch[3]));
        } else if (opMatch[4] !== undefined) {
          textPieces.push(PdfExtractor.decodePdfString(opMatch[4]));
        }
      }
      textPieces.push("\n");
    }

    return textPieces.join(" ").replace(/ \n /g, "\n");
  }

  /**
   * Decodes escaped characters in PDF literal string format.
   */
  private static decodePdfString(raw: string): string {
    return raw
      .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)))
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\b/g, "\b")
      .replace(/\\f/g, "\f")
      .replace(/\\\(/g, "(")
      .replace(/\\\)/g, ")")
      .replace(/\\\\/g, "\\");
  }
}
