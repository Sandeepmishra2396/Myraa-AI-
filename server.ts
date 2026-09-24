/**
 * MYRAA — Entry Point (server.ts)
 *
 * Thin wiring layer. Responsibilities:
 *   1. Load .env + log key resolution
 *   2. Create Express app via HttpGateway
 *   3. Create http.Server + WebSocketServer
 *   4. Wire /live WebSocket to ConversationManager
 *   5. Wire loggers into TaskManager and GeminiSessionFactory
 *   6. Mount Vite (dev) or static dist (prod)
 *   7. Listen on port 3000
 *   8. Boot-probe the desktop agent
 *
 * No business logic lives here.
 */

import http from "http";
import path from "path";
import fs from "fs";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";

import { logKeyResolution } from "./server_paths.ts";
import {
  createHttpApp,
  logCommand,
  logStartup,
  logError,
  logJson,
} from "./src/backend/gateway/HttpGateway.ts";
import { ConversationManager } from "./src/backend/conversation/ConversationManager.ts";
import {
  initTaskManagerLoggers,
  ensureDesktopAgent,
} from "./src/backend/tasks/TaskManager.ts";
import { initGeminiLoggers } from "./src/backend/ai/GeminiSessionFactory.ts";
import { companionCoordinator } from "./src/backend/companion/CompanionCoordinator.ts";
import { emergencyStopCoordinator } from "./src/backend/remote/EmergencyStopCoordinator.ts";

dotenv.config();
logKeyResolution();

// Wire loggers into modules that need them
initTaskManagerLoggers(logCommand, logStartup, logError, logJson);
initGeminiLoggers(logStartup, logError, logJson);

async function startServer() {
  const app = createHttpApp();
  const PORT = parseInt(process.env.PORT || "3000", 10);
  const HOST = process.env.HOST || "0.0.0.0";

  let server: http.Server | import("https").Server;
  const tlsCertPath = process.env.MYRAA_TLS_CERT;
  const tlsKeyPath = process.env.MYRAA_TLS_KEY;

  if (tlsCertPath && tlsKeyPath && fs.existsSync(tlsCertPath) && fs.existsSync(tlsKeyPath)) {
    const https = await import("https");
    server = https.createServer(
      {
        cert: fs.readFileSync(tlsCertPath),
        key: fs.readFileSync(tlsKeyPath),
      },
      app,
    );
    console.log("[Server] Production native HTTPS/TLS enabled via certificate files.");
  } else {
    server = http.createServer(app);
  }

  // WebSocket server — upgrades /live and /remote-live connections
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (request, socket, head) => {
    try {
      const url = new URL(
        request.url || "",
        `http://${request.headers.host}`,
      );
      const pathname = url.pathname;
      if (pathname === "/live" || pathname === "/remote-live") {
        const forwardedFor = request.headers["x-forwarded-for"];
        const ip = typeof forwardedFor === "string"
          ? forwardedFor.split(",")[0].trim()
          : (socket as any).remoteAddress || request.socket?.remoteAddress || "";
        const isLocal = !forwardedFor && (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1");

        // Validate Transport Security: Non-localhost WebSocket connections must use WSS
        if (!isLocal) {
          const { dataProtectionService } = await import("./src/backend/security/DataProtectionService.ts");
          const proto = request.headers["x-forwarded-proto"] || ((socket as any).encrypted ? "wss" : "ws");
          const transportCheck = dataProtectionService.validateTransport({
            protocol: String(proto),
            ipAddress: ip,
            targetName: pathname,
          });
          if (!transportCheck.secure) {
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            socket.destroy();
            return;
          }
        }

        // Extract token from Sec-WebSocket-Protocol or query parameter
        let token: string | null = null;
        const protocols = request.headers["sec-websocket-protocol"];
        if (protocols) {
          const parts = protocols.split(",").map((s) => s.trim());
          const authIdx = parts.indexOf("myraa-auth");
          if (authIdx >= 0 && parts[authIdx + 1]) {
            token = parts[authIdx + 1];
          }
        }
        if (!token && url.searchParams.has("token")) {
          token = url.searchParams.get("token");
        }

        // Non-localhost connections MUST present an authenticated device token
        let remoteDevice = null;
        if (!isLocal || token) {
          if (!token) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
          }
          const { remoteSecurityCoordinator } = await import("./src/backend/security/RemoteSecurityCoordinator.ts");
          const auth = await remoteSecurityCoordinator.authenticateRemoteCredential(token, ip, request.headers["user-agent"]);
          if (!auth.authenticated || !auth.device) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
          }
          remoteDevice = auth.device;
        }

        // Reject new connections if Security Lockdown is active
        const { securityPolicyEngine } = await import("./src/backend/security/SecurityPolicyEngine.ts");
        if (securityPolicyEngine.getMode() === "LOCKDOWN") {
          socket.write("HTTP/1.1 423 Locked\r\n\r\n");
          socket.destroy();
          return;
        }

        // Reject new connections if Emergency Stop is currently active
        const { emergencyStopCoordinator } = await import("./src/backend/remote/EmergencyStopCoordinator.ts");
        if (emergencyStopCoordinator.isActive()) {
          socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
          socket.destroy();
          return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          (ws as any).remoteDevice = remoteDevice;
          wss.emit("connection", ws, request);
        });
      } else {
        socket.destroy();
      }
    } catch {
      socket.destroy();
    }
  });

  const conversationManager = new ConversationManager();

  wss.on("connection", async (clientWs, request: any) => {
    const remoteDevice = (clientWs as any).remoteDevice;
    if (remoteDevice) {
      const { remoteSessionManager } = await import("./src/backend/remote/RemoteSessionManager.ts");
      remoteSessionManager.registerClient(
        clientWs,
        remoteDevice,
        request?.socket?.remoteAddress || "unknown",
        request?.headers?.["user-agent"] || "unknown",
      );
    }

    // Wire emergency stop broadcast
    const { emergencyStopCoordinator } = await import("./src/backend/remote/EmergencyStopCoordinator.ts");
    const unregisterEmergency = emergencyStopCoordinator.registerBroadcast((payload) => {
      if (clientWs.readyState === 1) {
        try {
          clientWs.send(typeof payload === "string" ? payload : JSON.stringify(payload));
        } catch { /* ignore dropped frame */ }
      }
    });

    // Wire proactive companion broadcasts to connected client
    const unregisterBroadcast = companionCoordinator.registerClientBroadcast((payload) => {
      if (clientWs.readyState === 1) {
        try {
          clientWs.send(typeof payload === "string" ? payload : JSON.stringify(payload));
        } catch { /* ignore dropped frame */ }
      }
    });

    clientWs.on("close", () => {
      unregisterEmergency();
      unregisterBroadcast();
    });

    await conversationManager.handleConnection(clientWs);
  });

  // Serve custom static assets
  app.use(
    "/assets",
    (await import("express")).default.static(
      path.join(process.cwd(), "assets"),
    ),
  );

  // Vite dev middleware (dev) or static dist (prod)
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        watch: {
          ignored: [
            "**/logs/**",
            "**/desktop_agent/**",
            "**/Desktop/**",
            "**/Downloads/**",
            "**/*.json",
            "**/*.log",
            "**/*.txt",
            "**/*.pyc",
            "**/scratch/**",
          ],
        },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const { default: express } = await import("express");
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, HOST, () => {
    const isTls = Boolean(tlsCertPath && tlsKeyPath && fs.existsSync(tlsCertPath) && fs.existsSync(tlsKeyPath));
    const protocol = isTls ? "https" : "http";
    logStartup(`MYRAA V2 server started on ${protocol}://${HOST}:${PORT}`);
    console.log(`[Server] Running on ${protocol}://${HOST}:${PORT}`);
    ensureDesktopAgent().catch((e) =>
      console.warn(`[Desktop Agent] Boot probe failed: ${e?.message || e}`),
    );
    companionCoordinator.start().catch((e) =>
      console.warn(`[Companion] Startup error: ${e?.message || e}`),
    );
    emergencyStopCoordinator.init().catch((e) =>
      console.warn(`[EmergencyStop] Init error: ${e?.message || e}`),
    );
  });

  let isShuttingDown = false;
  const shutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[Server] Graceful shutdown initiated (${signal})...`);
    logStartup(`[Server] Graceful shutdown initiated (${signal}).`);

    // 1. Stop background task coordinators
    try {
      companionCoordinator.stop();
    } catch { /* ignore */ }

    // 2. Disconnect active remote WebSocket sessions gracefully
    try {
      wss.clients.forEach((client) => {
        if (client.readyState === 1) {
          try {
            client.close(1001, "Server shutting down");
          } catch { /* ignore */ }
        }
      });
      wss.close();
    } catch { /* ignore */ }

    // 3. Close HTTP server
    server.close(() => {
      console.log("[Server] HTTP and WebSocket listeners closed cleanly.");
      logStartup("[Server] HTTP and WebSocket listeners closed cleanly.");
      process.exit(0);
    });

    // Force exit if connection drain exceeds 5 seconds
    setTimeout(() => {
      console.warn("[Server] Forced shutdown timeout reached. Terminating.");
      process.exit(0);
    }, 5000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason: any) => {
    const msg = reason?.message || String(reason);
    logError(`[Process] Unhandled promise rejection: ${msg}`);
  });

  process.on("uncaughtException", (error: Error) => {
    logError(`[Process] Uncaught exception: ${error.message}`);
    shutdown("uncaughtException");
  });
}

startServer().catch((error) => {
  console.error("Failed to start server startup sequence:", error);
});
