/**
 * MYRAA — Phase 21: Predictive / Proactive Engine
 * ProactiveInsightAnalyzer
 *
 * Diagnoses root causes from extracted proactive evidence, computes confidence
 * (HIGH / MEDIUM / LOW), and formulates bilingual natural explanations.
 */

import type {
  ProactiveAnalysis,
  ProactiveConfidence,
  ProactiveEventType,
  ProactiveEvidence,
} from "./ProactiveTypes.ts";
import {
  HIGH_CONFIDENCE_THRESHOLD,
  LOW_CONFIDENCE_THRESHOLD,
} from "./ProactiveTypes.ts";

export class ProactiveInsightAnalyzer {
  /**
   * Analyzes proactive evidence and returns root cause, affected components,
   * natural language explanations, and confidence score.
   */
  public analyze(
    eventType: ProactiveEventType,
    evidence: ProactiveEvidence,
    project: string | null = null,
    file: string | null = null
  ): {
    analysis: ProactiveAnalysis;
    confidence: ProactiveConfidence;
    confidenceScore: number;
  } {
    const raw = evidence.rawOutput || "";
    const targetFile = evidence.filePath || file || "workspace";
    const affectedComponents: string[] = [];
    if (targetFile) affectedComponents.push(targetFile);
    if (project) affectedComponents.push(project);

    let summary = "";
    let rootCause = "";
    let likelyFix = "";
    let naturalEnglish = "";
    let naturalHindi = "";
    let confidenceScore = 0.85;

    switch (eventType) {
      case "TYPE_ERROR": {
        const code = evidence.errorCode || "TypeScript";
        const line = evidence.lineNumber ? `line ${evidence.lineNumber}` : "";
        if (code === "TS2304" || /Cannot find name/i.test(raw)) {
          const varMatch = raw.match(/Cannot find name ['"]([^'"]+)['"]/i);
          const varName = varMatch ? varMatch[1] : "identifier";
          summary = `TypeScript error ${code}: Cannot find name '${varName}'`;
          rootCause = `The identifier '${varName}' is referenced in ${targetFile} but has not been imported or declared.`;
          likelyFix = `Add the appropriate import statement or declare '${varName}' in ${targetFile}.`;
          naturalEnglish = `Sandeep, there is a TypeScript error in ${targetFile}${line ? ` at ${line}` : ""}. '${varName}' is not defined. I have identified the cause. Should I show you the issue and proposed fix?`;
          naturalHindi = `Sandeep, build mein ek TypeScript error hai. ${targetFile}${line ? ` ki ${line}` : ""} par '${varName}' declare ya import nahi hai. Main reason identify kar chuki hoon. Main tumhe issue aur possible fix dikhaun?`;
          confidenceScore = evidence.lineNumber ? 0.96 : 0.88;
        } else if (code === "TS2322" || /Type .* is not assignable to type/i.test(raw)) {
          summary = `TypeScript type mismatch ${code}`;
          rootCause = `Value assigned does not conform to the expected target type in ${targetFile}.`;
          likelyFix = `Update the type declaration or cast the value to match the expected interface in ${targetFile}.`;
          naturalEnglish = `Sandeep, there is a type mismatch in ${targetFile}${line ? ` at ${line}` : ""}. I know how to fix it. Would you like to review the proposed change?`;
          naturalHindi = `Sandeep, ${targetFile}${line ? ` ki ${line}` : ""} par TypeScript type mismatch hai. Maine possible fix tayyar kar liya hai. Dekhna chahte hain?`;
          confidenceScore = 0.95;
        } else {
          summary = `TypeScript compilation issue ${code}`;
          rootCause = `Compiler diagnostic in ${targetFile}: ${raw.slice(0, 80).trim()}`;
          likelyFix = `Inspect ${targetFile} diagnostics and correct compiler errors.`;
          naturalEnglish = `Sandeep, a TypeScript error occurred in ${targetFile}. I have identified the root cause. Would you like to inspect it?`;
          naturalHindi = `Sandeep, ${targetFile} mein TypeScript error mila hai. Main reason identify kar chuki hoon. Kya main issue aur fix dikhaun?`;
          confidenceScore = evidence.lineNumber ? 0.92 : 0.78;
        }
        break;
      }

      case "TEST_FAILED": {
        summary = `Test suite failed in ${targetFile}`;
        rootCause = `Assertions failed during test execution: ${raw.slice(0, 100).trim()}`;
        likelyFix = `Inspect the failing assertions in ${targetFile} and adjust implementation or test expectations.`;
        naturalEnglish = `Sandeep, unit tests failed in ${targetFile}. I have captured the failure stack. Would you like me to inspect and diagnose the failing tests?`;
        naturalHindi = `Sandeep, ${targetFile} ke tests fail ho gaye hain. Maine failure stack analyze kar liya hai. Kya main tests ko diagnose karun?`;
        confidenceScore = 0.94;
        break;
      }

      case "BUILD_FAILED": {
        summary = `Production build failed for ${project || targetFile}`;
        rootCause = `Build bundle compilation terminated with an error: ${raw.slice(0, 100).trim()}`;
        likelyFix = `Run compiler diagnostics or inspect the failing module bundle.`;
        naturalEnglish = `Sandeep, the project build failed. I have captured the build log and error cause. Would you like to review the fix?`;
        naturalHindi = `Sandeep, project ka build fail ho gaya hai. Main reason identify kar chuki hoon. Main tumhe issue aur possible fix dikhaun?`;
        confidenceScore = 0.92;
        break;
      }

      case "RUNTIME_ERROR": {
        const code = evidence.errorCode || "RuntimeError";
        if (code === "EADDRINUSE") {
          summary = "Port already in use (EADDRINUSE)";
          rootCause = "The local development server cannot bind to its target port because another process is occupying it.";
          likelyFix = "Terminate the lingering process occupying the port or switch to a fallback port.";
          naturalEnglish = "Sandeep, the development server port is already in use by another process. Would you like me to identify or free the port?";
          naturalHindi = "Sandeep, dev server ka port already kisi dusre process ke dwara use ho raha hai (EADDRINUSE). Kya main port free kar doon?";
          confidenceScore = 0.98;
        } else {
          summary = `Runtime exception: ${code}`;
          rootCause = `Uncaught runtime exception occurred: ${raw.slice(0, 100).trim()}`;
          likelyFix = `Inspect the callstack in ${targetFile} and apply null-guards or try/catch handling.`;
          naturalEnglish = `Sandeep, an uncaught runtime error (${code}) was observed. I have analyzed the callstack. Would you like me to inspect the source file?`;
          naturalHindi = `Sandeep, ek runtime error (${code}) detect hua hai. Maine stack trace analyze kar liya hai. Kya main source file inspect karun?`;
          confidenceScore = 0.9;
        }
        break;
      }

      case "TASK_STALLED": {
        summary = "Background task stalled";
        rootCause = "A long-running task is taking longer than expected with no progress updates.";
        likelyFix = "Inspect task process status, check for deadlock, or cancel and restart.";
        naturalEnglish = "Sandeep, an active background task appears stalled. Would you like me to inspect its status or cancel it?";
        naturalHindi = "Sandeep, ek background task kaafi der se bina kisi progress ke chal raha hai. Kya main task status check karun ya cancel kar doon?";
        confidenceScore = 0.85;
        break;
      }

      case "REPEATED_FAILURE": {
        summary = `Repeated failures detected (${targetFile})`;
        rootCause = `The same error has failed repeatedly across successive attempts.`;
        likelyFix = `Perform deep diagnostics and resolve root cause rather than re-running the same command.`;
        naturalEnglish = `Sandeep, this same error is failing repeatedly. The likely root cause is identified. Would you like a detailed diagnosis?`;
        naturalHindi = `Ye same error repeatedly aa raha hai. Root cause likely identify ho chuka hai. Main detailed analysis dikha sakti hoon.`;
        confidenceScore = 0.95;
        break;
      }

      case "PROJECT_WARNING": {
        summary = `Project warning: ${evidence.errorCode || "Configuration issue"}`;
        rootCause = `Potential environment or configuration issue observed: ${raw.slice(0, 80).trim()}`;
        likelyFix = `Verify environment variables and dependency integrity.`;
        naturalEnglish = `Sandeep, I noticed a project configuration warning. Would you like to review it?`;
        naturalHindi = `Sandeep, project configuration mein ek warning detect hui hai. Kya aap isko check karna chahte hain?`;
        confidenceScore = 0.75;
        break;
      }

      case "SAFE_SUGGESTION":
      default: {
        summary = `Proactive suggestion for ${targetFile}`;
        rootCause = "Contextual observation indicates an opportunity for workflow improvement or next step.";
        likelyFix = "Review suggestion and apply if appropriate.";
        naturalEnglish = `Sandeep, I have a quick suggestion for ${targetFile}. Would you like to check it?`;
        naturalHindi = `Sandeep, ${targetFile} ke liye ek useful suggestion hai. Kya aap dekhna chahte hain?`;
        // Heuristic signals have lower confidence
        confidenceScore = 0.55;
        break;
      }
    }

    // Determine confidence level category
    let confidence: ProactiveConfidence = "MEDIUM";
    if (confidenceScore >= HIGH_CONFIDENCE_THRESHOLD) {
      confidence = "HIGH";
    } else if (confidenceScore < LOW_CONFIDENCE_THRESHOLD) {
      confidence = "LOW";
    }

    const analysis: ProactiveAnalysis = {
      summary,
      rootCause,
      likelyFix,
      affectedComponents,
      naturalEnglishExplanation: naturalEnglish,
      naturalHindiExplanation: naturalHindi,
      corroboratingSignalsCount: 1,
    };

    return {
      analysis,
      confidence,
      confidenceScore,
    };
  }
}

export const proactiveInsightAnalyzer = new ProactiveInsightAnalyzer();
