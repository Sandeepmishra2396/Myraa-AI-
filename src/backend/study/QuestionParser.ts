/**
 * MYRAA — QuestionParser (Phase 9 — AI Study Companion: Stage 1)
 *
 * Extracts and structures academic questions, MCQ options, and maps questions to answers:
 *   - Detects numbered question prefixes (Q1., Question 1:, Problem 1, 1., etc.)
 *   - Parses multiple choice options ((A), (B), (C), (D) or A., B., C., D.)
 *   - Rigorously checks for document-provided answer keys vs model-inferred answers:
 *     NEVER claims an answer is from the document unless an explicit solution/key exists.
 */

import {
  DetectedQuestion,
  QuestionOption,
  QuestionAnswerMapping,
} from "./StudyTypes.ts";

export class QuestionParser {
  /**
   * Parses page lines to detect academic questions and problem exercises.
   */
  static parsePageQuestions(lines: string[], pageNumber: number): DetectedQuestion[] {
    const questions: DetectedQuestion[] = [];
    if (!lines || lines.length === 0) return questions;

    // Common question start regex patterns
    // e.g. "Question 1:", "Q. 1", "Q1.", "Problem 1:", "1.", "1)"
    const qStartRegex = /^(?:(?:Q(?:uestion)?\.?\s*(\d+)|Problem\s*(\d+)|(\d+)[\.\)])\s*[:\.\-]?\s*)(.+)/i;
    
    // Explicit answer marker pattern
    // e.g. "Ans:", "Answer:", "Solution:", "Ans : (b)"
    const ansRegex = /^(?:Ans(?:wer)?|Solution|Key)\s*[:\.\-]\s*(.+)/i;

    let currentQ: {
      questionNumber: number;
      rawHeader: string;
      promptLines: string[];
      options: QuestionOption[];
      lineStart: number;
      lineEnd: number;
      marks?: number;
      documentAnswer?: string;
    } | null = null;

    const flushCurrentQuestion = () => {
      if (!currentQ || currentQ.promptLines.length === 0) return;

      const fullPrompt = currentQ.promptLines.join(" ").trim();
      const qId = `q-p${pageNumber}-${currentQ.questionNumber}`;

      // Build answer mapping strictly distinguishing document vs inferred
      let answerMapping: QuestionAnswerMapping;
      if (currentQ.documentAnswer) {
        answerMapping = {
          questionId: qId,
          source: "document",
          isDocumentProvided: true,
          documentAnswerText: currentQ.documentAnswer.trim(),
          confidence: 1.0,
          explanationNote: "Explicit answer found directly in study document.",
        };
      } else {
        answerMapping = {
          questionId: qId,
          source: "unanswered",
          isDocumentProvided: false,
          confidence: 0.0,
          explanationNote: "No answer key found in document. Explanation will be model-tutored.",
        };
      }

      questions.push({
        id: qId,
        pageNumber,
        questionNumber: currentQ.questionNumber,
        rawHeader: currentQ.rawHeader,
        prompt: fullPrompt,
        options: currentQ.options,
        isMultipleChoice: currentQ.options.length >= 2,
        marks: currentQ.marks,
        lineStart: currentQ.lineStart,
        lineEnd: currentQ.lineEnd,
        answerMapping,
      });

      currentQ = null;
    };

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx].trim();
      if (!line) continue;

      // Check if line marks a document-provided answer
      const ansMatch = line.match(ansRegex);
      if (ansMatch) {
        if (currentQ) {
          currentQ.documentAnswer = ansMatch[1].trim();
          currentQ.lineEnd = idx + 1;
        }
        continue;
      }

      // Check for new question start
      const qMatch = line.match(qStartRegex);
      if (qMatch) {
        // Flush previous question if one was in progress
        flushCurrentQuestion();

        const numStr = qMatch[1] || qMatch[2] || qMatch[3];
        const questionNumber = parseInt(numStr, 10) || questions.length + 1;
        const promptFirstLine = qMatch[4].trim();

        // Check if marks are specified in prompt line (e.g. "[3 marks]", "(5 Marks)")
        let marks: number | undefined;
        const marksMatch = promptFirstLine.match(/\[(\d+)\s*marks?\]|\((\d+)\s*marks?\)/i);
        if (marksMatch) {
          marks = parseInt(marksMatch[1] || marksMatch[2], 10);
        }

        currentQ = {
          questionNumber,
          rawHeader: line.slice(0, line.indexOf(promptFirstLine)).trim(),
          promptLines: [promptFirstLine],
          options: [],
          lineStart: idx + 1,
          lineEnd: idx + 1,
          marks,
        };

        // Check if options are inline on the first line (e.g. "(A) 10 (B) 20 (C) 30 (D) 40")
        const inlineOpts = QuestionParser._extractOptionsFromText(promptFirstLine);
        if (inlineOpts.length >= 2) {
          currentQ.options = inlineOpts;
        }
        continue;
      }

      // If we are inside an active question:
      if (currentQ) {
        // Check if this line is an MCQ option:
        // Pattern: "(A) ..." or "A. ..." or "(a) ..."
        const optLineMatch = line.match(/^(\([A-Da-d]\)|[A-Da-d][\.\)])\s*(.+)/);
        if (optLineMatch) {
          const key = optLineMatch[1].replace(/[\(\)\.]/g, "").toUpperCase();
          const text = optLineMatch[2].trim();
          currentQ.options.push({ key, text });
          currentQ.lineEnd = idx + 1;
          continue;
        }

        // Check if line contains multiple options side-by-side
        const multiOpts = QuestionParser._extractOptionsFromText(line);
        if (multiOpts.length >= 2) {
          currentQ.options.push(...multiOpts);
          currentQ.lineEnd = idx + 1;
          continue;
        }

        // Otherwise it's continuation of prompt text (unless it's a section header)
        if (!/^#{1,4}\s+|^Chapter\b|^Section\b/i.test(line)) {
          currentQ.promptLines.push(line);
          currentQ.lineEnd = idx + 1;
        } else {
          // Hit a section header: flush current question
          flushCurrentQuestion();
        }
      }
    }

    // Flush any remaining question
    flushCurrentQuestion();

    return questions;
  }

  /**
   * Helper to extract inline MCQ options like "(A) Apple (B) Banana (C) Cherry (D) Date"
   */
  private static _extractOptionsFromText(text: string): QuestionOption[] {
    const options: QuestionOption[] = [];
    const regex = /(?:\(([A-Da-d])\)|([A-Da-d])[\.\)])\s*([^\(\)]+?)(?=(?:\([A-Da-d]\)|[A-Da-d][\.\)]|$))/g;
    let m: RegExpExecArray | null;

    while ((m = regex.exec(text)) !== null) {
      const key = (m[1] || m[2]).toUpperCase();
      const optText = m[3].trim();
      if (optText) {
        options.push({ key, text: optText });
      }
    }

    return options;
  }

  /**
   * Map question to solution with strict attribution.
   * If answer was found in document, retains document source.
   * If model generates explanation, explicitly tags it as model_inferred.
   */
  static applyModelExplanation(
    question: DetectedQuestion,
    inferredExplanation: string,
  ): QuestionAnswerMapping {
    if (question.answerMapping?.isDocumentProvided) {
      // Document already has explicit answer!
      return {
        ...question.answerMapping,
        inferredAnswer: inferredExplanation,
        explanationNote: `Document answer: "${question.answerMapping.documentAnswerText}". Tutoring explanation provided for deeper understanding.`,
      };
    }

    // No document answer: strictly mark as model inferred
    return {
      questionId: question.id,
      source: "model_inferred",
      isDocumentProvided: false,
      inferredAnswer: inferredExplanation,
      confidence: 0.9,
      explanationNote: "Model-generated pedagogical solution (no explicit answer key in document).",
    };
  }
}
