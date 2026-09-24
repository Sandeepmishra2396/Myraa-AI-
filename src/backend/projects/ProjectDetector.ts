/**
 * MYRAA — ProjectDetector
 *
 * Inspects workspace manifests and files to detect:
 *   - Project type (node_typescript, node_javascript, python, rust, go, java, web_static, polyglot)
 *   - Manifest metadata (name, version, scripts, dependencies)
 *   - Primary languages and popular frameworks
 */

import fs from "fs/promises";
import path from "path";
import { assertWithinWorkspace } from "../security/PermissionManager.ts";
import type { ProjectManifest, ProjectType } from "./ProjectTypes.ts";

export class ProjectDetector {
  /**
   * Reads and parses project manifests safely.
   */
  static async readManifest(workspaceRoot: string): Promise<ProjectManifest | undefined> {
    const root = path.resolve(workspaceRoot);

    // Try package.json
    const packageJsonPath = path.join(root, "package.json");
    try {
      assertWithinWorkspace(packageJsonPath, root);
      const content = await fs.readFile(packageJsonPath, "utf-8");
      const parsed = JSON.parse(content);
      return {
        name: parsed.name,
        version: parsed.version,
        description: parsed.description,
        dependencies: parsed.dependencies,
        devDependencies: parsed.devDependencies,
        scripts: parsed.scripts,
        packageManager: parsed.packageManager,
      };
    } catch {
      /* Not a Node project or invalid JSON */
    }

    // Try pyproject.toml / requirements.txt
    const requirementsPath = path.join(root, "requirements.txt");
    try {
      assertWithinWorkspace(requirementsPath, root);
      const content = await fs.readFile(requirementsPath, "utf-8");
      const deps: Record<string, string> = {};
      content.split(/\r?\n/).forEach((line) => {
        const clean = line.trim();
        if (clean && !clean.startsWith("#")) {
          const parts = clean.split(/[>=<~]/);
          deps[parts[0].trim()] = clean;
        }
      });
      return {
        name: path.basename(root),
        dependencies: deps,
      };
    } catch {
      /* Not a python requirements project */
    }

    // Try Cargo.toml
    const cargoPath = path.join(root, "Cargo.toml");
    try {
      assertWithinWorkspace(cargoPath, root);
      const content = await fs.readFile(cargoPath, "utf-8");
      const nameMatch = content.match(/name\s*=\s*["']([^"']+)["']/);
      const versionMatch = content.match(/version\s*=\s*["']([^"']+)["']/);
      return {
        name: nameMatch ? nameMatch[1] : path.basename(root),
        version: versionMatch ? versionMatch[1] : undefined,
      };
    } catch {
      /* Not a Rust project */
    }

    // Try go.mod
    const goModPath = path.join(root, "go.mod");
    try {
      assertWithinWorkspace(goModPath, root);
      const content = await fs.readFile(goModPath, "utf-8");
      const moduleMatch = content.match(/module\s+([^\s\r\n]+)/);
      return {
        name: moduleMatch ? moduleMatch[1] : path.basename(root),
      };
    } catch {
      /* Not a Go project */
    }

    return undefined;
  }

  /**
   * Detects project type and primary language.
   */
  static async detect(
    workspaceRoot: string,
    scannedFiles: string[] = [],
  ): Promise<{
    type: ProjectType;
    primaryLanguage: string;
    frameworks: string[];
    manifest?: ProjectManifest;
  }> {
    const root = path.resolve(workspaceRoot);
    const manifest = await this.readManifest(root);

    let hasNode = false;
    let hasTs = false;
    let hasPython = false;
    let hasRust = false;
    let hasGo = false;
    let hasJava = false;
    let hasWeb = false;

    // Check files
    const fileSet = new Set(scannedFiles.map((f) => f.toLowerCase()));

    // Node / TS indicators
    if (fileSet.has("package.json")) hasNode = true;
    if (fileSet.has("tsconfig.json") || scannedFiles.some((f) => f.endsWith(".ts") || f.endsWith(".tsx"))) {
      hasTs = true;
    }

    // Python indicators
    if (
      fileSet.has("requirements.txt") ||
      fileSet.has("pyproject.toml") ||
      fileSet.has("setup.py") ||
      scannedFiles.some((f) => f.endsWith(".py"))
    ) {
      hasPython = true;
    }

    // Rust indicators
    if (fileSet.has("cargo.toml") || scannedFiles.some((f) => f.endsWith(".rs"))) {
      hasRust = true;
    }

    // Go indicators
    if (fileSet.has("go.mod") || scannedFiles.some((f) => f.endsWith(".go"))) {
      hasGo = true;
    }

    // Java indicators
    if (
      fileSet.has("pom.xml") ||
      fileSet.has("build.gradle") ||
      scannedFiles.some((f) => f.endsWith(".java") || f.endsWith(".kt"))
    ) {
      hasJava = true;
    }

    // Web static indicators
    if (fileSet.has("index.html")) {
      hasWeb = true;
    }

    // Determine type
    const activeEcosystems = [hasNode, hasPython, hasRust, hasGo, hasJava].filter(Boolean).length;
    let type: ProjectType = "unknown";
    let primaryLanguage = "unknown";

    if (activeEcosystems > 1) {
      type = "polyglot";
      primaryLanguage = hasTs ? "TypeScript" : hasNode ? "JavaScript" : hasPython ? "Python" : "Mixed";
    } else if (hasNode && hasTs) {
      type = "node_typescript";
      primaryLanguage = "TypeScript";
    } else if (hasNode) {
      type = "node_javascript";
      primaryLanguage = "JavaScript";
    } else if (hasPython) {
      type = "python";
      primaryLanguage = "Python";
    } else if (hasRust) {
      type = "rust";
      primaryLanguage = "Rust";
    } else if (hasGo) {
      type = "go";
      primaryLanguage = "Go";
    } else if (hasJava) {
      type = "java";
      primaryLanguage = "Java";
    } else if (hasWeb) {
      type = "web_static";
      primaryLanguage = "HTML/CSS";
    }

    // Framework detection
    const frameworks: string[] = [];
    const allDeps = {
      ...(manifest?.dependencies || {}),
      ...(manifest?.devDependencies || {}),
    };

    if (allDeps["react"] || fileSet.has("src/app.tsx") || fileSet.has("src/app.jsx")) frameworks.push("React");
    if (allDeps["vue"]) frameworks.push("Vue");
    if (allDeps["svelte"]) frameworks.push("Svelte");
    if (allDeps["next"]) frameworks.push("Next.js");
    if (allDeps["vite"] || fileSet.has("vite.config.ts") || fileSet.has("vite.config.js")) frameworks.push("Vite");
    if (allDeps["express"]) frameworks.push("Express");
    if (allDeps["fastify"]) frameworks.push("Fastify");
    if (allDeps["electron"] || fileSet.has("electron/main.cjs")) frameworks.push("Electron");
    if (allDeps["tailwindcss"] || fileSet.has("tailwind.config.js")) frameworks.push("TailwindCSS");
    if (allDeps["@google/genai"]) frameworks.push("Google GenAI");
    if (allDeps["three"]) frameworks.push("Three.js");
    if (allDeps["fastapi"] || (manifest?.dependencies && "fastapi" in manifest.dependencies)) frameworks.push("FastAPI");
    if (allDeps["flask"] || (manifest?.dependencies && "flask" in manifest.dependencies)) frameworks.push("Flask");
    if (allDeps["django"] || (manifest?.dependencies && "django" in manifest.dependencies)) frameworks.push("Django");

    return {
      type,
      primaryLanguage,
      frameworks,
      manifest,
    };
  }
}
