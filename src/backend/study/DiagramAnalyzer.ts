/**
 * MYRAA — DiagramAnalyzer (Phase 9 — AI Study Companion: Stage 1)
 *
 * Detects diagrams, charts, schematics, and figures in study documents:
 *   - Detects textual figure references ("Figure 1.1", "Fig. 2", "Diagram", ASCII schematics)
 *   - Integrates with ScreenContextManager to incorporate actual visual page/figure context
 *   - Produces structured pedagogical explanations detailing diagram labels, axes, and takeaways
 */

import {
  DetectedDiagram,
  DiagramExplanation,
  DiagramCategory,
} from "./StudyTypes.ts";
import { screenContextManager } from "../multimodal/ScreenContextManager.ts";

export class DiagramAnalyzer {
  /**
   * Scans lines of a page to detect figure and diagram references with surrounding context.
   */
  static parsePageDiagrams(
    lines: string[],
    pageNumber: number,
    visualSnapshotBase64?: string,
  ): DetectedDiagram[] {
    const diagrams: DetectedDiagram[] = [];
    if (!lines || lines.length === 0) return diagrams;

    const figRegex = /^(?:(?:Figure|Fig\.?|Diagram|Chart|Schematic|Graph)\s*([0-9\.\-_A-Za-z]+)\s*[:\.\-]?\s*)(.*)/i;
    const asciiArrowRegex = /-->|==>|<-+|->+|\+---+|\|[\s\-]+\|/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const match = line.match(figRegex);
      const isAsciiDiagram = asciiArrowRegex.test(line) && !line.includes("git");

      if (match || isAsciiDiagram) {
        const figureIdNum = match ? match[1] : `${pageNumber}-${diagrams.length + 1}`;
        const figureLabel = match ? `Figure ${figureIdNum}` : `Diagram ${figureIdNum}`;
        const caption = match && match[2] ? match[2].trim() : line;

        // Collect surrounding context (3 lines above and 3 lines below)
        const contextStart = Math.max(0, i - 3);
        const contextEnd = Math.min(lines.length - 1, i + 3);
        const surroundingLines: string[] = [];
        for (let j = contextStart; j <= contextEnd; j++) {
          if (j !== i && lines[j].trim()) {
            surroundingLines.push(lines[j].trim());
          }
        }
        const surroundingContext = surroundingLines.join(" | ");

        // Determine diagram category from caption and context
        const category = DiagramAnalyzer._categorizeDiagram(caption, surroundingContext);

        // Extract visible visual components (labels, terms, entities mentioned in caption/context)
        const visualComponents = DiagramAnalyzer._extractComponents(caption, surroundingContext);

        diagrams.push({
          id: `diag-p${pageNumber}-${figureIdNum}`,
          pageNumber,
          figureLabel,
          caption,
          category,
          surroundingContext,
          hasVisualCapture: !!visualSnapshotBase64,
          visualFrameBase64: visualSnapshotBase64,
          visualComponents,
        });
      }
    }

    return diagrams;
  }

  /**
   * Generates a pedagogical explanation for a detected diagram,
   * utilizing live visual context from the screen if available.
   */
  static async explainDiagram(
    diagram: DetectedDiagram,
    forceVisualRefresh = false,
  ): Promise<DiagramExplanation> {
    let visualContextUsed = false;
    let visualOcrDetails = "";

    // Requirement 7: Use actual visual page/figure context, not only figure-caption text.
    // Query screen context if available
    try {
      let snapshot = diagram.visualFrameBase64
        ? null
        : screenContextManager.getLatestSnapshot();

      if (!snapshot && forceVisualRefresh) {
        snapshot = await screenContextManager.captureOnDemand(true);
      }

      if (snapshot && !snapshot.isRedacted && snapshot.ocrResult?.sanitizedText) {
        visualContextUsed = true;
        visualOcrDetails = snapshot.ocrResult.sanitizedText.slice(0, 400);
      }
    } catch {
      // Visual capture is optional/best-effort; fails safely
    }

    const conceptualTopic = DiagramAnalyzer._deriveTopic(diagram.caption, diagram.surroundingContext);
    const educationalTakeaway = DiagramAnalyzer._generateTakeaway(
      diagram.category,
      diagram.caption,
      conceptualTopic,
    );

    const componentBreakdown = diagram.visualComponents.map((comp) => ({
      component: comp,
      meaning: `Identifies ${comp} in the context of ${conceptualTopic}.`,
    }));

    if (visualContextUsed && visualOcrDetails) {
      componentBreakdown.push({
        component: "On-Screen Visual Text",
        meaning: `Visual elements observed on current screen: ${visualOcrDetails.slice(0, 150)}...`,
      });
    }

    const pedagogicalTip =
      `Notice how the ${diagram.category} connects the parts together. In exams, drawing this diagram with clear labels fetches full marks!`;

    return {
      diagramId: diagram.id,
      figureLabel: diagram.figureLabel,
      category: diagram.category,
      conceptualTopic,
      educationalTakeaway,
      componentBreakdown,
      visualContextUsed,
      pedagogicalTip,
    };
  }

  private static _categorizeDiagram(caption: string, context: string): DiagramCategory {
    const combined = `${caption} ${context}`.toLowerCase();
    if (/\b(flowchart|process flow|step 1|decision tree|flow|execution flow)\b|-->|==>|->/.test(combined)) return "flowchart";
    if (/\b(chart|bar graph|pie chart|histogram|frequency)\b/.test(combined)) return "chart";
    if (/\b(circuit|resistor|voltage|current|transistor|schematic|logic gate)\b/.test(combined)) return "schematic";
    if (/\b(triangle|circle|polygon|angle|hypotenuse|geometry|coordinate)\b/.test(combined)) return "geometric";
    if (/\b(cell|neuron|heart|brain|organ|tissue|anatomy)\b/.test(combined)) return "anatomical";
    if (/\b(plot|axis|x-axis|y-axis|curve|scatter|slope)\b/.test(combined)) return "data_plot";
    return "generic_illustration";
  }

  private static _extractComponents(caption: string, context: string): string[] {
    const components: string[] = [];
    const text = `${caption} ${context}`;

    // Extract capitalized terms or quoted terms
    const quotes = text.match(/["']([^"']+)["']/g);
    if (quotes) {
      for (const q of quotes) {
        const clean = q.replace(/["']/g, "").trim();
        if (clean.length > 2 && !components.includes(clean)) {
          components.push(clean);
        }
      }
    }

    // Extract bracketed terms like "[Start]", "[Sort Elements]"
    const bracketed = text.match(/\[([^\]]+)\]/g);
    if (bracketed) {
      for (const b of bracketed) {
        const clean = b.replace(/[\[\]]/g, "").trim();
        if (clean.length > 1 && !components.includes(clean)) {
          components.push(clean);
        }
      }
    }

    // Extract academic entities and domain keywords
    const entityMatches = text.match(
      /\b(?:circuit|resistor|galvanometer|capacitor|inductor|bridge|voltage|battery|diode|transistor|node|cell|axis|graph|table|block|input|output)\b/gi,
    );
    if (entityMatches) {
      for (const e of entityMatches) {
        const lower = e.toLowerCase();
        if (!components.includes(lower)) components.push(lower);
      }
    }

    // Extract labeled variables like "x-axis", "y-axis", "Node A", "Point P", "R1", "R2"
    const labels = text.match(/\b(?:x-axis|y-axis|point\s+[A-Z]|node\s+[A-Z]|layer\s+[0-9]+|[RVCIL]\d+)\b/gi);
    if (labels) {
      for (const l of labels) {
        if (!components.includes(l)) components.push(l);
      }
    }

    if (components.length === 0 && caption.length > 0) {
      components.push(caption.slice(0, 40));
    }

    return components;
  }

  private static _deriveTopic(caption: string, context: string): string {
    if (caption && caption.length > 3) return caption;
    if (context && context.length > 3) return context.slice(0, 60);
    return "Core Academic Concept";
  }

  private static _generateTakeaway(category: DiagramCategory, caption: string, topic: string): string {
    switch (category) {
      case "flowchart":
        return `Illustrates the sequential execution path and state transitions for ${topic}.`;
      case "schematic":
        return `Represents the schematic diagram of interconnected components, current/signal flow, and boundary conditions for ${topic}.`;
      case "data_plot":
      case "chart":
        return `Demonstrates the quantitative relationship, trend, and distribution of variables in ${topic}.`;
      case "geometric":
        return `Clarifies angular relationships, spatial symmetry, and geometric proofs for ${topic}.`;
      case "anatomical":
        return `Highlights structural morphology, localization, and functional zones in ${topic}.`;
      default:
        return `Visually reinforces the fundamental principles behind ${topic}.`;
    }
  }
}
