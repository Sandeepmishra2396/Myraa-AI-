/**
 * MYRAA — Core memory type definitions.
 *
 * The category union was expanded from 7 → 11 in Phase 2.
 * All existing values are preserved for backward compatibility.
 * New values: "skill", "task", "decision", "fact"
 */

export interface Memory {
  id: string;
  category:
    | "identity"
    | "preference"
    | "skill"       // NEW Phase 2
    | "goal"
    | "project"
    | "task"        // NEW Phase 2
    | "decision"    // NEW Phase 2
    | "relationship"
    | "emotional"
    | "behavior"
    | "fact";       // NEW Phase 2
  text: string;
  createdAt: string;
  updatedAt: string;
}

export type MemoryCategory = Memory["category"];

export interface MemoryTransaction {
  action: "ADD" | "UPDATE" | "REMOVE";
  id: string;
  category: MemoryCategory;
  text: string;
}
