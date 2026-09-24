import fs from "fs/promises";
import { GoogleGenAI, Type } from "@google/genai";
import { Memory, MemoryTransaction, MemoryCategory } from "./src/lib/memoryTypes.ts";
import { dataFile } from "./server_paths.ts";

const MEMORY_FILE = dataFile("memories.json");

// Safe file operations with fallback
export async function loadMemories(): Promise<Memory[]> {
  try {
    let data = await fs.readFile(MEMORY_FILE, "utf-8");
    if (!data || !data.trim()) {
      return [];
    }
    // Strip UTF-8 BOM (\uFEFF) if present
    data = data.replace(/^\uFEFF/, "").trim();
    if (!data) return [];
    return JSON.parse(data) as Memory[];
  } catch (error: any) {
    // If file doesn't exist, return empty array
    if (error.code === "ENOENT") {
      return [];
    }
    console.error("[Memory] Error loading memories, returning fallback:", error);
    return [];
  }
}

export async function saveMemories(memories: Memory[]): Promise<void> {
  try {
    await fs.writeFile(MEMORY_FILE, JSON.stringify(memories, null, 2), "utf-8");
    console.log(`[Memory] Saved ${memories.length} memories successfully.`);
  } catch (error) {
    console.error("[Memory] Error writing memory file:", error);
  }
}

// ---------------------------------------------------------------------------
// Context formatting — renders the memory block injected into system prompt.
// Phase 2: uses importance/confidence/status from EnhancedMemory if present;
// falls back gracefully for old Phase 1 records.
// ---------------------------------------------------------------------------
export function formatSystemInstructionsWithMemories(baseInstruction: string, memories: Memory[]): string {
  if (memories.length === 0) {
    return baseInstruction + 
      "\n\n" +
      "=== MYRAA MEMORY CORE ===\n" +
      "You do not possess any historic recollections of this companion yet. " +
      "As you speak, pay deep attention to who they are, their projects, relationships, and habits so you naturally grow closer over time.\n" +
      "=========================\n";
  }

  // Filter out archived and expired memories (Phase 2 fields, graceful for Phase 1)
  const activeMemories = memories.filter((m) => {
    const em = m as any;
    if (em.status === "archived") return false;
    if (em.expiresAt && new Date(em.expiresAt) < new Date()) return false;
    return true;
  });

  if (activeMemories.length === 0) {
    return baseInstruction +
      "\n\n=== MYRAA MEMORY CORE ===\n" +
      "All stored memories have been archived or expired.\n" +
      "=========================\n";
  }

  // Group by category
  const grouped: Record<string, string[]> = {};
  activeMemories.forEach((m) => {
    const em = m as any;
    const flag = em.status === "needs_revalidation" ? " [needs review]" : "";
    grouped[m.category] = grouped[m.category] || [];
    grouped[m.category].push(m.text + flag);
  });

  let memoryBlock = 
    "\n\n" +
    "=== MYRAA PERSISTENT MEMORY CORE (RECOLLECTIONS) ===\n" +
    "You have spoken with this user for a long duration. Below are your persistent recollections of who they are.\n" +
    "CRITICAL BRAND AND COGNITIVE PRINCIPLES:\n" +
    "- INTEGRATE MEMORIES INSTINCTIVELY: Always make conversational references feel completely smooth, natural, and human. NEVER say 'According to my memory files...', 'My recollection database indicates...', or 'As you told me on June 12th...'. Instead, speak of these details casually and supportively as a true friend would (e.g. 'Oh, since you're working on that website project...', 'I hope you're keeping up with your YouTube channel goals too!').\n" +
    "- COMPANIONSHIP DEPTH: Allow your witty and responsive personality to adapt with empathy, based on their goals, life events, emotional milestones, and preferences.\n" +
    "- Memories marked [needs review] should be used cautiously — treat them as uncertain.\n\n" +
    "CURRENT PERSISTENT KNOWLEDGE CARD:\n";

  const categoriesOrdered = [
    { key: "identity",     label: "Identity (Name, nick, profession, background)" },
    { key: "preference",   label: "Preferences & Tastes (Likes, dislikes, games, movies)" },
    { key: "skill",        label: "Skills & Expertise" },
    { key: "goal",         label: "Active Goals & Aspirations" },
    { key: "project",      label: "Ongoing Projects & Ecosystems" },
    { key: "task",         label: "Current Tasks & To-Dos" },
    { key: "decision",     label: "Important Decisions Made" },
    { key: "relationship", label: "Key People & Relationships mentioned" },
    { key: "emotional",    label: "Emotional Highlights & Core Milestones" },
    { key: "behavior",     label: "Observed Traits & Behavioral Tendencies" },
    { key: "fact",         label: "General Facts & Knowledge" },
  ];

  categoriesOrdered.forEach((cat) => {
    const list = grouped[cat.key] || [];
    if (list.length > 0) {
      memoryBlock += `* ${cat.label}:\n` + list.map(t => `  - ${t}`).join("\n") + "\n";
    }
  });

  memoryBlock += "====================================================\n";

  return baseInstruction + memoryBlock;
}

// Background memory consolidation queue lock
let isConsolidating = false;

export async function processConversationSlice(
  apiKey: string,
  dialogueHistory: { role: string; text: string }[]
): Promise<Memory[] | null> {
  if (isConsolidating) {
    console.log("[Memory] Consolidation loop busy, skipping slice processing");
    return null;
  }

  if (dialogueHistory.length < 2) {
    return null;
  }

  isConsolidating = true;
  console.log("[Memory] Initiating pipeline for dialogue slice of length:", dialogueHistory.length);

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        }
      }
    });

    const currentMemories = await loadMemories();
    
    // Format memory map to help Gemini understand what to edit
    const memoryContext = currentMemories.map(m => `ID: ${m.id} | Category: ${m.category} | Fact: ${m.text}`).join("\n");
    const dialogueContext = dialogueHistory.map(line => `${line.role === "user" ? "User" : "Myraa"}: ${line.text}`).join("\n");

    const prompt = `You are Myraa's deep cognitive recollection engine. Your task is to analyze the recent conversation piece against previous persistent memories, and output precise update transactions.

### OBJECTIVE
Decide if any statements contain durable, important personal facts, enduring preferences, aspirations, ongoing projects, critical relationships, key historical emotional events, skills, important decisions, or behavioral trends.
Avoid cataloging small talk, greetings, general chit-chat, or fleeting sentences (e.g., ignore 'hello', 'how are you', 'waking up', 'lol').

### CURRENT USER MEMORIES:
${memoryContext || "(No memory records exist)"}

### RECENT DIALOGUE SLICE:
${dialogueContext}

### RULES
- ACTIONS:
  - "ADD": If new material information is introduced that is not already captured.
  - "UPDATE": If previous information has evolved or is corrected. Provide the exact ID of the memory to replace.
  - "REMOVE": If a memory was explicitly disproven or the user directly asked Myraa to forget it.
- TEXT STYLE: Express the memories as clean, concise, third-person declarative summaries (e.g., 'The user is building a startup named Myraa.', 'The user loves playing GTA 6.'). Do not include conversational filler, quotes, or timestamps.
- ID: For ADD, leave blank. For UPDATE or REMOVE, provide the exact 'id' from the "Current user memories" list.
- IMPORTANCE: Assign "high" for core identity, active projects, important decisions; "medium" for preferences and goals; "low" for passing mentions.
- CONFIDENCE: "high" if user explicitly stated it; "medium" if clearly implied; "low" if inferred or uncertain.
- SOURCE: Always "conversation_extracted" for memories extracted from dialogue.`;

    const memoryModel = process.env.GEMINI_MEMORY_MODEL || "gemini-3.5-flash-lite";
    const response = await ai.models.generateContent({
      model: memoryModel,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            transactions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  action: {
                    type: Type.STRING,
                    description: "ADD, UPDATE, or REMOVE transaction.",
                    enum: ["ADD", "UPDATE", "REMOVE"]
                  },
                  id: {
                    type: Type.STRING,
                    description: "Specific ID of the existing memory being modified or deleted (leave blank/null for ADD)."
                  },
                  category: {
                    type: Type.STRING,
                    description: "The Memory category classification.",
                    // Phase 2: expanded to 11 categories
                    enum: [
                      "identity", "preference", "skill", "goal", "project",
                      "task", "decision", "relationship", "emotional", "behavior", "fact"
                    ]
                  },
                  text: {
                    type: Type.STRING,
                    description: "The memory summarized as a concise declarative statement in third-person."
                  },
                  importance: {
                    type: Type.STRING,
                    description: "Importance level: high, medium, or low.",
                    enum: ["high", "medium", "low"]
                  },
                  confidence: {
                    type: Type.STRING,
                    description: "Confidence level: high, medium, or low.",
                    enum: ["high", "medium", "low"]
                  }
                },
                required: ["action", "category", "text"]
              }
            }
          },
          required: ["transactions"]
        }
      }
    });

    const resultText = response.text?.trim() || "{}";
    const resultObj = JSON.parse(resultText);
    const transactions: (MemoryTransaction & { importance?: string; confidence?: string })[] = resultObj.transactions || [];

    if (transactions.length === 0) {
      console.log("[Memory] Zero transactions generated. Ignored routine conversations.");
      isConsolidating = false;
      return null;
    }

    console.log(`[Memory] Processing ${transactions.length} memory updates:`, JSON.stringify(transactions));

    let updatedMemories = [...currentMemories];
    const timestamp = new Date().toISOString();

    for (const trx of transactions) {
      if (trx.action === "ADD") {
        const newMemory: any = {
          id: Math.random().toString(36).substring(2, 11),
          category: trx.category,
          text: trx.text,
          createdAt: timestamp,
          updatedAt: timestamp,
          // Phase 2 fields
          importance: (trx as any).importance ?? "medium",
          confidence: (trx as any).confidence ?? "medium",
          source: "conversation_extracted",
          status: "active",
        };
        updatedMemories.push(newMemory);
      } else if (trx.action === "UPDATE") {
        const tarIndex = updatedMemories.findIndex(m => m.id === trx.id);
        if (tarIndex !== -1) {
          updatedMemories[tarIndex] = {
            ...(updatedMemories[tarIndex] as any),
            category: trx.category,
            text: trx.text,
            updatedAt: timestamp,
            // Preserve or update Phase 2 fields
            importance: (trx as any).importance ?? (updatedMemories[tarIndex] as any).importance ?? "medium",
            confidence: (trx as any).confidence ?? (updatedMemories[tarIndex] as any).confidence ?? "medium",
          } as any;

        } else {
          // Fallback, treat as ADD if ID not matched
          const newMemory: any = {
            id: Math.random().toString(36).substring(2, 11),
            category: trx.category,
            text: trx.text,
            createdAt: timestamp,
            updatedAt: timestamp,
            importance: (trx as any).importance ?? "medium",
            confidence: (trx as any).confidence ?? "medium",
            source: "conversation_extracted",
            status: "active",
          };
          updatedMemories.push(newMemory);
        }
      } else if (trx.action === "REMOVE") {
        updatedMemories = updatedMemories.filter(m => m.id !== trx.id);
      }
    }

    await saveMemories(updatedMemories);
    isConsolidating = false;
    return updatedMemories;

  } catch (error) {
    console.error("[Memory] Consolidation failure:", error);
    isConsolidating = false;
    return null;
  }
}
