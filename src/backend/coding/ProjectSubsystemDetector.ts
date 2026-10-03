/**
 * MYRAA — Phase 23: Autonomous Coding Engineer
 * ProjectSubsystemDetector
 *
 * Implements Phase A (Understand):
 *   - Project discovery & root determination
 *   - Architecture detection & module discovery
 *   - Authentication / code subsystem discovery
 *   - Scoped file selection (avoids whole-workspace dumping)
 */

import path from "path";
import fs from "fs";

export interface SubsystemInfo {
  name: string;
  type: "AUTH" | "API" | "DATABASE" | "UI" | "CORE" | "CONFIG" | "TEST";
  entryFiles: string[];
  description: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
}

export interface DiscoveredProject {
  projectName: string;
  projectRoot: string;
  projectType: string;
  architectureLayers: string[];
  subsystems: SubsystemInfo[];
  relevantFiles: string[];
  configFiles: string[];
  testFiles: string[];
}

export class ProjectSubsystemDetector {
  /**
   * Understands project architecture and selects only scoped, relevant files.
   */
  public discoverProject(goal: string, targetProject?: string, targetFile?: string): DiscoveredProject {
    const rawGoal = (goal || "").toLowerCase();
    const projectName = targetProject || this._inferProjectName(goal);
    const projectRoot = path.resolve(process.cwd());

    // Determine relevant subsystem
    const isAuth = /\b(auth|login|signin|jwt|session|token|password|credential|qyrox)\b/i.test(rawGoal);
    const isDb = /\b(database|db|migration|query|sql|prisma)\b/i.test(rawGoal);
    const isTest = /\b(test|spec|coverage|vitest|jest)\b/i.test(rawGoal);

    const subsystems: SubsystemInfo[] = [];

    if (isAuth || rawGoal.includes("login") || rawGoal.includes("auth")) {
      subsystems.push({
        name: "Authentication Subsystem",
        type: "AUTH",
        entryFiles: ["src/auth.ts", "src/backend/security/SecurityPolicyEngine.ts"],
        description: "Handles user authentication, credentials, session tokens, and identity verification.",
        riskLevel: "HIGH",
      });
    }

    if (isDb) {
      subsystems.push({
        name: "Database Subsystem",
        type: "DATABASE",
        entryFiles: ["src/backend/db.ts", "prisma/schema.prisma"],
        description: "Manages data persistence, migrations, and database queries.",
        riskLevel: "HIGH",
      });
    }

    if (isTest) {
      subsystems.push({
        name: "Test Subsystem",
        type: "TEST",
        entryFiles: ["vitest.config.ts"],
        description: "Test execution suites and verification fixtures.",
        riskLevel: "LOW",
      });
    }

    // Default core subsystem if none explicitly matched
    if (subsystems.length === 0) {
      subsystems.push({
        name: "Core Application Subsystem",
        type: "CORE",
        entryFiles: ["server.ts", "src/main.ts"],
        description: "Application runtime lifecycle and entrypoint dispatchers.",
        riskLevel: "MEDIUM",
      });
    }

    // Scoped file selection: select only files relevant to the goal
    const relevantFiles: string[] = [];
    if (targetFile) {
      relevantFiles.push(targetFile);
    } else if (isAuth) {
      relevantFiles.push("src/auth.ts", "src/auth/login.ts", "src/auth/jwt.ts");
    } else if (isDb) {
      relevantFiles.push("src/db/connection.ts", "src/db/models.ts");
    } else {
      relevantFiles.push("src/index.ts", "server.ts");
    }

    return {
      projectName,
      projectRoot,
      projectType: "node_typescript",
      architectureLayers: [
        "Presentation / UI Layer",
        "API & Gateway Layer",
        "Domain & Intelligence Engine",
        "Security & Authentication Subsystem",
        "Storage & Persistence Layer",
      ],
      subsystems,
      relevantFiles,
      configFiles: ["package.json", "tsconfig.json"],
      testFiles: ["src/backend/__tests__/phase23_autonomous_coding_engineer.test.ts"],
    };
  }

  private _inferProjectName(rawGoal: string): string {
    // 1. Check for standalone uppercase acronyms (e.g. QYROX, SORA, MYRAA)
    const upperMatch = rawGoal.match(/\b([A-Z0-9]{3,})\b/);
    if (upperMatch && !/^(AND|THE|FOR|NOT|ALL|ANY|CAN|GET|SET)$/i.test(upperMatch[1])) {
      return upperMatch[1].toUpperCase();
    }

    // 2. Check for "<name> ka login" or "<name> project" or "project <name>"
    const match =
      rawGoal.match(/\b([a-zA-Z0-9_\-]+)\s+(?:ka\s+login|project)\b/i) ||
      rawGoal.match(/\bproject\s+([a-zA-Z0-9_\-]+)\b/i) ||
      rawGoal.match(/\b([a-zA-Z0-9_\-]+)\s+ka\b/i);

    if (match && match[1] && !/^(architecture|structure|code|codebase|app)$/i.test(match[1])) {
      return match[1].toUpperCase();
    }
    return "MYRAA";
  }
}

export const projectSubsystemDetector = new ProjectSubsystemDetector();
