/**
 * MYRAA — HttpGateway
 *
 * Registers all Express REST routes and returns the configured app.
 * Also owns the logging subsystem (appendLog, logJson, logCommand, logStartup, logError).
 *
 * Routes registered:
 *   GET/POST/DELETE  /api/memories
 *   GET/POST         /api/settings
 *   GET              /api/config
 *   POST             /api/config/apikey   [localhost-only]
 *   DELETE           /api/config/apikey   [localhost-only]
 *   GET              /api/agent-health
 *   GET              /api/logs/:file      [localhost-only]
 *   GET              /api/proxy
 *   GET              /api/web-proxy
 *   GET              /api/youtube-search
 *
 * Static/Vite middleware is NOT mounted here — that stays in server.ts so the
 * gateway remains testable without a vite dependency.
 */

import express from "express";
import path from "path";
import * as fs from "fs";
import { Memory } from "../../lib/memoryTypes.ts";
import {
  loadMemories,
  saveMemories,
} from "../../../server_memory.ts";
import {
  DATA_DIR,
  dataFile,
  resolveApiKeyWithMetadata,
  classifyCredential,
  hasGeminiApiKey,
  setGeminiApiKey,
  clearGeminiApiKey,
} from "../../../server_paths.ts";
import { GoogleGenAI } from "@google/genai";
import {
  requireLocalhost,
  sanitizeError,
  safeSsrfFetch,
} from "../security/PermissionManager.ts";
import { dataProtectionService } from "../security/DataProtectionService.ts";
import {
  DESKTOP_AGENT_URL,
  callDesktopAgent,
} from "../tasks/TaskManager.ts";

// ---------------------------------------------------------------------------
// Logging subsystem
// ---------------------------------------------------------------------------
const LOGS_DIR = path.join(DATA_DIR, "logs");
try {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
} catch {
  /* already exists */
}

export function appendLog(fileName: string, message: string): void {
  try {
    const sanitized = sanitizeError(message);
    const line = `[${new Date().toISOString()}] ${sanitized}\n`;
    fs.appendFile(path.join(LOGS_DIR, fileName), line, () => {});
  } catch {
    /* logging is best-effort */
  }
}

export const logCommand = (m: string) => appendLog("commands.log", m);
export const logStartup = (m: string) => appendLog("startup.log", m);
export const logError = (m: string) => appendLog("errors.log", m);

/**
 * Structured JSON log entry (NDJSON). Written to logs/app.log.json.
 */
export function logJson(
  level: "info" | "warn" | "error",
  event: string,
  data: Record<string, unknown> = {},
): void {
  try {
    const sanitizedData: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === "string") {
        sanitizedData[k] = sanitizeError(v);
      } else {
        sanitizedData[k] = v;
      }
    }
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event: sanitizeError(event),
      ...sanitizedData,
    });
    fs.appendFile(
      path.join(LOGS_DIR, "app.log.json"),
      entry + "\n",
      () => {},
    );
  } catch {
    /* logging is best-effort */
  }
}

// ---------------------------------------------------------------------------
// Settings file helpers (co-located here because they're only used by routes)
// ---------------------------------------------------------------------------
const SETTINGS_FILE = dataFile("settings.json");

function loadSettingsFile(): Record<string, unknown> {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    }
  } catch {
    /* corrupt file — return defaults */
  }
  return {};
}

function saveSettingsFile(data: Record<string, unknown>): void {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Factory function — call once to get the configured Express app
// ---------------------------------------------------------------------------
export function createHttpApp(): express.Application {
  const app = express();

  // Trust first proxy hop in production (Nginx, Caddy, Cloudflare, ALB, K8s Ingress)
  if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }

  // 10MB payload limit enforcement
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  // ── Environment-Aware Security Headers Middleware ─────────────────────────
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-XSS-Protection", "0");

    // Strict-Transport-Security (HSTS): applied strictly in production over HTTPS/TLS
    const isProd = process.env.NODE_ENV === "production";
    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    if (isProd && (proto === "https" || proto === "wss" || (req.socket as any).encrypted)) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  // ── Environment-Aware CORS Middleware ────────────────────────────────────
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const isProd = process.env.NODE_ENV === "production" && process.env.SORA_LAUNCHED_BY !== "electron";

    if (origin) {
      let allowed = false;
      if (!isProd) {
        // Development: allow localhost and 127.0.0.1 origins
        const isLocalOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
        if (isLocalOrigin) allowed = true;
      } else {
        // Production: strictly explicit origins from process.env.CORS_ORIGINS (comma-separated). No wildcard!
        const configuredOrigins = (process.env.CORS_ORIGINS || "")
          .split(",")
          .map((o) => o.trim())
          .filter(Boolean);
        if (configuredOrigins.includes(origin)) {
          allowed = true;
        }
      }

      if (allowed) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
        res.setHeader("Access-Control-Allow-Credentials", "true");
      } else if (req.method === "OPTIONS") {
        return res.status(403).json({ error: "CORS_ORIGIN_DENIED: Origin not permitted." });
      }
    }

    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }
    next();
  });

  // Enforce Transport Security: Remote callers must use HTTPS/WSS
  app.use((req, res, next) => {
    const forwardedIp = req.headers["x-forwarded-for"];
    const ip = forwardedIp
      ? String(forwardedIp).split(",")[0].trim()
      : req.socket?.remoteAddress || req.connection?.remoteAddress || "";
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const check = dataProtectionService.validateTransport({
      protocol: String(proto),
      ipAddress: ip,
      targetName: req.originalUrl || req.path,
    });
    if (!check.secure) {
      return res.status(403).json({ error: check.error });
    }
    next();
  });

  // ── Memory REST API ────────────────────────────────────────────────────
  app.get("/api/memories", async (_req, res) => {
    try {
      const { memoryManager } = await import("../memory/MemoryManager.ts");
      const memories = await memoryManager.listMemories({ includeNeedsRevalidation: true });
      res.json(memories);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/memories", async (req, res) => {
    try {
      const { category, text, key, importance, confidence, source, expiresAt } = req.body;
      if (!category || !text) {
        return res
          .status(400)
          .json({ error: "Category and text parameters are required." });
      }
      const { memoryManager } = await import("../memory/MemoryManager.ts");
      const created = await memoryManager.createMemory({
        category,
        text,
        key,
        importance,
        confidence,
        source: source ?? "system_generated",
        expiresAt,
      });
      res.status(201).json(created);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/memories/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { memoryManager } = await import("../memory/MemoryManager.ts");
      const success = await memoryManager.deleteMemory(id);
      res.json({ success });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });


  // ── Phase 2 Memory Routes (additive — existing routes above unchanged) ──

  // GET /api/memories/search?q=&category=&importance=&confidence=&limit=
  app.get("/api/memories/search", async (req, res) => {
    try {
      const { memoryManager } = await import("../memory/MemoryManager.ts");
      const {
        q,
        category,
        importance,
        confidence,
        source,
        limit,
        includeArchived,
        includeNeedsRevalidation,
      } = req.query as Record<string, string>;

      const results = await memoryManager.searchMemories({
        query: q,
        categories: category ? [category as any] : undefined,
        minImportance: importance as any,
        minConfidence: confidence as any,
        source: source as any,
        limit: limit ? parseInt(limit, 10) : 20,
        includeArchived: includeArchived === "true",
        includeNeedsRevalidation: includeNeedsRevalidation !== "false",
      });
      res.json(results);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // PATCH /api/memories/:id — partial update
  app.patch("/api/memories/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { text, key, importance, confidence, status, expiresAt } = req.body;
      const { memoryManager } = await import("../memory/MemoryManager.ts");
      const updated = await memoryManager.updateMemory(id, {
        text,
        key,
        importance,
        confidence,
        status,
        expiresAt,
      });
      if (!updated) {
        return res.status(404).json({ error: "Memory not found." });
      }
      res.json(updated);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/memories/:id/archive — soft-delete
  app.post("/api/memories/:id/archive", async (req, res) => {
    try {
      const { id } = req.params;
      const { memoryManager } = await import("../memory/MemoryManager.ts");
      const archived = await memoryManager.archiveMemory(id);
      if (!archived) {
        return res.status(404).json({ error: "Memory not found." });
      }
      res.json(archived);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/memories/context?maxChars=2000&q= — get ranked context string
  app.get("/api/memories/context", async (req, res) => {
    try {
      const { memoryManager } = await import("../memory/MemoryManager.ts");
      const maxChars = req.query.maxChars ? parseInt(req.query.maxChars as string, 10) : 2000;
      const query = req.query.q as string | undefined;
      const context = await memoryManager.getRelevantContext({
        query,
        contextCharBudget: maxChars,
        touchLastAccessed: false, // read-only via REST
      });
      res.json({ context, charCount: context.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Project Intelligence REST API (Phase 3) ─────────────────────────────
  app.get("/api/projects/active", async (_req, res) => {
    try {
      const { projectManager } = await import("../projects/ProjectManager.ts");
      let project = await projectManager.analyzeProject();
      res.json(project);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/projects/analyze", async (req, res) => {
    try {
      const { projectManager } = await import("../projects/ProjectManager.ts");
      const targetPath = req.body?.path as string | undefined;
      const project = await projectManager.analyzeProject(targetPath);
      res.json(project);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/projects/architecture", async (_req, res) => {
    try {
      const { projectManager } = await import("../projects/ProjectManager.ts");
      const project = await projectManager.analyzeProject();
      res.json(project.architectureMap || { layers: [], entryPoints: [], keyComponents: [] });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/projects/search", async (req, res) => {
    try {
      const { projectManager } = await import("../projects/ProjectManager.ts");
      const q = (req.query.q as string) || "";
      const pattern = req.query.pattern as string | undefined;
      const caseSensitive = req.query.caseSensitive === "true";
      const maxResults = req.query.max ? parseInt(req.query.max as string, 10) : 25;
      const results = await projectManager.searchCode(q, {
        filePattern: pattern,
        caseSensitive,
        maxResults,
      });
      res.json(results);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/projects/git", async (_req, res) => {
    try {
      const { projectManager } = await import("../projects/ProjectManager.ts");
      const git = await projectManager.getGitStatus();
      res.json(git);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/projects/tasks", async (_req, res) => {
    try {
      const { projectManager } = await import("../projects/ProjectManager.ts");
      const tasks = await projectManager.getTasks();
      const lastSession = await projectManager.getLastSession();
      res.json({ tasks, lastSession });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/projects/tasks", async (req, res) => {
    try {
      const { projectManager } = await import("../projects/ProjectManager.ts");
      const { title, description, status } = req.body;
      if (!title) {
        return res.status(400).json({ error: "Task title is required." });
      }
      const task = await projectManager.addTask(title, description, status);
      res.status(201).json(task);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch("/api/projects/tasks/:id", async (req, res) => {
    try {
      const { projectManager } = await import("../projects/ProjectManager.ts");
      const { title, description, status } = req.body;
      const updated = await projectManager.updateTask(req.params.id, { title, description, status });
      if (!updated) {
        return res.status(404).json({ error: "Task not found." });
      }
      res.json(updated);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Knowledge & Research REST API (Phase 4) ─────────────────────────────
  app.get("/api/knowledge/documents", async (_req, res) => {
    try {
      const { knowledgeManager } = await import("../knowledge/KnowledgeManager.ts");
      const docs = await knowledgeManager.listDocuments();
      res.json({ documents: docs, count: docs.length });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.get("/api/knowledge/search", async (req, res) => {
    try {
      const { knowledgeManager } = await import("../knowledge/KnowledgeManager.ts");
      const q = (req.query.q as string) || "";
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 5;
      const results = await knowledgeManager.queryKnowledge(q, { limit });
      res.json(results);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/knowledge/ingest/file", async (req, res) => {
    try {
      const { knowledgeManager } = await import("../knowledge/KnowledgeManager.ts");
      const filePath = req.body?.path;
      const tags = Array.isArray(req.body?.tags) ? req.body.tags : [];
      if (!filePath) {
        return res.status(400).json({ error: "Missing 'path' parameter in request body." });
      }
      const doc = await knowledgeManager.ingestFile(filePath, tags);
      res.status(201).json({ success: true, document: doc });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/knowledge/ingest/url", async (req, res) => {
    try {
      const { knowledgeManager } = await import("../knowledge/KnowledgeManager.ts");
      const targetUrl = req.body?.url;
      const tags = Array.isArray(req.body?.tags) ? req.body.tags : [];
      if (!targetUrl) {
        return res.status(400).json({ error: "Missing 'url' parameter in request body." });
      }
      const doc = await knowledgeManager.ingestUrl(targetUrl, tags);
      res.status(201).json({ success: true, document: doc });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.delete("/api/knowledge/documents/:id", async (req, res) => {
    try {
      const { knowledgeManager } = await import("../knowledge/KnowledgeManager.ts");
      const success = await knowledgeManager.deleteDocument(req.params.id);
      res.json({ success });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/knowledge/research/web", async (req, res) => {
    try {
      const { knowledgeManager } = await import("../knowledge/KnowledgeManager.ts");
      const query = (req.body?.query as string) || "";
      const maxResults = req.body?.maxResults ? Number(req.body.maxResults) : 5;
      const fetchTopContent = req.body?.fetchTopContent === true;
      const results = await knowledgeManager.researchWeb(query, { maxResults, fetchTopContent });
      res.json(results);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/knowledge/research/docs", async (req, res) => {
    try {
      const { knowledgeManager } = await import("../knowledge/KnowledgeManager.ts");
      const technology = (req.body?.technology as string) || "";
      const topic = (req.body?.topic as string) || "";
      const results = await knowledgeManager.fetchOfficialDocs(technology, topic);
      res.json(results);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.get("/api/knowledge/freshness", async (req, res) => {
    try {
      const { knowledgeManager } = await import("../knowledge/KnowledgeManager.ts");
      const q = (req.query.q as string) || "";
      const report = await knowledgeManager.checkFreshness(q);
      res.json(report);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // ── Agent Planner REST API (Phase 5) ────────────────────────────────────
  app.post("/api/planner/plan", async (req, res) => {
    try {
      const { plannerCoordinator } = await import("../planner/PlannerCoordinator.ts");
      const goal = (req.body?.goal as string) || "";
      if (!goal.trim()) return res.status(400).json({ error: "Goal text is required." });
      const plan = await plannerCoordinator.createPlan(goal);
      res.status(201).json({
        planId: plan.id,
        status: plan.status,
        stepCount: plan.steps.length,
        goal: plan.goal.objective,
        category: plan.goal.category,
        requiresModification: plan.goal.requiresModification,
      });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.get("/api/planner/plans", async (_req, res) => {
    try {
      const { plannerCoordinator } = await import("../planner/PlannerCoordinator.ts");
      const plans = await plannerCoordinator.listPlans();
      res.json({
        plans: plans.map((p) => ({
          id: p.id,
          status: p.status,
          goal: p.goal.objective,
          category: p.goal.category,
          stepCount: p.steps.length,
          completedSteps: p.steps.filter((s) => s.status === "completed").length,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        })),
        count: plans.length,
      });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.get("/api/planner/plans/:id", async (req, res) => {
    try {
      const { plannerCoordinator } = await import("../planner/PlannerCoordinator.ts");
      const plan = await plannerCoordinator.getPlan(req.params.id);
      if (!plan) return res.status(404).json({ error: "Plan not found." });
      res.json(plan);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/planner/plans/:id/execute", async (req, res) => {
    try {
      const { plannerCoordinator } = await import("../planner/PlannerCoordinator.ts");
      const plan = await plannerCoordinator.executePlan(req.params.id);
      res.json({
        planId: plan.id,
        status: plan.status,
        pendingCheckpointId: plan.pendingCheckpointId,
        completedSteps: plan.steps.filter((s) => s.status === "completed").length,
        totalSteps: plan.steps.length,
        verificationReport: plan.verificationReport || null,
      });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/planner/plans/:id/pause", async (req, res) => {
    try {
      const { plannerCoordinator } = await import("../planner/PlannerCoordinator.ts");
      const plan = await plannerCoordinator.pausePlan(req.params.id);
      res.json({ planId: plan.id, status: plan.status });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/planner/plans/:id/resume", async (req, res) => {
    try {
      const { plannerCoordinator } = await import("../planner/PlannerCoordinator.ts");
      const plan = await plannerCoordinator.resumePlan(req.params.id);
      res.json({ planId: plan.id, status: plan.status });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/planner/plans/:id/checkpoint", async (req, res) => {
    try {
      const { plannerCoordinator } = await import("../planner/PlannerCoordinator.ts");
      const { checkpointId, approved, userFeedback } = req.body;
      if (!checkpointId || approved === undefined) {
        return res.status(400).json({ error: "checkpointId and approved are required." });
      }
      const plan = await plannerCoordinator.confirmCheckpoint(
        req.params.id,
        checkpointId,
        approved === true || approved === "true",
        userFeedback,
      );
      res.json({ planId: plan.id, status: plan.status, checkpointId, approved });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.delete("/api/planner/plans/:id", requireLocalhost, async (req, res) => {
    try {
      const { plannerCoordinator } = await import("../planner/PlannerCoordinator.ts");
      const deleted = await plannerCoordinator.deletePlan(req.params.id);
      res.json({ success: deleted });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // ── Proactive Companion REST API (Phase 6) ──────────────────────────────
  app.get("/api/companion/tasks", async (_req, res) => {
    try {
      const { companionCoordinator } = await import("../companion/CompanionCoordinator.ts");
      const tasks = await companionCoordinator.listTasks();
      res.json({ tasks, count: tasks.length });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/companion/tasks", async (req, res) => {
    try {
      const { companionCoordinator } = await import("../companion/CompanionCoordinator.ts");
      const { name, type, intervalMs, delayMs, maxIterations, params } = req.body || {};
      if (!name || !type) {
        return res.status(400).json({ error: "'name' and 'type' are required fields." });
      }
      const task = await companionCoordinator.scheduleTask({
        name,
        type,
        intervalMs: intervalMs ? Number(intervalMs) : undefined,
        delayMs: delayMs ? Number(delayMs) : undefined,
        maxIterations: maxIterations ? Number(maxIterations) : undefined,
        params,
      });
      res.status(201).json(task);
    } catch (e: any) {
      res.status(400).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.delete("/api/companion/tasks/:id", requireLocalhost, async (req, res) => {
    try {
      const { companionCoordinator } = await import("../companion/CompanionCoordinator.ts");
      const task = await companionCoordinator.cancelTask(req.params.id);
      if (!task) return res.status(404).json({ error: `Task '${req.params.id}' not found.` });
      res.json({ success: true, task });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/companion/tasks/:id/pause", async (req, res) => {
    try {
      const { companionCoordinator } = await import("../companion/CompanionCoordinator.ts");
      const task = await companionCoordinator.pauseTask(req.params.id);
      if (!task) return res.status(404).json({ error: `Task '${req.params.id}' not found.` });
      res.json(task);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/companion/tasks/:id/resume", async (req, res) => {
    try {
      const { companionCoordinator } = await import("../companion/CompanionCoordinator.ts");
      const task = await companionCoordinator.resumeTask(req.params.id);
      if (!task) return res.status(404).json({ error: `Task '${req.params.id}' not found.` });
      res.json(task);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.get("/api/companion/notifications", async (req, res) => {
    try {
      const { companionCoordinator } = await import("../companion/CompanionCoordinator.ts");
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const all = await companionCoordinator.listNotifications();
      res.json({ notifications: all.slice(0, limit), count: all.length });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/companion/notifications/:id/dismiss", async (req, res) => {
    try {
      const { companionCoordinator } = await import("../companion/CompanionCoordinator.ts");
      const item = await companionCoordinator.dismissNotification(req.params.id);
      if (!item) return res.status(404).json({ error: `Notification '${req.params.id}' not found.` });
      res.json({ success: true, notification: item });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.delete("/api/companion/notifications", requireLocalhost, async (_req, res) => {
    try {
      const { companionCoordinator } = await import("../companion/CompanionCoordinator.ts");
      await companionCoordinator.clearNotifications();
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.get("/api/companion/preferences", async (_req, res) => {
    try {
      const { companionCoordinator } = await import("../companion/CompanionCoordinator.ts");
      const prefs = await companionCoordinator.getPreferences();
      res.json(prefs);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.put("/api/companion/preferences", async (req, res) => {
    try {
      const { companionCoordinator } = await import("../companion/CompanionCoordinator.ts");
      const updated = await companionCoordinator.updatePreferences(req.body || {});
      res.json(updated);
    } catch (e: any) {
      res.status(400).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/companion/check", async (req, res) => {
    try {
      const { companionCoordinator } = await import("../companion/CompanionCoordinator.ts");
      const type = req.body?.type || "build";
      const targetUrl = req.body?.targetUrl;
      const result = await companionCoordinator.triggerCheck(type, targetUrl);
      res.json({ type, result });
    } catch (e: any) {
      res.status(400).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // ── Remote Voice Companion REST API (Phase 7) ───────────────────────────

  const requireLocalhostOrPairedDevice = async (req: any, res: any, next: () => void) => {
    const forwardedIp = req.headers["x-forwarded-for"];
    const ip = forwardedIp
      ? String(forwardedIp).split(",")[0].trim()
      : req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || "";
    const isLocal = !forwardedIp && (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "localhost");

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();

    if (token) {
      try {
        const { remoteSecurityCoordinator } = await import("../security/RemoteSecurityCoordinator.ts");
        const auth = await remoteSecurityCoordinator.authenticateRemoteCredential(token, ip, req.headers["user-agent"]);
        if (!auth.authenticated || !auth.device) {
          return res.status(401).json({ error: auth.error || "Unauthorized: Invalid or revoked device token." });
        }
        req.remoteDevice = auth.device;
        req.securitySession = auth.session;
        return next();
      } catch (e: any) {
        return res.status(500).json({ error: sanitizeError(e?.message || e) });
      }
    }

    if (isLocal) {
      return next();
    }

    return res.status(401).json({ error: "Unauthorized: Localhost access or valid Bearer device token required." });
  };

  // Generate a new 5-minute pairing code (localhost, paired admin, or atomic first-device bootstrap)
  app.post("/api/remote/pair-code", async (req: any, res) => {
    try {
      const forwardedIp = req.headers["x-forwarded-for"];
      const ip = forwardedIp
        ? String(forwardedIp).split(",")[0].trim()
        : req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || "";
      const isLocal = !forwardedIp && (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "localhost");

      const authHeader = req.headers.authorization || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();

      const { remoteStore } = await import("../remote/RemoteStore.ts");
      const { pairingManager } = await import("../remote/PairingManager.ts");

      // 1. Authenticated Remote Admin Device
      if (token) {
        const { remoteSecurityCoordinator } = await import("../security/RemoteSecurityCoordinator.ts");
        const auth = await remoteSecurityCoordinator.authenticateRemoteCredential(token, ip, req.headers["user-agent"]);
        if (!auth.authenticated || !auth.device) {
          return res.status(401).json({ error: auth.error || "Unauthorized: Invalid or revoked device token." });
        }
        if (auth.device.role !== "admin") {
          return res.status(403).json({ error: "Forbidden: Only admins can generate device pairing codes." });
        }
        const codeInfo = pairingManager.generatePairCode(ip);
        return res.status(201).json(codeInfo);
      }

      // 2. Localhost Access (Loopback desktop)
      if (isLocal) {
        const codeInfo = pairingManager.generatePairCode(ip);
        return res.status(201).json(codeInfo);
      }

      // 3. Atomic First-Device Bootstrap (Remote caller when zero devices exist in database)
      const bootstrapCode = await pairingManager.generateBootstrapPairCode(ip);
      return res.status(201).json(bootstrapCode);
    } catch (e: any) {
      const msg = sanitizeError(e?.message || e);
      const status = msg.includes("BOOTSTRAP_CONFLICT")
        ? 409
        : msg.includes("BOOTSTRAP_CLOSED")
        ? 403
        : 500;
      return res.status(status).json({ error: msg });
    }
  });

  // Check active pairing code status
  app.get("/api/remote/pair-code/status", async (_req, res) => {
    try {
      const { pairingManager } = await import("../remote/PairingManager.ts");
      const { remoteStore } = await import("../remote/RemoteStore.ts");
      const status = pairingManager.getActivePairCode();
      const devices = await remoteStore.listDevices();
      res.json({
        active: status !== null,
        canBootstrap: devices.length === 0,
        ...(status || {}),
      });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // Pair a device using PIN
  app.post("/api/remote/pair", async (req, res) => {
    try {
      const { code, deviceName, deviceType } = req.body || {};
      if (!code || !deviceName) {
        return res.status(400).json({ error: "'code' and 'deviceName' are required fields." });
      }
      const clientIp = req.ip || req.socket?.remoteAddress || "unknown";
      const { pairingManager } = await import("../remote/PairingManager.ts");
      const result = await pairingManager.pairDevice({
        code,
        deviceName,
        deviceType,
        ipAddress: clientIp,
        userAgent: req.headers["user-agent"],
      });

      const { remoteSecurityCoordinator } = await import("../security/RemoteSecurityCoordinator.ts");
      const sessionResult = remoteSecurityCoordinator.createDeviceSession(
        result.device,
        clientIp,
        req.headers["user-agent"]
      );

      res.status(201).json({
        success: true,
        device: {
          id: result.device.id,
          name: result.device.name,
          deviceType: result.device.deviceType,
          role: result.device.role,
          pairedAt: result.device.pairedAt,
          token: result.token,
        },
        token: result.token,
        deviceId: result.device.id,
        deviceRole: result.device.role,
        accessToken: sessionResult.tokens.accessToken,
        refreshToken: sessionResult.tokens.refreshToken,
        expiresInSeconds: sessionResult.tokens.expiresInSeconds,
      });
    } catch (e: any) {
      const msg = sanitizeError(e?.message || e);
      const status = msg.includes("PAIRING_LOCKED_OUT") ? 429 : 400;
      res.status(status).json({ error: msg });
    }
  });

  // Rotate session tokens with strict replay attack detection (Phase 17) & durable device token fallback
  app.post("/api/remote/token/refresh", async (req, res) => {
    try {
      const { refreshToken, deviceToken } = req.body || {};
      const forwardedIp = req.headers["x-forwarded-for"];
      const clientIp = forwardedIp
        ? String(forwardedIp).split(",")[0].trim()
        : req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || "unknown";

      if (!refreshToken && !deviceToken) {
        return res.status(400).json({ error: "Missing required 'refreshToken' or 'deviceToken' parameter." });
      }

      const { remoteSecurityCoordinator } = await import("../security/RemoteSecurityCoordinator.ts");

      // 1. Refresh token flow (Primary rotating path)
      if (refreshToken) {
        try {
          const result = await remoteSecurityCoordinator.rotateSessionToken(refreshToken, clientIp);
          return res.json({
            success: true,
            accessToken: result.tokens.accessToken,
            refreshToken: result.tokens.refreshToken,
            expiresInSeconds: result.tokens.expiresInSeconds,
            tokenType: result.tokens.tokenType,
          });
        } catch (err: any) {
          const msg = sanitizeError(err?.message || err);
          const isReplay = msg.includes("REPLAY") || msg.includes("TOKEN_FAMILY_REVOKED");
          // Replay attacks MUST be rejected immediately with 403 and never fall through
          if (isReplay) {
            return res.status(403).json({ error: msg });
          }
          // If session or family not found (e.g. server restart) but deviceToken is present, fall through
          if (!deviceToken) {
            return res.status(401).json({ error: msg });
          }
        }
      }

      // 2. Durable device token flow (Fallback re-establishment or direct device token exchange)
      if (deviceToken) {
        const auth = await remoteSecurityCoordinator.authenticateRemoteCredential(
          deviceToken,
          clientIp,
          req.headers["user-agent"]
        );
        if (!auth.authenticated || !auth.device) {
          return res.status(401).json({ error: auth.error || "Device token invalid or revoked." });
        }
        const sessionResult = remoteSecurityCoordinator.createDeviceSession(
          auth.device,
          clientIp,
          req.headers["user-agent"]
        );
        return res.json({
          success: true,
          accessToken: sessionResult.tokens.accessToken,
          refreshToken: sessionResult.tokens.refreshToken,
          expiresInSeconds: sessionResult.tokens.expiresInSeconds,
          tokenType: sessionResult.tokens.tokenType,
        });
      }

      return res.status(400).json({ error: "Unable to refresh session." });
    } catch (e: any) {
      const msg = sanitizeError(e?.message || e);
      const isReplay = msg.includes("REPLAY") || msg.includes("TOKEN_FAMILY_REVOKED");
      const status = isReplay ? 403 : 401;
      return res.status(status).json({ error: msg });
    }
  });

  // Revoke paired device via POST (Phase 16/17 client contract)
  app.post("/api/remote/revoke", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.body?.deviceId || req.remoteDevice?.id;
      if (!deviceId) {
        return res.status(400).json({ error: "Missing required 'deviceId' parameter." });
      }
      if (req.remoteDevice && req.remoteDevice.role !== "admin" && req.remoteDevice.id !== deviceId) {
        return res.status(403).json({ error: "Forbidden: Only admins, localhost, or the device itself can revoke paired devices." });
      }
      const { remoteSecurityCoordinator } = await import("../security/RemoteSecurityCoordinator.ts");
      const success = await remoteSecurityCoordinator.revokeRemoteDevice(deviceId, req.body?.reason || "Revoked via API");
      if (!success) {
        return res.status(404).json({ error: `Device '${deviceId}' not found.` });
      }
      res.json({ success: true, message: `Device '${deviceId}' revoked.` });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // List paired devices (strips token hash)
  app.get("/api/remote/devices", requireLocalhostOrPairedDevice, async (_req, res) => {
    try {
      const { remoteStore } = await import("../remote/RemoteStore.ts");
      const devices = await remoteStore.listDevices();
      const safeDevices = devices.map((d) => ({
        id: d.id,
        name: d.name,
        deviceType: d.deviceType,
        role: d.role,
        pairedAt: d.pairedAt,
        lastSeenAt: d.lastSeenAt,
        revoked: d.revoked,
        revokedAt: d.revokedAt,
      }));
      res.json({ devices: safeDevices, count: safeDevices.length });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // Revoke a paired device
  app.delete("/api/remote/devices/:id", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      if (req.remoteDevice && req.remoteDevice.role !== "admin" && req.remoteDevice.id !== req.params.id) {
        return res.status(403).json({ error: "Forbidden: Only admins, localhost, or the device itself can revoke paired devices." });
      }
      const { remoteSessionManager } = await import("../remote/RemoteSessionManager.ts");
      const success = await remoteSessionManager.revokeDevice(req.params.id, req.body?.reason || "Revoked via API");
      if (!success) {
        return res.status(404).json({ error: `Device '${req.params.id}' not found.` });
      }
      res.json({ success: true, message: `Device '${req.params.id}' revoked.` });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // Update a paired device's role (localhost only)
  app.patch("/api/remote/devices/:id/role", requireLocalhost, async (req, res) => {
    try {
      const { role } = req.body || {};
      const validRoles = ["read_only", "standard", "admin"];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ error: `Invalid role '${role}'. Must be one of: ${validRoles.join(", ")}` });
      }
      const { remoteStore } = await import("../remote/RemoteStore.ts");
      const device = await remoteStore.getDevice(req.params.id);
      if (!device) return res.status(404).json({ error: `Device '${req.params.id}' not found.` });
      device.role = role;
      await remoteStore.saveDevice(device);
      res.json({ success: true, device: { id: device.id, name: device.name, role: device.role } });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // Get current caller session profile
  app.get("/api/remote/session", requireLocalhostOrPairedDevice, async (req: any, res) => {
    if (req.remoteDevice) {
      return res.json({
        type: "remote_device",
        device: {
          id: req.remoteDevice.id,
          name: req.remoteDevice.name,
          role: req.remoteDevice.role,
          deviceType: req.remoteDevice.deviceType,
        },
      });
    }
    res.json({ type: "localhost", role: "admin" });
  });

  // ── Phase 19 Android Capability Execution Endpoint ─────────────────────
  // POST /api/remote/capability/execute — Execute a native Android capability
  app.post("/api/remote/capability/execute", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const { capability, args, confirmationToken } = req.body || {};
      if (!capability || typeof capability !== "string") {
        return res.status(400).json({ error: "Missing required 'capability' string parameter." });
      }

      const deviceId = req.remoteDevice?.id || req.body?.deviceId || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;

      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { remoteCapabilityDispatcher } = await import("../remote/RemoteCapabilityDispatcher.ts");
      const result = await remoteCapabilityDispatcher.dispatchCapability(
        deviceId,
        capability,
        args || {},
        secContext,
        confirmationToken
      );

      if (!result.ok) {
        const status = result.blocked ? (result.decision?.decision === "REQUIRE_CONFIRMATION" ? 428 : 403) : 400;
        return res.status(status).json({
          success: false,
          error: result.error,
          blocked: result.blocked,
          requiresConfirmation: result.requiresConfirmation,
          confirmationToken: result.confirmationToken,
          decision: result.decision,
        });
      }

      res.json({
        success: true,
        capability,
        deviceId,
        dispatched: result.dispatched,
        result: result.result,
        decision: result.decision,
      });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // ── Phase 24 Shared MYRAA Memory REST API ──────────────────────────────

  // GET /api/remote/memory — List canonical shared memories
  app.get("/api/remote/memory", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { category, includeArchived, includeNeedsRevalidation } = req.query;
      const { sharedMemoryManager } = await import("../memory/SharedMemoryManager.ts");
      const memories = await sharedMemoryManager.listMemories(
        {
          category: category as any,
          includeArchived: includeArchived === "true",
          includeNeedsRevalidation: includeNeedsRevalidation !== "false",
        },
        secContext,
      );
      res.json(memories);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // POST /api/remote/memory — Create a shared memory record
  app.post("/api/remote/memory", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { category, text, key, importance, confidence, source, expiresAt, clientMutationId } = req.body || {};
      if (!category || !text) {
        return res.status(400).json({ error: "Category and text parameters are required." });
      }

      const { sharedMemoryManager } = await import("../memory/SharedMemoryManager.ts");
      const created = await sharedMemoryManager.createMemory(
        {
          category,
          text,
          key,
          importance,
          confidence,
          source: source ?? (isLocal ? "system_generated" : "user_explicit"),
          expiresAt,
          deviceId,
          deviceType: isLocal ? "desktop" : "android",
          clientMutationId,
        },
        secContext,
      );

      res.status(201).json(created);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("DLP_SECRET_REJECTED")) {
        return res.status(422).json({ error: msg, blocked: true });
      }
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // GET /api/remote/memory/search — Search shared memories
  app.get("/api/remote/memory/search", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const {
        q,
        category,
        importance,
        confidence,
        source,
        limit,
        includeArchived,
        includeNeedsRevalidation,
      } = req.query as Record<string, string>;

      const { sharedMemoryManager } = await import("../memory/SharedMemoryManager.ts");
      const results = await sharedMemoryManager.searchMemories(
        {
          query: q,
          categories: category ? [category as any] : undefined,
          minImportance: importance as any,
          minConfidence: confidence as any,
          source: source as any,
          limit: limit ? parseInt(limit, 10) : 20,
          includeArchived: includeArchived === "true",
          includeNeedsRevalidation: includeNeedsRevalidation !== "false",
        },
        secContext,
      );

      res.json(results);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // PATCH /api/remote/memory/:id — Partial update with deterministic conflict resolution
  app.patch("/api/remote/memory/:id", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const { id } = req.params;
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const {
        text,
        key,
        importance,
        confidence,
        status,
        expiresAt,
        clientMutationId,
        clientVersion,
        timestamp,
      } = req.body || {};

      const { sharedMemoryManager } = await import("../memory/SharedMemoryManager.ts");
      const result = await sharedMemoryManager.updateMemory(
        id,
        {
          text,
          key,
          importance,
          confidence,
          status,
          expiresAt,
          deviceId,
          deviceType: isLocal ? "desktop" : "android",
          clientMutationId,
          clientVersion,
          timestamp,
        },
        secContext,
      );

      if (!result.success && result.error?.includes("not found")) {
        return res.status(404).json({ error: result.error });
      }

      res.json(result);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("DLP_SECRET_REJECTED")) {
        return res.status(422).json({ error: msg, blocked: true });
      }
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // DELETE /api/remote/memory/:id — Delete shared memory
  app.delete("/api/remote/memory/:id", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const { id } = req.params;
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { sharedMemoryManager } = await import("../memory/SharedMemoryManager.ts");
      const success = await sharedMemoryManager.deleteMemory(id, secContext);
      res.json({ success });
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // POST /api/remote/memory/sync — Batch offline sync with deterministic conflict resolution
  app.post("/api/remote/memory/sync", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || req.body?.deviceId || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { mutations, lastSyncTimestamp } = req.body || {};
      if (!Array.isArray(mutations)) {
        return res.status(400).json({ error: "Required 'mutations' array parameter missing." });
      }

      const { sharedMemoryManager } = await import("../memory/SharedMemoryManager.ts");
      const syncResult = await sharedMemoryManager.syncBatch(
        {
          deviceId,
          deviceType: isLocal ? "desktop" : "android",
          mutations,
          lastSyncTimestamp,
        },
        secContext,
      );

      res.json(syncResult);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // ── Phase 25 — Cross-Device Handoff REST API ────────────────────────────

  // POST /api/remote/handoff — Create handoff snapshot
  app.post("/api/remote/handoff", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { crossDeviceHandoffManager } = await import("../handoff/CrossDeviceHandoffManager.ts");
      const result = await crossDeviceHandoffManager.createHandoff(req.body || {}, secContext);
      if (!result.success) {
        if (result.errorCode === "DLP_SECRET_REJECTED") {
          return res.status(400).json(result);
        }
        return res.status(400).json(result);
      }
      res.status(201).json(result);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // GET /api/remote/handoff — List available handoffs for calling device
  app.get("/api/remote/handoff", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { status, targetDeviceId, sourceDeviceId } = req.query;
      const { crossDeviceHandoffManager } = await import("../handoff/CrossDeviceHandoffManager.ts");
      const handoffs = await crossDeviceHandoffManager.listAvailableHandoffs(
        {
          status: status as any,
          targetDeviceId: targetDeviceId as string,
          sourceDeviceId: sourceDeviceId as string,
        },
        secContext,
      );
      res.json(handoffs);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // GET /api/remote/handoff/:id — Get details of a single handoff
  app.get("/api/remote/handoff/:id", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { crossDeviceHandoffManager } = await import("../handoff/CrossDeviceHandoffManager.ts");
      const handoff = await crossDeviceHandoffManager.getHandoff(req.params.id, secContext);
      if (!handoff) {
        return res.status(404).json({ error: `Handoff '${req.params.id}' not found.` });
      }
      res.json(handoff);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // POST /api/remote/handoff/:id/accept — Accept handoff on target device
  app.post("/api/remote/handoff/:id/accept", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { token } = req.body || {};
      if (!token) {
        return res.status(400).json({ error: "Missing required handoff token.", errorCode: "INVALID_TOKEN" });
      }

      const { crossDeviceHandoffManager } = await import("../handoff/CrossDeviceHandoffManager.ts");
      const result = await crossDeviceHandoffManager.acceptHandoff(
        { handoffId: req.params.id, handoffToken: token },
        secContext,
      );

      if (!result.success) {
        if (result.errorCode === "NOT_FOUND") return res.status(404).json(result);
        if (result.errorCode === "INVALID_TOKEN") return res.status(401).json(result);
        if (result.errorCode === "UNAUTHORIZED_DEVICE") return res.status(403).json(result);
        if (result.errorCode === "ALREADY_ACCEPTED" || result.errorCode === "ALREADY_RESUMED") {
          return res.status(409).json(result);
        }
        if (result.errorCode === "EXPIRED" || result.errorCode === "CANCELLED") {
          return res.status(410).json(result);
        }
        return res.status(400).json(result);
      }

      res.json(result);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // POST /api/remote/handoff/:id/resume — Resume handoff task/conversation
  app.post("/api/remote/handoff/:id/resume", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { token, confirmResume } = req.body || {};
      if (!token) {
        return res.status(400).json({ error: "Missing required handoff token.", errorCode: "INVALID_TOKEN" });
      }

      const { crossDeviceHandoffManager } = await import("../handoff/CrossDeviceHandoffManager.ts");
      const result = await crossDeviceHandoffManager.resumeHandoff(
        { handoffId: req.params.id, handoffToken: token, confirmResume: !!confirmResume },
        secContext,
      );

      if (!result.success) {
        if (result.errorCode === "NOT_FOUND") return res.status(404).json(result);
        if (result.errorCode === "INVALID_TOKEN") return res.status(401).json(result);
        if (result.errorCode === "UNAUTHORIZED_DEVICE") return res.status(403).json(result);
        if (result.errorCode === "CANCELLED" || result.errorCode === "EXPIRED") {
          return res.status(410).json(result);
        }
        return res.status(400).json(result);
      }

      res.json(result);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // POST /api/remote/handoff/:id/cancel — Cancel/revoke handoff
  app.post("/api/remote/handoff/:id/cancel", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { crossDeviceHandoffManager } = await import("../handoff/CrossDeviceHandoffManager.ts");
      const result = await crossDeviceHandoffManager.cancelHandoff(req.params.id, secContext);

      if (!result.success) {
        if (result.errorCode === "NOT_FOUND") return res.status(404).json(result);
        if (result.errorCode === "UNAUTHORIZED_DEVICE") return res.status(403).json(result);
        if (result.errorCode === "ALREADY_RESUMED") return res.status(409).json(result);
        return res.status(400).json(result);
      }

      res.json(result);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // ── Phase 26 — Mobile Proactive Companion Endpoints ───────────────────────

  // POST /api/remote/proactive/subscribe — Register Android companion for proactive notifications
  app.post("/api/remote/proactive/subscribe", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || req.body?.deviceId || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { preferences } = req.body || {};
      const { mobileProactiveManager } = await import("../companion/mobile/MobileProactiveManager.ts");
      const prefs = await mobileProactiveManager.subscribeDevice({ deviceId, preferences }, secContext);
      res.status(200).json({ success: true, preferences: prefs });
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // DELETE /api/remote/proactive/subscribe — Unregister Android companion
  app.delete("/api/remote/proactive/subscribe", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || req.body?.deviceId || req.query?.deviceId || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { mobileProactiveManager } = await import("../companion/mobile/MobileProactiveManager.ts");
      const removed = await mobileProactiveManager.unsubscribeDevice(deviceId, secContext);
      res.status(200).json({ success: true, removed });
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // GET /api/remote/proactive/preferences — Get notification preferences
  app.get("/api/remote/proactive/preferences", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || (req.query?.deviceId as string) || "local_operator";
      const { mobileProactiveManager } = await import("../companion/mobile/MobileProactiveManager.ts");
      const preferences = mobileProactiveManager.getDevicePreferences(deviceId);
      res.json({ success: true, preferences });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // PUT /api/remote/proactive/preferences — Update device notification preferences
  app.put("/api/remote/proactive/preferences", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || req.body?.deviceId || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const patch = req.body || {};
      const { mobileProactiveManager } = await import("../companion/mobile/MobileProactiveManager.ts");
      const preferences = await mobileProactiveManager.updateDevicePreferences(deviceId, patch, secContext);
      res.json({ success: true, preferences });
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // GET /api/remote/proactive/pending — Fetch & drain offline queued notifications
  app.get("/api/remote/proactive/pending", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || (req.query?.deviceId as string) || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { mobileProactiveManager } = await import("../companion/mobile/MobileProactiveManager.ts");
      const notifications = await mobileProactiveManager.drainPendingNotifications(deviceId, secContext);
      res.json({ success: true, notifications, count: notifications.length });
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // POST /api/remote/proactive/clear — Clear pending notification queue
  app.post("/api/remote/proactive/clear", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || req.body?.deviceId || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { mobileProactiveManager } = await import("../companion/mobile/MobileProactiveManager.ts");
      await mobileProactiveManager.clearPendingNotifications(deviceId, secContext);
      res.json({ success: true, cleared: true });
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // POST /api/remote/proactive/test — Dispatch test proactive notification
  app.post("/api/remote/proactive/test", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || req.body?.targetDeviceId || req.body?.deviceId;
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: req.remoteDevice?.id || "local_operator",
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId: req.remoteDevice?.id || "local_operator",
        isLocal,
      };

      const { title, message, category, priority, metadata, actionUrl } = req.body || {};
      const { mobileProactiveManager } = await import("../companion/mobile/MobileProactiveManager.ts");
      const result = await mobileProactiveManager.dispatchProactiveEvent(
        {
          title: title || "Test Proactive Alert",
          message: message || "This is a test proactive companion notification.",
          category: category || "TASK",
          priority: priority || "DEFAULT",
          targetDeviceId: deviceId,
          metadata,
          actionUrl,
        },
        secContext,
      );

      if (!result.success) {
        if (result.errorCode === "DLP_SECRET_REJECTED") {
          return res.status(400).json(result);
        }
        if (result.errorCode === "EMERGENCY_STOP_ACTIVE") {
          return res.status(503).json(result);
        }
        if (result.errorCode === "SECURITY_LOCKDOWN_ACTIVE") {
          return res.status(423).json(result);
        }
        return res.status(400).json(result);
      }

      res.json(result);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // ── Phase 27 — Mobile Autonomous Workflow Endpoints ──────────────────────

  // POST /api/remote/workflow/execute — Execute or preview autonomous voice workflow
  app.post("/api/remote/workflow/execute", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || req.body?.deviceId || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { mobileWorkflowManager } = await import("../workflow/MobileWorkflowManager.ts");
      const result = await mobileWorkflowManager.executeVoiceWorkflow(
        {
          query: req.body?.query || req.body?.prompt || "",
          deviceId,
          autoExecute: req.body?.autoExecute !== false,
          preferredLanguage: req.body?.preferredLanguage,
          clientContext: req.body?.clientContext,
        },
        secContext,
      );

      if (!result.success && result.errorCode) {
        if (result.errorCode === "SECURITY_VIOLATION" || result.errorCode === "INVALID_QUERY") {
          return res.status(400).json(result);
        }
        if (result.errorCode === "EMERGENCY_STOP_ACTIVE") {
          return res.status(503).json(result);
        }
        if (result.errorCode === "SECURITY_LOCKDOWN_ACTIVE") {
          return res.status(423).json(result);
        }
        if (result.errorCode === "DEVICE_REVOKED") {
          return res.status(403).json(result);
        }
      }

      res.status(200).json(result);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // GET /api/remote/workflow/:id — Retrieve workflow status and progress
  app.get("/api/remote/workflow/:id", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { mobileWorkflowManager } = await import("../workflow/MobileWorkflowManager.ts");
      const result = await mobileWorkflowManager.getWorkflowStatus(req.params.id, secContext);

      if (!result.success && result.errorCode === "PLAN_NOT_FOUND") {
        return res.status(404).json(result);
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // POST /api/remote/workflow/:id/confirm — Confirm or reject a pending checkpoint
  app.post("/api/remote/workflow/:id/confirm", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { checkpointId, approved, userFeedback } = req.body || {};
      if (!checkpointId || approved === undefined) {
        return res.status(400).json({ error: "Missing required fields: checkpointId and approved." });
      }

      const { mobileWorkflowManager } = await import("../workflow/MobileWorkflowManager.ts");
      const result = await mobileWorkflowManager.confirmWorkflowStep(
        req.params.id,
        checkpointId,
        approved === true || approved === "true",
        userFeedback,
        secContext,
      );

      if (!result.success && result.errorCode === "PLAN_NOT_FOUND") {
        return res.status(404).json(result);
      }
      res.json(result);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // POST /api/remote/workflow/:id/pause — Pause an active workflow
  app.post("/api/remote/workflow/:id/pause", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { mobileWorkflowManager } = await import("../workflow/MobileWorkflowManager.ts");
      const result = await mobileWorkflowManager.pauseWorkflow(req.params.id, secContext);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // POST /api/remote/workflow/:id/resume — Resume a paused workflow
  app.post("/api/remote/workflow/:id/resume", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { mobileWorkflowManager } = await import("../workflow/MobileWorkflowManager.ts");
      const result = await mobileWorkflowManager.resumeWorkflow(req.params.id, secContext);
      res.json(result);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // POST /api/remote/workflow/:id/cancel — Cancel a workflow
  app.post("/api/remote/workflow/:id/cancel", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { mobileWorkflowManager } = await import("../workflow/MobileWorkflowManager.ts");
      const result = await mobileWorkflowManager.cancelWorkflow(req.params.id, secContext);
      if (!result.success && result.errorCode === "PLAN_NOT_FOUND") {
        return res.status(404).json(result);
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // Emergency Stop Trigger (fail-safe: open to any paired device or localhost)
  app.post("/api/remote/emergency-stop", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const { emergencyStopCoordinator } = await import("../remote/EmergencyStopCoordinator.ts");
      const state = await emergencyStopCoordinator.trigger({
        source: req.remoteDevice ? "remote_device" : "rest_api",
        deviceId: req.remoteDevice?.id,
        deviceName: req.remoteDevice?.name,
        ipAddress: req.ip,
        reason: req.body?.reason,
      });
      res.json({ success: true, active: state.active, state });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // Emergency Stop Reset (localhost only)
  app.post("/api/remote/emergency-stop/reset", requireLocalhost, async (req, res) => {
    try {
      const { emergencyStopCoordinator } = await import("../remote/EmergencyStopCoordinator.ts");
      const state = await emergencyStopCoordinator.reset(req.ip || "localhost");
      res.json({ success: true, active: state.active, state });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // Emergency Stop Status Inspection (open to all)
  app.get("/api/remote/emergency-stop/status", async (_req, res) => {
    try {
      const { emergencyStopCoordinator } = await import("../remote/EmergencyStopCoordinator.ts");
      res.json(emergencyStopCoordinator.getState());
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // ── Phase 28 — Mobile Emergency & Security Endpoints ────────────────────

  // GET /api/remote/security/status — Sanitized security status aggregate
  app.get("/api/remote/security/status", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };
      const { androidSecurityManager } = await import("../security/AndroidSecurityManager.ts");
      const status = await androidSecurityManager.getSecurityStatus(deviceId, secContext);
      res.json({ success: true, status });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // GET /api/remote/security/sessions — List active remote sessions (sanitized)
  app.get("/api/remote/security/sessions", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const { androidSecurityManager } = await import("../security/AndroidSecurityManager.ts");
      const sessions = androidSecurityManager.getActiveSessions();
      res.json({ success: true, sessions, count: sessions.length });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // DELETE /api/remote/security/sessions/:id — Terminate specific remote session
  app.delete("/api/remote/security/sessions/:id", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };
      const { reason } = req.body || {};
      const { androidSecurityManager } = await import("../security/AndroidSecurityManager.ts");
      const result = androidSecurityManager.terminateSession(req.params.id, reason, secContext);
      if (!result.success) {
        const code = result.errorCode === "UNAUTHORIZED" ? 403 : result.errorCode === "DEVICE_NOT_FOUND" ? 404 : 400;
        return res.status(code).json(result);
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // DELETE /api/remote/security/sessions — Terminate all remote sessions [admin/localhost]
  app.delete("/api/remote/security/sessions", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };
      const { reason } = req.body || {};
      const { androidSecurityManager } = await import("../security/AndroidSecurityManager.ts");
      const result = androidSecurityManager.terminateAllSessions(reason, secContext);
      if (!result.success) {
        const code = result.errorCode === "UNAUTHORIZED" ? 403 : 400;
        return res.status(code).json(result);
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // POST /api/remote/security/lockdown — Trigger global Security Lockdown [admin/localhost]
  app.post("/api/remote/security/lockdown", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };
      const { reason, nonce, timestampMs } = req.body || {};
      if (nonce && timestampMs) {
        const { remoteSecurityCoordinator } = await import("../security/RemoteSecurityCoordinator.ts");
        const nonceCheck = remoteSecurityCoordinator.validateRequestNonce(nonce, timestampMs);
        if (!nonceCheck.valid) {
          return res.status(403).json({ success: false, errorCode: "REPLAY_ATTACK", error: nonceCheck.error });
        }
      }
      const { androidSecurityManager } = await import("../security/AndroidSecurityManager.ts");
      const result = await androidSecurityManager.triggerLockdown(reason, secContext);
      if (!result.success) {
        const code = result.errorCode === "UNAUTHORIZED" ? 403 : result.errorCode === "ALREADY_IN_LOCKDOWN" ? 409 : 400;
        return res.status(code).json(result);
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // POST /api/remote/security/lockdown/recover — Recover from Security Lockdown [admin/localhost]
  app.post("/api/remote/security/lockdown/recover", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };
      const { nonce, timestampMs } = req.body || {};
      if (nonce && timestampMs) {
        const { remoteSecurityCoordinator } = await import("../security/RemoteSecurityCoordinator.ts");
        const nonceCheck = remoteSecurityCoordinator.validateRequestNonce(nonce, timestampMs);
        if (!nonceCheck.valid) {
          return res.status(403).json({ success: false, errorCode: "REPLAY_ATTACK", error: nonceCheck.error });
        }
      }
      const { androidSecurityManager } = await import("../security/AndroidSecurityManager.ts");
      const result = await androidSecurityManager.recoverFromLockdown(secContext);
      if (!result.success) {
        const code = result.errorCode === "UNAUTHORIZED" ? 403 : result.errorCode === "NOT_IN_LOCKDOWN" ? 409 : 400;
        return res.status(code).json(result);
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // POST /api/remote/security/lost-device/enable — Enable lost-device mode [admin/localhost]
  app.post("/api/remote/security/lost-device/enable", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };
      const { deviceId: targetDeviceId, reason, nonce, timestampMs } = req.body || {};
      if (!targetDeviceId) {
        return res.status(400).json({ success: false, errorCode: "DEVICE_NOT_FOUND", error: "Missing required 'deviceId' parameter." });
      }
      if (nonce && timestampMs) {
        const { remoteSecurityCoordinator } = await import("../security/RemoteSecurityCoordinator.ts");
        const nonceCheck = remoteSecurityCoordinator.validateRequestNonce(nonce, timestampMs);
        if (!nonceCheck.valid) {
          return res.status(403).json({ success: false, errorCode: "REPLAY_ATTACK", error: nonceCheck.error });
        }
      }
      const { androidSecurityManager } = await import("../security/AndroidSecurityManager.ts");
      const result = await androidSecurityManager.enableLostDeviceMode(targetDeviceId, reason, secContext);
      if (!result.success) {
        const code = result.errorCode === "UNAUTHORIZED" ? 403 : result.errorCode === "DEVICE_NOT_FOUND" ? 404 : result.errorCode === "DEVICE_ALREADY_LOST" ? 409 : 400;
        return res.status(code).json(result);
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // POST /api/remote/security/lost-device/recover — Recover device from lost-device mode [admin/localhost]
  app.post("/api/remote/security/lost-device/recover", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };
      const { deviceId: targetDeviceId, nonce, timestampMs } = req.body || {};
      if (!targetDeviceId) {
        return res.status(400).json({ success: false, errorCode: "DEVICE_NOT_FOUND", error: "Missing required 'deviceId' parameter." });
      }
      if (nonce && timestampMs) {
        const { remoteSecurityCoordinator } = await import("../security/RemoteSecurityCoordinator.ts");
        const nonceCheck = remoteSecurityCoordinator.validateRequestNonce(nonce, timestampMs);
        if (!nonceCheck.valid) {
          return res.status(403).json({ success: false, errorCode: "REPLAY_ATTACK", error: nonceCheck.error });
        }
      }
      const { androidSecurityManager } = await import("../security/AndroidSecurityManager.ts");
      const result = await androidSecurityManager.recoverLostDevice(targetDeviceId, secContext);
      if (!result.success) {
        const code = result.errorCode === "UNAUTHORIZED" ? 403 : result.errorCode === "DEVICE_NOT_LOST" ? 404 : 400;
        return res.status(code).json(result);
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // POST /api/remote/security/logout-all — Global logout all devices [admin/localhost]
  app.post("/api/remote/security/logout-all", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };
      const { reason, nonce, timestampMs } = req.body || {};
      if (nonce && timestampMs) {
        const { remoteSecurityCoordinator } = await import("../security/RemoteSecurityCoordinator.ts");
        const nonceCheck = remoteSecurityCoordinator.validateRequestNonce(nonce, timestampMs);
        if (!nonceCheck.valid) {
          return res.status(403).json({ success: false, errorCode: "REPLAY_ATTACK", error: nonceCheck.error });
        }
      }
      const { androidSecurityManager } = await import("../security/AndroidSecurityManager.ts");
      const result = await androidSecurityManager.logoutAllDevices(reason, secContext);
      if (!result.success) {
        const code = result.errorCode === "UNAUTHORIZED" ? 403 : 400;
        return res.status(code).json(result);
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // ── Phase 8 Multimodal Intelligence Routes ─────────────────────────────

  // GET /api/multimodal/context — full real-time fused snapshot
  app.get("/api/multimodal/context", async (_req, res) => {
    try {
      const { multimodalFusionEngine } = await import("../multimodal/MultimodalFusionEngine.ts");
      const snapshot = multimodalFusionEngine.getLatestSnapshot();
      res.json(snapshot || { message: "No multimodal context recorded yet." });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // POST /api/multimodal/screen/capture — on-demand screen capture
  app.post("/api/multimodal/screen/capture", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const { screenContextManager } = await import("../multimodal/ScreenContextManager.ts");
      const force = req.body?.force === true;
      try {
        const snapshot = await screenContextManager.captureOnDemand(force);
        res.json({
          captured: true,
          timestamp: snapshot.timestamp,
          activeWindow: snapshot.activeWindow,
          hasOcr: !!snapshot.ocrResult,
          ocrSummary: snapshot.ocrResult?.sanitizedText?.slice(0, 500) || "No text detected",
        });
      } catch (err: any) {
        if (err?.message?.includes("PRIVACY_SHIELD_ACTIVE")) {
          return res.status(200).json({
            captured: false,
            privacyShieldActive: true,
            message: err.message,
          });
        }
        throw err;
      }
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // POST /api/multimodal/screen/continuous — control continuous perception loop
  app.post("/api/multimodal/screen/continuous", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const { screenContextManager } = await import("../multimodal/ScreenContextManager.ts");
      const action = String(req.body?.action || "status").toLowerCase();
      const intervalMs = req.body?.intervalMs ? Number(req.body.intervalMs) : undefined;

      if (intervalMs) {
        screenContextManager.setConfig({ intervalMs });
      }

      if (action === "start") {
        screenContextManager.start();
      } else if (action === "stop") {
        screenContextManager.stop();
      } else if (action === "pause") {
        screenContextManager.pause();
      } else if (action === "resume") {
        screenContextManager.resume();
      } else if (action !== "status") {
        return res.status(400).json({ error: "Invalid action. Allowed: start, stop, pause, resume, status." });
      }

      res.json(screenContextManager.getStatus());
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // GET /api/multimodal/screen/continuous/status
  app.get("/api/multimodal/screen/continuous/status", async (_req, res) => {
    try {
      const { screenContextManager } = await import("../multimodal/ScreenContextManager.ts");
      res.json(screenContextManager.getStatus());
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // GET /api/multimodal/window/active
  app.get("/api/multimodal/window/active", async (_req, res) => {
    try {
      const { activeWindowTracker } = await import("../multimodal/ActiveWindowTracker.ts");
      const activeWindow = await activeWindowTracker.getActiveWindow();
      const history = activeWindowTracker.getHistory();
      res.json({
        activeWindow,
        recentTransitions: history.slice(0, 10),
      });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // POST /api/multimodal/code/analyze
  app.post("/api/multimodal/code/analyze", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const { codeScreenshotAnalyzer } = await import("../multimodal/CodeScreenshotAnalyzer.ts");
      const { screenContextManager } = await import("../multimodal/ScreenContextManager.ts");
      let base64 = req.body?.base64;
      const language = req.body?.language;

      let activeWindow;
      if (!base64) {
        const latest = screenContextManager.getLatestSnapshot();
        if (latest?.base64) {
          base64 = latest.base64;
          activeWindow = latest.activeWindow;
        } else {
          try {
            const snap = await screenContextManager.captureOnDemand(true);
            base64 = snap.base64;
            activeWindow = snap.activeWindow;
          } catch {
            return res.status(400).json({ error: "No screen capture available to analyze." });
          }
        }
      }

      const analysis = await codeScreenshotAnalyzer.analyzeScreenshot(base64, language, activeWindow);
      res.json(analysis);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // POST /api/multimodal/document/analyze
  app.post("/api/multimodal/document/analyze", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const docPath = req.body?.path;
      if (!docPath || typeof docPath !== "string") {
        return res.status(400).json({ error: "Document 'path' string parameter is required." });
      }

      const { documentUnderstanding } = await import("../multimodal/DocumentUnderstanding.ts");
      const result = await documentUnderstanding.analyzeDocument(docPath);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // GET /api/multimodal/suggestions
  app.get("/api/multimodal/suggestions", async (req, res) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 5;
      const { contextSuggestionEngine } = await import("../multimodal/ContextSuggestionEngine.ts");
      const suggestions = contextSuggestionEngine.generateSuggestions(undefined, { limit });
      res.json({
        count: suggestions.length,
        suggestions,
      });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // POST /api/multimodal/suggestions/:id/apply
  app.post("/api/multimodal/suggestions/:id/apply", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const { id } = req.params;
      const checkpointToken = req.body?.checkpointToken;
      const { contextSuggestionEngine } = await import("../multimodal/ContextSuggestionEngine.ts");
      const result = await contextSuggestionEngine.applySuggestion(id, checkpointToken);
      res.json(result);
    } catch (e: any) {
      res.status(400).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // ── Settings API ───────────────────────────────────────────────────────
  app.get("/api/settings", async (_req, res) => {

    try {
      res.json(loadSettingsFile());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/settings", async (req, res) => {
    try {
      const patch = req.body;
      if (!patch || typeof patch !== "object") {
        return res
          .status(400)
          .json({ error: "Request body must be a JSON object." });
      }
      const current = loadSettingsFile();
      const next = { ...current, ...patch };
      saveSettingsFile(next);

      // If auto-start toggled, relay to the desktop agent immediately
      if ("autoStart" in patch) {
        callDesktopAgent(
          patch.autoStart ? "enableAutoStart" : "disableAutoStart",
          {},
        ).catch(() => {});
      }

      logCommand(`SETTINGS_UPDATED ${JSON.stringify(patch)}`);
      logJson("info", "settings_updated", { patch });
      res.json(next);
    } catch (e: any) {
      logError(`SETTINGS_SAVE_ERROR: ${e.message}`);
      logJson("error", "settings_save_error", { error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  // ── Config / API-key onboarding ────────────────────────────────────────
  app.get("/api/config", (_req, res) => {
    const meta = resolveApiKeyWithMetadata();
    res.json({
      hasApiKey: meta.isValid && Boolean(meta.key),
      source: meta.source,
      credentialClass: meta.credentialClass,
      masked: meta.masked,
      prefix: meta.prefix,
      length: meta.length,
      isPlaceholder: Boolean(meta.isPlaceholder),
    });
  });

  app.post("/api/config/apikey", requireLocalhost, async (req, res) => {
    if (process.env.NODE_ENV === "production" && process.env.SORA_LAUNCHED_BY !== "electron") {
      return res.status(403).json({
        error: "Forbidden: API key mutation via HTTP is disabled in production. Secrets must be configured strictly in the server environment.",
      });
    }
    try {
      const key: string = (req.body?.apiKey ?? "").toString().trim();
      if (!key) {
        return res.status(400).json({ error: "API key is required." });
      }
      const credClass = classifyCredential(key);
      if (credClass === "OAUTH_ACCESS_TOKEN") {
        return res.status(400).json({
          error:
            "Gemini API credential is invalid or expired. Raw OAuth access tokens (ya29.*) are not supported as Gemini Live API keys. Please configure a valid Gemini API key in Settings.",
        });
      }
      if (key.length < 15 || credClass === "PLACEHOLDER" || credClass === "INVALID") {
        return res.status(400).json({
          error:
            "API key is too short or invalid. Please provide a valid Gemini API key or authorization key.",
        });
      }
      // Validate by listing models — rejects genuine auth failures (expired/revoked AQ. or invalid AIza keys)
      try {
        const test = new GoogleGenAI({ apiKey: key });
        const pager = await test.models.list();
        await pager[Symbol.asyncIterator]().next();
      } catch (e: any) {
        const msg = sanitizeError(String(e?.message || e));
        const isAuthError =
          /API[_ ]?KEY|PERMISSION_DENIED|UNAUTHENTICATED|ACCESS_TOKEN_TYPE_UNSUPPORTED|invalid authentication credentials|Expected OAuth 2 access token|login cookie|invalid|401|403/i.test(
            msg,
          );
        if (isAuthError) {
          logError(`APIKEY_VALIDATION_REJECTED (class=${credClass}, length=${key.length}): ${msg}`);
          logJson("warn", "apikey_validation_rejected", {
            credentialClass: credClass,
            length: key.length,
            error: msg,
          });
          return res.status(400).json({
            error:
              "Gemini API credential is invalid or expired. That credential was rejected by Google (authentication failed). Please check the key in Google AI Studio and try again.",
          });
        }
        logError(`APIKEY_VALIDATION_SOFT_FAIL (saving anyway, class=${credClass}): ${msg}`);
        logJson("warn", "apikey_validation_soft_fail", {
          credentialClass: credClass,
          length: key.length,
          error: msg,
        });
      }
      setGeminiApiKey(key);
      process.env.GEMINI_API_KEY = key;
      delete process.env.GOOGLE_API_KEY;
      delete process.env.GOOGLE_GENAI_API_KEY;
      logCommand(`APIKEY_SAVED (class=${credClass}, length=${key.length})`);
      logJson("info", "apikey_saved", { credentialClass: credClass, length: key.length });
      res.json({ ok: true, hasApiKey: true, credentialClass: credClass });
    } catch (e: any) {
      const sanitized = sanitizeError(e?.message || e);
      logError(`APIKEY_SAVE_ERROR: ${sanitized}`);
      logJson("error", "apikey_save_error", { error: sanitized });
      res
        .status(500)
        .json({ error: sanitized || "Failed to save API key." });
    }
  });

  app.delete("/api/config/apikey", requireLocalhost, (_req, res) => {
    if (process.env.NODE_ENV === "production" && process.env.SORA_LAUNCHED_BY !== "electron") {
      return res.status(403).json({
        error: "Forbidden: API key mutation via HTTP is disabled in production. Secrets must be configured strictly in the server environment.",
      });
    }
    clearGeminiApiKey();
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_GENAI_API_KEY;
    logCommand("APIKEY_CLEARED");
    logJson("info", "apikey_cleared", {});
    res.json({ ok: true, hasApiKey: false });
  });

  // ── Production Health & Readiness Endpoints ──────────────────────────────
  const healthHandler = async (_req: express.Request, res: express.Response) => {
    try {
      const { securityPolicyEngine } = await import("../security/SecurityPolicyEngine.ts");
      const { emergencyStopCoordinator } = await import("../remote/EmergencyStopCoordinator.ts");
      const isLockedDown = securityPolicyEngine.getMode() === "LOCKDOWN";
      const isEmergencyStopped = emergencyStopCoordinator.isActive();
      const hasKey = hasGeminiApiKey();

      const status = isEmergencyStopped || isLockedDown ? "degraded" : "ok";
      res.json({
        status,
        service: "myraa-backend",
        version: "2.0.0",
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || "development",
        hasApiKey: hasKey,
        emergencyStop: isEmergencyStopped,
        securityLockdown: isLockedDown,
      });
    } catch (e: any) {
      res.status(500).json({ status: "error", error: sanitizeError(e?.message || e) });
    }
  };

  app.get("/health", healthHandler);
  app.get("/api/health", healthHandler);

  // ── Agent health proxy ─────────────────────────────────────────────────
  app.get("/api/agent-health", async (_req, res) => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(`${DESKTOP_AGENT_URL}/health`, {
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (r.ok) {
        const d = await r.json();
        res.json({ online: true, tool_count: d.tool_count });
      } else {
        res.json({ online: false });
      }
    } catch {
      res.json({ online: false });
    }
  });

  // ── Logs API ───────────────────────────────────────────────────────────
  app.get("/api/logs/:file", requireLocalhost, async (req, res) => {
    try {
      const fileName = String(req.params.file);
      if (!["commands", "startup", "errors"].includes(fileName)) {
        return res.status(400).json({
          error: "Invalid log file. Use: commands, startup, or errors.",
        });
      }
      const logPath = path.join(LOGS_DIR, `${fileName}.log`);
      if (!fs.existsSync(logPath)) {
        return res.json({ lines: [], file: fileName });
      }
      const content = fs.readFileSync(logPath, "utf-8");
      const lines = content.split("\n").filter(Boolean).slice(-100);
      res.json({ lines, file: fileName });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Proxy scraper ──────────────────────────────────────────────────────
  app.get("/api/proxy", async (req, res) => {
    try {
      const url = req.query.url as string;
      if (!url) {
        return res.status(400).json({ error: "Missing 'url' parameter." });
      }

      console.log(`[Proxy Scraper] Fetching external content for: ${url}`);
      const response = await safeSsrfFetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
        },
      });

      if (!response.ok) {
        throw new Error(`Scraper failed to load page: status ${response.status}`);
      }

      const html = await response.text();

      const titleMatch = html.match(/<title>(.*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : "";

      const headings: string[] = [];
      const headingMatches = html.matchAll(/<h([1-3])\b[^>]*>(.*?)<\/h\1>/gi);
      for (const match of headingMatches) {
        const text = match[2].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 3 && text.length < 120 && !headings.includes(text)) {
          headings.push(text);
        }
      }

      const links: { text: string; href: string }[] = [];
      const linkMatches = html.matchAll(
        /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi,
      );
      for (const match of linkMatches) {
        let href = match[1].trim();
        const text = match[2].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 2 && text.length < 100) {
          if (href.startsWith("/")) {
            try {
              const u = new URL(url);
              href = `${u.protocol}//${u.host}${href}`;
            } catch {}
          }
          if (href.startsWith("http://") || href.startsWith("https://")) {
            links.push({ text, href });
          }
        }
      }

      const paragraphs: string[] = [];
      const paragraphMatches = html.matchAll(/<p\b[^>]*>(.*?)<\/p>/gi);
      for (const match of paragraphMatches) {
        const text = match[1].replace(/<[^>]*>/g, "").trim();
        if (
          text &&
          text.length > 25 &&
          text.length < 600 &&
          !paragraphs.includes(text)
        ) {
          paragraphs.push(text);
        }
      }

      const buttons: string[] = [];
      const buttonMatches = html.matchAll(/<button\b[^>]*>(.*?)<\/button>/gi);
      for (const match of buttonMatches) {
        const text = match[1].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 1 && text.length < 60 && !buttons.includes(text)) {
          buttons.push(text);
        }
      }

      res.json({
        url,
        title,
        headings: headings.slice(0, 15),
        links: links
          .filter((l) => !l.href.includes("javascript:"))
          .slice(0, 30),
        buttons: buttons.slice(0, 15),
        paragraphs: paragraphs.slice(0, 12),
      });
    } catch (err: any) {
      console.error(
        `[Proxy Scraper] Error fetching ${req.query.url}:`,
        err.message,
      );
      res.status(500).json({ error: `Scraper error: ${err.message}` });
    }
  });

  // ── Full HTML proxy ────────────────────────────────────────────────────
  app.get("/api/web-proxy", async (req, res) => {
    let targetUrl = "";
    try {
      const urlParam = req.query.url as string;
      if (!urlParam) {
        return res
          .status(400)
          .send("Myraa Web Proxy Error: Missing target 'url' parameter");
      }

      targetUrl = urlParam.trim();

      if (targetUrl.startsWith("/")) {
        return res
          .status(400)
          .send(
            `Myraa Web Proxy Error: Relative paths are not supported directly (${targetUrl}).`,
          );
      }

      try {
        if (
          !targetUrl.startsWith("http://") &&
          !targetUrl.startsWith("https://")
        ) {
          targetUrl = "https://" + targetUrl;
        }
        const parsed = new URL(targetUrl);
        if (!parsed.hostname || !parsed.hostname.includes(".")) {
          throw new Error(
            "Missing or invalid domain name extension (e.g. .com, .org, .net).",
          );
        }
      } catch (err: any) {
        return res
          .status(400)
          .send(
            `Myraa Web Proxy Error: Invalid URL specified: "${urlParam}". Make sure you enter a valid domain name.`,
          );
      }

      console.log(`[Web Proxy] Routing connection through proxy: ${targetUrl}`);

      let response;
      try {
        response = await safeSsrfFetch(targetUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          },
        });
      } catch (fetchErr: any) {
        console.warn(
          `[Web Proxy Failed Fetch] Target: ${targetUrl} Error:`,
          fetchErr.message,
        );
        return res
          .status(502)
          .send(
            `Myraa Web Proxy Error: Unable to fetch the website "${targetUrl}". The site might be offline, or the URL address is spelled incorrectly. Details: ${fetchErr.message}`,
          );
      }

      if (!response.ok) {
        return res
          .status(response.status)
          .send(
            `Myraa Web Proxy Error: Failed loading remote website. Server returned status: ${response.status} (${response.statusText})`,
          );
      }

      const contentType = response.headers.get("content-type") || "";

      if (!contentType.includes("text/html")) {
        const arrayBuffer = await response.arrayBuffer();
        res.setHeader("Content-Type", contentType);
        return res.send(Buffer.from(arrayBuffer));
      }

      let htmlContents = await response.text();

      const baseUrlTag = `<base href="${targetUrl}" />`;
      const interceptorScript = `
        <script>
          (function() {
            document.addEventListener('click', function(e) {
              var anchor = e.target.closest('a');
              if (anchor) {
                var href = anchor.getAttribute('href');
                if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                  e.preventDefault();
                  try {
                    var resolvedUrl = new URL(href, window.location.href).href;
                    window.parent.postMessage({ type: 'NAVIGATE', url: resolvedUrl }, '*');
                  } catch (err) {
                    console.error("[Proxy Interceptor] Failed resolving link:", err);
                  }
                }
              }
            }, true);

            document.addEventListener('submit', function(e) {
              var form = e.target;
              if (form) {
                e.preventDefault();
                try {
                  var formData = new FormData(form);
                  var params = new URLSearchParams();
                  formData.forEach(function(value, key) {
                    if (typeof value === 'string') {
                      params.append(key, value);
                    }
                  });
                  var actionAttr = form.getAttribute('action') || '';
                  var actionUrl = new URL(actionAttr, window.location.href).href;
                  if (form.method.toLowerCase() === 'get') {
                    actionUrl += (actionUrl.indexOf('?') !== -1 ? '&' : '?') + params.toString();
                  }
                  window.parent.postMessage({ type: 'NAVIGATE', url: actionUrl }, '*');
                } catch (err) {
                  console.error("[Proxy Interceptor] Failed submitting form:", err);
                }
              }
            }, true);

            window.alert = function(msg) { console.log("[Myraa Browser alert bypassed]:", msg); };
            window.confirm = function(msg) { console.log("[Myraa Browser confirm bypassed]:", msg); return true; };
            window.open = function(url) { window.parent.postMessage({ type: 'NAVIGATE', url: url }, '*'); return null; };
          })();
        </script>
      `;

      if (htmlContents.includes("<head>")) {
        htmlContents = htmlContents.replace(
          "<head>",
          `<head>\n${baseUrlTag}\n${interceptorScript}`,
        );
      } else if (htmlContents.includes("<HEAD>")) {
        htmlContents = htmlContents.replace(
          "<HEAD>",
          `<HEAD>\n${baseUrlTag}\n${interceptorScript}`,
        );
      } else {
        htmlContents =
          baseUrlTag + "\n" + interceptorScript + "\n" + htmlContents;
      }

      res.setHeader("Content-Type", "text/html");
      res.setHeader("X-Myraa-Proxied", "true");
      res.removeHeader("X-Frame-Options");
      res.removeHeader("Content-Security-Policy");
      res.removeHeader("content-security-policy");
      res.removeHeader("x-frame-options");

      res.status(200).send(htmlContents);
    } catch (e: any) {
      console.warn(
        "[Web Proxy Exception] Handled internal error:",
        e.message,
      );
      res
        .status(500)
        .send(
          `Myraa Web Proxy Error: Internal error occurred proxying URL "${targetUrl || "unknown"}". Details: ${e.message}`,
        );
    }
  });

  // ── YouTube search proxy ───────────────────────────────────────────────
  app.get("/api/youtube-search", async (req, res) => {
    try {
      const query = req.query.q as string;
      if (!query) {
        return res.status(400).json({ error: "Missing query q" });
      }

      console.log(
        `[YouTube Proxy Search] Searching real YouTube for: "${query}"`,
      );
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en&sp=EgIQAQ%253D%253D`;
      const response = await fetch(searchUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      const html = await response.text();

      const videoList: any[] = [];
      let data: any = null;

      // 1. Try regex extraction of ytInitialData JSON
      const jsonMatch = html.match(/ytInitialData\s*=\s*({.+?});/);
      if (jsonMatch) {
        try {
          data = JSON.parse(jsonMatch[1]);
        } catch {
          // JSON regex captured incomplete or mismatched braces, fallback below
        }
      }

      // 2. Fallback: balanced brace extraction of ytInitialData JSON object
      if (!data) {
        const startIdx = html.indexOf("ytInitialData");
        if (startIdx !== -1) {
          const openBrace = html.indexOf("{", startIdx);
          if (openBrace !== -1) {
            let depth = 0;
            let endBrace = -1;
            const maxScan = Math.min(html.length, openBrace + 3000000);
            for (let i = openBrace; i < maxScan; i++) {
              if (html[i] === "{") depth++;
              else if (html[i] === "}") {
                depth--;
                if (depth === 0) {
                  endBrace = i;
                  break;
                }
              }
            }
            if (endBrace !== -1) {
              try {
                data = JSON.parse(html.slice(openBrace, endBrace + 1));
              } catch (e: any) {
                console.warn("[YouTube Parser Engine] Balanced brace parse failed:", e.message);
              }
            }
          }
        }
      }

      // 3. Extract videos from parsed JSON data structure
      if (data) {
        try {
          const twoCol =
            data.contents?.twoColumnSearchResultsRenderer ||
            data.contents?.twoColumnSearchResultRenderer;
          const sections =
            twoCol?.primaryContents?.sectionListRenderer?.contents || [];

          for (const s of sections) {
            const items = s.itemSectionRenderer?.contents || [];
            for (const item of items) {
              const vr = item.videoRenderer || item.compactVideoRenderer;
              if (vr && vr.videoId) {
                const vId = vr.videoId;
                const title =
                  vr.title?.runs?.map((r: any) => r.text).join("") ||
                  vr.title?.simpleText ||
                  "YouTube Video";
                const thumbnail =
                  vr.thumbnail?.thumbnails?.[vr.thumbnail.thumbnails.length - 1]?.url ||
                  `https://i.ytimg.com/vi/${vId}/hqdefault.jpg`;
                const author =
                  vr.ownerText?.runs?.[0]?.text ||
                  vr.shortBylineText?.runs?.[0]?.text ||
                  vr.longBylineText?.runs?.[0]?.text ||
                  "YouTube Creator";
                const duration =
                  vr.lengthText?.simpleText ||
                  vr.thumbnailOverlays?.find((o: any) => o.thumbnailOverlayTimeStatusRenderer)
                    ?.thumbnailOverlayTimeStatusRenderer?.text?.simpleText ||
                  "Video";
                const views =
                  vr.viewCountText?.simpleText ||
                  vr.shortViewCountText?.simpleText ||
                  "Available Now";
                const published = vr.publishedTimeText?.simpleText || "";

                if (!videoList.some((v) => v.videoId === vId)) {
                  videoList.push({
                    videoId: vId,
                    title,
                    thumbnail,
                    author,
                    duration,
                    views,
                    published,
                  });
                }
              }
            }
          }
        } catch (e: any) {
          console.error(
            "[YouTube Parser Engine] Error traversing JSON:",
            e.message,
          );
        }
      }

      // 4. Fallback if JSON extraction yielded 0 items: regex scrape with title extraction
      if (videoList.length === 0) {
        const itemRegex = /"videoId":"([^"]+)".*?"title":\{"runs":\[\{"text":"([^"]+)"/g;
        let match;
        while ((match = itemRegex.exec(html)) !== null && videoList.length < 15) {
          const id = match[1];
          const rawTitle = match[2];
          if (id && !videoList.some((v) => v.videoId === id)) {
            videoList.push({
              videoId: id,
              title: rawTitle || `YouTube Video: ${id}`,
              thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
              author: "YouTube Creator",
              duration: "Video",
              views: "Available Now",
            });
          }
        }

        // Secondary fallback if still empty: raw videoId regex
        if (videoList.length === 0) {
          const videoRegex = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
          const ids: string[] = [];
          while ((match = videoRegex.exec(html)) !== null && ids.length < 15) {
            const id = match[1];
            if (id && !ids.includes(id)) {
              ids.push(id);
            }
          }
          for (const id of ids) {
            videoList.push({
              videoId: id,
              title: `YouTube Video (${id})`,
              thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
              author: "YouTube Creator",
              duration: "Video",
              views: "Available Now",
            });
          }
        }
      }

      res.setHeader("Cache-Control", "public, max-age=60");
      res.status(200).json({ results: videoList.slice(0, 15) });
    } catch (err: any) {
      console.error("[YouTube Search Error]:", err.message);
      res.status(500).json({ error: err.message, results: [] });
    }
  });

  // ── Phase 9: AI Study Companion REST Endpoints ─────────────────────────

  // POST /api/study/load — load document by workspace path
  app.post("/api/study/load", async (req, res) => {
    try {
      const { path: docPath } = req.body || {};
      if (!docPath) {
        res.status(400).json({ error: "Missing required 'path' parameter in request body." });
        return;
      }
      const { studySessionManager } = await import("../study/StudySessionManager.ts");
      const doc = await studySessionManager.loadDocument(docPath);
      res.status(200).json({
        success: true,
        document: {
          id: doc.id,
          title: doc.title,
          fileType: doc.fileType,
          pageCount: doc.pageCount,
          totalQuestions: doc.totalQuestions,
          totalDiagrams: doc.totalDiagrams,
        },
      });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to load study document.") });
    }
  });

  // POST /api/study/upload — ingest in-memory document buffer
  app.post("/api/study/upload", async (req, res) => {
    try {
      const { filename, base64 } = req.body || {};
      if (!filename || !base64) {
        res.status(400).json({ error: "Missing 'filename' or 'base64' payload in request body." });
        return;
      }
      const buffer = Buffer.from(base64, "base64");
      const { studySessionManager } = await import("../study/StudySessionManager.ts");
      const doc = await studySessionManager.loadDocument(buffer, filename);
      res.status(200).json({
        success: true,
        document: {
          id: doc.id,
          title: doc.title,
          fileType: doc.fileType,
          pageCount: doc.pageCount,
          totalQuestions: doc.totalQuestions,
          totalDiagrams: doc.totalDiagrams,
        },
      });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to upload study document.") });
    }
  });

  // GET /api/study/session — get active study session state
  app.get("/api/study/session", async (_req, res) => {
    try {
      const { studySessionManager } = await import("../study/StudySessionManager.ts");
      const session = studySessionManager.getSessionContext();
      res.status(200).json(session);
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get study session.") });
    }
  });

  // POST /api/study/page — navigate or set current viewed page
  app.post("/api/study/page", async (req, res) => {
    try {
      const { pageNumber, direction } = req.body || {};
      const { studySessionManager } = await import("../study/StudySessionManager.ts");
      let page;
      if (direction === "next") {
        page = studySessionManager.nextPage();
      } else if (direction === "prev") {
        page = studySessionManager.prevPage();
      } else if (pageNumber !== undefined) {
        page = studySessionManager.setCurrentPage(Number(pageNumber));
      } else {
        res.status(400).json({ error: "Specify 'pageNumber' or 'direction' ('next'/'prev')." });
        return;
      }
      res.status(200).json({
        success: true,
        currentPage: page.pageNumber,
        questionsCount: page.questions.length,
        diagramsCount: page.diagrams.length,
        linesCount: page.lineCount,
      });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to set study page.") });
    }
  });

  // GET /api/study/questions — list questions on page
  app.get("/api/study/questions", async (req, res) => {
    try {
      const { studySessionManager } = await import("../study/StudySessionManager.ts");
      const activeDoc = studySessionManager.getActiveDocument();
      if (!activeDoc) {
        res.status(404).json({ error: "No active study document loaded." });
        return;
      }
      const pageNum = req.query.pageNumber
        ? Number(req.query.pageNumber)
        : studySessionManager.getSessionContext().currentPageNumber;
      const page = activeDoc.pages.find((p) => p.pageNumber === pageNum) || studySessionManager.getCurrentPage();
      if (!page) {
        res.status(404).json({ error: `Page ${pageNum} not found in document.` });
        return;
      }
      res.status(200).json({
        pageNumber: page.pageNumber,
        questions: page.questions,
      });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to retrieve questions.") });
    }
  });

  // POST /api/study/question — set focused question
  app.post("/api/study/question", async (req, res) => {
    try {
      const { questionId } = req.body || {};
      if (!questionId) {
        res.status(400).json({ error: "Missing required 'questionId'." });
        return;
      }
      const { studySessionManager } = await import("../study/StudySessionManager.ts");
      const q = studySessionManager.setCurrentQuestion(questionId);
      if (!q) {
        res.status(404).json({ error: `Question '${questionId}' not found.` });
        return;
      }
      res.status(200).json({ success: true, question: q });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to set focused question.") });
    }
  });

  // POST /api/study/explain — get line or section explanation
  app.post("/api/study/explain", async (req, res) => {
    try {
      const { mode, lineNumber, sectionId } = req.body || {};
      const { studySessionManager } = await import("../study/StudySessionManager.ts");
      const { TeachingEngine } = await import("../study/TeachingEngine.ts");
      const page = studySessionManager.getCurrentPage();
      const doc = studySessionManager.getActiveDocument();
      if (!page || !doc) {
        res.status(400).json({ error: "No active study document or page." });
        return;
      }
      if (mode === "section") {
        const result = TeachingEngine.explainSection(page, sectionId || 0, doc.id);
        res.status(200).json({ success: true, mode: "section", result });
      } else {
        const result = TeachingEngine.explainLine(page, Number(lineNumber) || 1, doc.id);
        res.status(200).json({ success: true, mode: "line", result });
      }
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to explain study content.") });
    }
  });

  // POST /api/study/teaching-mode — toggle voice teaching mode
  app.post("/api/study/teaching-mode", async (req, res) => {
    try {
      const { enabled, style } = req.body || {};
      const { studySessionManager } = await import("../study/StudySessionManager.ts");
      const config = studySessionManager.toggleTeachingMode(Boolean(enabled), style);
      res.status(200).json({ success: true, config });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to toggle teaching mode.") });
    }
  });

  // POST /api/study/tutor/mode — set interactive tutor mode (exam/viva/practice/revision/off)
  app.post("/api/study/tutor/mode", async (req, res) => {
    try {
      const { mode, examConfig, vivaConfig, targetQuestions } = req.body || {};
      const { interactiveTutor } = await import("../study/InteractiveTutor.ts");
      const state = interactiveTutor.setMode(mode || "off", {
        examConfig,
        vivaConfig,
        targetQuestions,
      });
      res.status(200).json({ success: true, state });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to set tutor mode.") });
    }
  });

  // POST /api/study/tutor/submit — evaluate student answer
  app.post("/api/study/tutor/submit", async (req, res) => {
    try {
      const { questionId, studentAnswer, timeTakenSeconds } = req.body || {};
      if (!questionId || studentAnswer === undefined) {
        res.status(400).json({ error: "Missing required 'questionId' or 'studentAnswer'." });
        return;
      }
      const { interactiveTutor } = await import("../study/InteractiveTutor.ts");
      const evalResult = await interactiveTutor.evaluateStudentAnswer({
        questionId: String(questionId),
        studentAnswer: String(studentAnswer),
        timeTakenSeconds: timeTakenSeconds ? Number(timeTakenSeconds) : undefined,
      });
      res.status(200).json({ success: true, result: evalResult });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to evaluate answer.") });
    }
  });

  // GET /api/study/tutor/progress — get study progress and weak topics
  app.get("/api/study/tutor/progress", async (req, res) => {
    try {
      const topic = req.query.topic as string | undefined;
      const { studyProgressTracker } = await import("../study/StudyProgressTracker.ts");
      if (topic) {
        const topicProgress = studyProgressTracker.getTopicProgress(topic);
        res.status(200).json({ success: true, topic, progress: topicProgress });
      } else {
        const overall = studyProgressTracker.getOverallProgress();
        res.status(200).json({ success: true, progress: overall });
      }
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get study progress.") });
    }
  });

  // POST /api/study/tutor/revision — start revision session for weak topics
  app.post("/api/study/tutor/revision", async (req, res) => {
    try {
      const { topic, maxQuestions } = req.body || {};
      const { interactiveTutor } = await import("../study/InteractiveTutor.ts");
      const revision = interactiveTutor.startRevisionSession(topic, maxQuestions ? Number(maxQuestions) : 5);
      res.status(200).json({ success: true, revision });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to start revision session.") });
    }
  });

  // POST /api/study/tutor/navigate — safely navigate viewer within document bounds
  app.post("/api/study/tutor/navigate", async (req, res) => {
    try {
      const { targetType, targetId, pageNumber } = req.body || {};
      const { interactiveTutor } = await import("../study/InteractiveTutor.ts");
      const navResult = interactiveTutor.navigateToItem({
        targetType: targetType || "page",
        targetId,
        pageNumber: pageNumber !== undefined ? Number(pageNumber) : undefined,
      });
      res.status(200).json(navResult);
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to navigate study item.") });
    }
  });

  // POST /api/study/tutor/diagram — explain relevant diagram
  app.post("/api/study/tutor/diagram", async (req, res) => {
    try {
      const { questionId, topic, forceVisualCapture } = req.body || {};
      const { interactiveTutor } = await import("../study/InteractiveTutor.ts");
      const explanation = await interactiveTutor.explainRelevantDiagram({
        questionId,
        topic,
        forceVisualCapture: Boolean(forceVisualCapture),
      });
      res.status(200).json({ success: true, diagram: explanation });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to explain diagram.") });
    }
  });

  // ── Phase 9: Stage 3 — AI Companion REST Endpoints ───────────────────────

  // GET /api/study/companion/profile — get course profile
  app.get("/api/study/companion/profile", async (_req, res) => {
    try {
      const { courseProfileManager } = await import("../study/CourseProfileManager.ts");
      const profile = courseProfileManager.getProfile();
      res.status(200).json({ success: true, profile });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get course profile.") });
    }
  });

  // POST /api/study/companion/profile — configure course profile
  app.post("/api/study/companion/profile", async (req, res) => {
    try {
      const { courseProfileManager } = await import("../study/CourseProfileManager.ts");
      const profile = courseProfileManager.setProfile(req.body || {});
      res.status(200).json({ success: true, profile });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to set course profile.") });
    }
  });

  // GET /api/study/companion/syllabus — get syllabus (optional subjectId query)
  app.get("/api/study/companion/syllabus", async (req, res) => {
    try {
      const { courseProfileManager } = await import("../study/CourseProfileManager.ts");
      const subjectId = req.query.subjectId as string | undefined;
      const syllabi = courseProfileManager.getSyllabus(subjectId);
      res.status(200).json({ success: true, syllabi });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get syllabus.") });
    }
  });

  // POST /api/study/companion/syllabus — map subject syllabus
  app.post("/api/study/companion/syllabus", async (req, res) => {
    try {
      const { subjectId, subjectName, chapters } = req.body || {};
      if (!subjectId || !subjectName || !Array.isArray(chapters)) {
        res.status(400).json({ error: "Missing required 'subjectId', 'subjectName', or 'chapters' array." });
        return;
      }
      const { courseProfileManager } = await import("../study/CourseProfileManager.ts");
      const syllabus = courseProfileManager.mapSyllabus(subjectId, subjectName, chapters);
      res.status(200).json({ success: true, syllabus });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to map syllabus.") });
    }
  });

  // PATCH /api/study/companion/syllabus/topic — update topic completion status
  app.patch("/api/study/companion/syllabus/topic", async (req, res) => {
    try {
      const { subjectId, topicId, status } = req.body || {};
      if (!subjectId || !topicId || !status) {
        res.status(400).json({ error: "Missing required 'subjectId', 'topicId', or 'status'." });
        return;
      }
      const { courseProfileManager } = await import("../study/CourseProfileManager.ts");
      const updated = courseProfileManager.updateTopicStatus(subjectId, topicId, status);
      res.status(200).json({ success: true, updated });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to update topic status.") });
    }
  });

  // POST /api/study/companion/research — academic web research
  app.post("/api/study/companion/research", async (req, res) => {
    try {
      const { topic, subject, maxResults } = req.body || {};
      if (!topic) {
        res.status(400).json({ error: "Missing required 'topic'." });
        return;
      }
      const { studyResearchEngine } = await import("../study/StudyResearchEngine.ts");
      const result = await studyResearchEngine.researchStudyTopic(String(topic), {
        subject: subject ? String(subject) : undefined,
        maxResults: maxResults ? Number(maxResults) : undefined,
      });
      res.status(200).json({ success: true, result });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to research study topic.") });
    }
  });

  // POST /api/study/companion/videos — discover educational YouTube videos
  app.post("/api/study/companion/videos", async (req, res) => {
    try {
      const { topic, subject, maxResults } = req.body || {};
      if (!topic) {
        res.status(400).json({ error: "Missing required 'topic'." });
        return;
      }
      const { studyResearchEngine } = await import("../study/StudyResearchEngine.ts");
      const result = await studyResearchEngine.discoverStudyVideos(String(topic), {
        subject: subject ? String(subject) : undefined,
        maxResults: maxResults ? Number(maxResults) : undefined,
      });
      res.status(200).json({ success: true, ...result });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to discover study videos.") });
    }
  });

  // POST /api/study/companion/analyze-questions — previous question papers analysis
  app.post("/api/study/companion/analyze-questions", async (req, res) => {
    try {
      const { paperTitle, rawText } = req.body || {};
      const { studyResearchEngine } = await import("../study/StudyResearchEngine.ts");
      const analysis = await studyResearchEngine.analyzePreviousQuestions({ paperTitle, rawText });
      res.status(200).json({ success: true, analysis });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to analyze previous questions.") });
    }
  });

  // POST /api/study/companion/plan — generate personalized study plan
  app.post("/api/study/companion/plan", async (req, res) => {
    try {
      const { dailyHours, targetExamDate, planName } = req.body || {};
      const { courseProfileManager } = await import("../study/CourseProfileManager.ts");
      const plan = courseProfileManager.generateStudyPlan({
        dailyHours: dailyHours ? Number(dailyHours) : undefined,
        targetExamDate,
        planName,
      });
      res.status(200).json({ success: true, plan });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to generate study plan.") });
    }
  });

  // GET /api/study/companion/plan — get current study plan
  app.get("/api/study/companion/plan", async (_req, res) => {
    try {
      const { courseProfileManager } = await import("../study/CourseProfileManager.ts");
      const plan = courseProfileManager.getStudyPlan();
      res.status(200).json({ success: true, plan });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get study plan.") });
    }
  });

  // GET /api/study/companion/recommendations — weak topic study recommendations
  app.get("/api/study/companion/recommendations", async (_req, res) => {
    try {
      const { studyResearchEngine } = await import("../study/StudyResearchEngine.ts");
      const recommendations = studyResearchEngine.getWeakTopicRecommendations();
      res.status(200).json({ success: true, count: recommendations.length, recommendations });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get recommendations.") });
    }
  });

  // GET /api/study/companion/daily-session — get or initialize today's daily session
  app.get("/api/study/companion/daily-session", async (req, res) => {
    try {
      const date = req.query.date as string | undefined;
      const { courseProfileManager } = await import("../study/CourseProfileManager.ts");
      const session = courseProfileManager.createOrGetDailySession(date);
      res.status(200).json({ success: true, session });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get daily session.") });
    }
  });

  // PATCH /api/study/companion/daily-session/target — update target completed state
  app.patch("/api/study/companion/daily-session/target", async (req, res) => {
    try {
      const { targetId, completed, date } = req.body || {};
      if (!targetId) {
        res.status(400).json({ error: "Missing required 'targetId'." });
        return;
      }
      const { courseProfileManager } = await import("../study/CourseProfileManager.ts");
      const session = courseProfileManager.updateDailyTarget(String(targetId), Boolean(completed), date);
      res.status(200).json({ success: true, session });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to update daily target.") });
    }
  });

  // POST /api/study/companion/daily-session/complete — complete daily session
  app.post("/api/study/companion/daily-session/complete", async (req, res) => {
    try {
      const { notes, date } = req.body || {};
      const { courseProfileManager } = await import("../study/CourseProfileManager.ts");
      const session = courseProfileManager.completeDailySession(notes, date);
      res.status(200).json({ success: true, session });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to complete daily session.") });
    }
  });

  // ── Phase 10A: Security Foundation REST Endpoints ────────────────────────
  // POST /api/security/session — Establish secure session with access + refresh token
  app.post("/api/security/session", async (req, res) => {
    try {
      const { deviceId, identityId, role } = req.body || {};
      const ipAddress = req.socket?.remoteAddress || req.ip || "unknown";
      const userAgent = req.headers["user-agent"] || "unknown";

      const { identityAuthManager } = await import("../security/IdentityAuthManager.ts");
      const result = identityAuthManager.createSession({
        deviceId: deviceId || "default_device",
        identityId: identityId || "user",
        role: role || "standard",
        ipAddress,
        userAgent,
      });

      res.status(200).json({ success: true, ...result });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to create security session.") });
    }
  });

  // POST /api/security/refresh — Rotate refresh token with replay attack detection
  app.post("/api/security/refresh", async (req, res) => {
    try {
      const { refreshToken } = req.body || {};
      const ipAddress = req.socket?.remoteAddress || req.ip || "unknown";

      if (!refreshToken) {
        res.status(400).json({ error: "Missing required 'refreshToken'." });
        return;
      }

      const { identityAuthManager } = await import("../security/IdentityAuthManager.ts");
      const result = identityAuthManager.refreshSession(refreshToken, ipAddress);
      res.status(200).json({ success: true, ...result });
    } catch (err: any) {
      const status = err?.message?.includes("REPLAY") ? 403 : 400;
      res.status(status).json({ error: sanitizeError(err?.message || "Failed to refresh session.") });
    }
  });

  // POST /api/security/revoke — Revoke a session or device
  app.post("/api/security/revoke", async (req, res) => {
    try {
      const { sessionId, deviceId, reason } = req.body || {};
      const { identityAuthManager } = await import("../security/IdentityAuthManager.ts");

      if (sessionId) {
        const ok = identityAuthManager.revokeSession(sessionId, reason || "Revoked by operator");
        res.status(200).json({ success: ok, revokedSessionId: sessionId });
        return;
      }

      if (deviceId) {
        const count = identityAuthManager.revokeDevice(deviceId, reason || "Device revoked by operator");
        res.status(200).json({ success: count > 0, revokedDeviceSessions: count });
        return;
      }

      res.status(400).json({ error: "Either 'sessionId' or 'deviceId' must be provided." });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to revoke.") });
    }
  });

  // POST /api/security/step-up/request — Request step-up challenge PIN for sensitive action
  app.post("/api/security/step-up/request", async (req, res) => {
    try {
      const { sessionId, action } = req.body || {};
      if (!sessionId || !action) {
        res.status(400).json({ error: "Missing required 'sessionId' or 'action'." });
        return;
      }
      const { identityAuthManager } = await import("../security/IdentityAuthManager.ts");
      const challenge = identityAuthManager.requestStepUpChallenge(sessionId, action);
      res.status(200).json({ success: true, ...challenge });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to request step-up challenge.") });
    }
  });

  // POST /api/security/step-up/verify — Verify step-up challenge PIN
  app.post("/api/security/step-up/verify", async (req, res) => {
    try {
      const { challengeId, pin } = req.body || {};
      if (!challengeId || !pin) {
        res.status(400).json({ error: "Missing required 'challengeId' or 'pin'." });
        return;
      }
      const { identityAuthManager } = await import("../security/IdentityAuthManager.ts");
      const ok = identityAuthManager.verifyStepUpChallenge(challengeId, pin);
      if (!ok) {
        res.status(403).json({ success: false, error: "STEP_UP_FAILED: Invalid or expired PIN." });
        return;
      }
      res.status(200).json({ success: true, verified: true });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to verify step-up PIN.") });
    }
  });

  // GET /api/security/audit — Fetch tamper-evident audit logs (localhost only)
  app.get("/api/security/audit", requireLocalhost, async (req, res) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const { securityAuditLogger } = await import("../security/SecurityAuditLogger.ts");
      const events = securityAuditLogger.getRecentEvents(limit);
      const integrity = securityAuditLogger.verifyChainIntegrity();
      res.status(200).json({ success: true, integrity, count: events.length, events });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to fetch audit log.") });
    }
  });

  // GET /api/security/policy — Fetch active security policy and risk engine state
  app.get("/api/security/policy", async (_req, res) => {
    try {
      const { securityPolicyEngine } = await import("../security/SecurityPolicyEngine.ts");
      res.status(200).json({
        success: true,
        mode: securityPolicyEngine.getMode(),
      });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get security policy.") });
    }
  });

  // POST /api/security/policy/mode — Update security policy mode (localhost only)
  app.post("/api/security/policy/mode", requireLocalhost, async (req, res) => {
    try {
      const { mode } = req.body || {};
      if (!["BALANCED", "STRICT", "PARANOID", "LOCKDOWN"].includes(mode)) {
        res.status(400).json({ error: "Invalid mode. Must be BALANCED, STRICT, PARANOID, or LOCKDOWN." });
        return;
      }
      const { securityPolicyEngine } = await import("../security/SecurityPolicyEngine.ts");
      securityPolicyEngine.setMode(mode);
      res.status(200).json({ success: true, mode });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to set security mode.") });
    }
  });

  // POST /api/security/mode — Alias to /api/security/policy/mode
  app.post("/api/security/mode", requireLocalhost, async (req, res) => {
    try {
      const { mode } = req.body || {};
      if (!["BALANCED", "STRICT", "PARANOID", "LOCKDOWN"].includes(mode)) {
        res.status(400).json({ error: "Invalid mode. Must be BALANCED, STRICT, PARANOID, or LOCKDOWN." });
        return;
      }
      const { securityPolicyEngine } = await import("../security/SecurityPolicyEngine.ts");
      securityPolicyEngine.setMode(mode);
      res.status(200).json({ success: true, mode });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to set security mode.") });
    }
  });

  // GET /api/security/alerts — Fetch sanitized security alerts
  app.get("/api/security/alerts", async (req, res) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const risk = req.query.risk as any;
      const unacknowledgedOnly = req.query.unacknowledged === "true";
      const { securityAlertManager } = await import("../security/SecurityAlertManager.ts");
      const alerts = securityAlertManager.getAlerts(limit, { risk, unacknowledgedOnly });
      res.status(200).json({ success: true, count: alerts.length, alerts });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to fetch security alerts.") });
    }
  });

  // POST /api/security/alerts/acknowledge — Acknowledge an alert by ID
  app.post("/api/security/alerts/acknowledge", async (req, res) => {
    try {
      const { alertId } = req.body || {};
      if (!alertId) {
        res.status(400).json({ error: "alertId is required." });
        return;
      }
      const { securityAlertManager } = await import("../security/SecurityAlertManager.ts");
      const ok = securityAlertManager.acknowledgeAlert(alertId);
      if (!ok) {
        res.status(404).json({ error: "Alert not found." });
        return;
      }
      res.status(200).json({ success: true, acknowledged: true, alertId });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to acknowledge alert.") });
    }
  });

  // GET /api/security/events — Fetch recent normalized security events
  app.get("/api/security/events", async (req, res) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const { securityEventStream } = await import("../security/SecurityEventStream.ts");
      const events = securityEventStream.getRecentEvents(limit);
      res.status(200).json({ success: true, count: events.length, events });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to fetch security events.") });
    }
  });

  // GET /api/security/status — Comprehensive security monitoring status
  app.get("/api/security/status", async (_req, res) => {
    try {
      const { securityPolicyEngine } = await import("../security/SecurityPolicyEngine.ts");
      const { securityMonitor } = await import("../security/SecurityMonitor.ts");
      const { securityAlertManager } = await import("../security/SecurityAlertManager.ts");
      const { securityAuditLogger } = await import("../security/SecurityAuditLogger.ts");

      const recentThreats = securityMonitor.getDetectedThreats(10);
      const activeAlerts = securityAlertManager.getAlerts(10, { unacknowledgedOnly: true });
      const chainStatus = securityAuditLogger.verifyChainIntegrity();

      res.status(200).json({
        success: true,
        mode: securityPolicyEngine.getMode(),
        isLockdown: securityPolicyEngine.getMode() === "LOCKDOWN",
        auditChainIntact: chainStatus.valid,
        activeAlertsCount: activeAlerts.length,
        recentThreatsCount: recentThreats.length,
        recentThreats,
        activeAlerts,
      });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to fetch security status.") });
    }
  });

  // ── Phase 10D: Automatic Containment & Integrity REST Endpoints ───────────

  // GET /api/security/containments — List active/historical threat containments and disabled tools
  app.get("/api/security/containments", async (_req, res) => {
    try {
      const { threatContainmentManager } = await import("../security/ThreatContainmentManager.ts");
      const { securityPolicyEngine } = await import("../security/SecurityPolicyEngine.ts");
      const active = threatContainmentManager.getActiveContainments();
      const all = threatContainmentManager.getAllContainments();
      const disabledTools = securityPolicyEngine.getDisabledTools();

      res.status(200).json({
        success: true,
        activeCount: active.length,
        active,
        history: all,
        disabledTools,
      });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to fetch containments.") });
    }
  });

  // POST /api/security/containments/lift — Lift an active containment (Admin only)
  app.post("/api/security/containments/lift", async (req: any, res) => {
    try {
      const { containmentId, stepUpPin } = req.body || {};
      if (!containmentId) {
        res.status(400).json({ error: "containmentId is required." });
        return;
      }

      const isLocal =
        req.ip === "127.0.0.1" ||
        req.ip === "::1" ||
        req.ip === "localhost" ||
        req.hostname === "localhost" ||
        req.headers["host"]?.includes("localhost") ||
        req.headers["host"]?.includes("127.0.0.1");

      const operatorContext = {
        identityId: "admin",
        role: "admin" as const,
        ipAddress: req.ip || "127.0.0.1",
        isLocal,
        isStepUpAuthenticated: Boolean(stepUpPin),
      };

      const { threatContainmentManager } = await import("../security/ThreatContainmentManager.ts");
      const result = await threatContainmentManager.liftContainment(containmentId, operatorContext, stepUpPin);

      if (!result.success) {
        res.status(403).json({ success: false, error: result.reason });
        return;
      }

      res.status(200).json({ success: true, containmentId });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to lift containment.") });
    }
  });

  // GET /api/security/integrity — Get integrity monitor status & baseline manifest info
  app.get("/api/security/integrity", async (_req, res) => {
    try {
      const { integrityMonitor } = await import("../security/IntegrityMonitor.ts");
      const baseline = integrityMonitor.getBaselineManifest();
      const lastReport = integrityMonitor.getLastReport();

      res.status(200).json({
        success: true,
        baselineValid: Boolean(baseline && baseline.signature),
        monitoredFileCount: baseline ? Object.keys(baseline.files).length : 0,
        lastReport,
      });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to fetch integrity status.") });
    }
  });

  // POST /api/security/integrity/verify — Trigger manual integrity scan
  app.post("/api/security/integrity/verify", async (req, res) => {
    try {
      const { quarantineOnTamper } = req.body || {};
      const { integrityMonitor } = await import("../security/IntegrityMonitor.ts");
      const report = await integrityMonitor.verifyIntegrity({
        quarantineOnTamper: quarantineOnTamper !== false,
      });
      res.status(200).json({ success: true, report });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Integrity verification failed.") });
    }
  });

  // POST /api/security/integrity/rebaseline — Re-establish trusted cryptographic baseline (Admin only)
  app.post("/api/security/integrity/rebaseline", async (req: any, res) => {
    try {
      const { confirmationToken } = req.body || {};
      const isLocal =
        req.ip === "127.0.0.1" ||
        req.ip === "::1" ||
        req.ip === "localhost" ||
        req.hostname === "localhost" ||
        req.headers["host"]?.includes("localhost") ||
        req.headers["host"]?.includes("127.0.0.1");

      const operatorContext = {
        identityId: "admin",
        role: "admin" as const,
        ipAddress: req.ip || "127.0.0.1",
        isLocal,
        isStepUpAuthenticated: Boolean(confirmationToken),
      };

      const { integrityMonitor } = await import("../security/IntegrityMonitor.ts");
      const result = await integrityMonitor.rebaseline(operatorContext, confirmationToken);

      if (!result.success) {
        res.status(403).json({ success: false, error: result.reason });
        return;
      }

      res.status(200).json({ success: true, manifest: result.manifest });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Re-baseline failed.") });
    }
  });

  // ── Global Sanitized Error Handling Middleware ───────────────────────────
  // Guarantees fail-closed error responses and zero stack trace / path leakage to clients
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof err.status === "number" && err.status >= 400 && err.status < 600 ? err.status : 500;
    const safeMessage = sanitizeError(err.message || "Internal Server Error");
    logError(`[HttpGateway] Unhandled error: ${safeMessage}`);
    res.status(status).json({
      error: safeMessage,
    });
  });

  return app;
}

