import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import path from "path";
import fs from "fs";
import { createHttpApp } from "../../backend/gateway/HttpGateway.ts";

describe("Frontend Static Asset Serving & CORS Verification", () => {
  let server: http.Server;
  let baseUrl: string;
  let serverHost: string;
  const distPath = path.join(process.cwd(), "dist");
  const distAssetsPath = path.join(distPath, "assets");

  beforeAll(async () => {
    process.env.NODE_ENV = "production";
    delete process.env.CORS_ORIGINS;
    process.env.RENDER_EXTERNAL_HOSTNAME = "myraa-ai-q0h3.onrender.com";
    process.env.RENDER_EXTERNAL_URL = "https://myraa-ai-q0h3.onrender.com";

    const app = createHttpApp();
    const { default: express } = await import("express");

    // Primary: serve compiled production frontend assets
    if (fs.existsSync(distAssetsPath)) {
      app.use(
        "/assets",
        express.static(distAssetsPath, {
          maxAge: "1y",
          immutable: true,
          fallthrough: true,
        }),
      );
    }

    // Secondary: serve root dist files
    app.use(
      express.static(distPath, {
        fallthrough: true,
      }),
    );

    // SPA fallback: strictly exclude /assets/* and /api/*
    app.get("*", (req, res) => {
      if (req.path.startsWith("/assets/") || req.path.startsWith("/api/")) {
        res.status(404).type("text/plain").send("Not Found");
        return;
      }
      res.sendFile(path.join(distPath, "index.html"));
    });

    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const addr = server.address() as any;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    serverHost = `127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    delete process.env.RENDER_EXTERNAL_HOSTNAME;
    delete process.env.RENDER_EXTERNAL_URL;
    if (server) {
      if (typeof (server as any).closeAllConnections === "function") {
        (server as any).closeAllConnections();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("1. build output contains valid JS and CSS bundles", () => {
    expect(fs.existsSync(distPath)).toBe(true);
    expect(fs.existsSync(path.join(distPath, "index.html"))).toBe(true);
    const files = fs.readdirSync(distAssetsPath);
    const jsFiles = files.filter((f) => f.startsWith("index-") && f.endsWith(".js"));
    const cssFiles = files.filter((f) => f.startsWith("index-") && f.endsWith(".css"));

    expect(jsFiles.length).toBeGreaterThanOrEqual(1);
    expect(cssFiles.length).toBeGreaterThanOrEqual(1);
  });

  it("2. serves JavaScript assets with HTTP 200 and javascript MIME type", async () => {
    const files = fs.readdirSync(distAssetsPath);
    const jsFile = files.find((f) => f.startsWith("index-") && f.endsWith(".js"))!;

    const res = await fetch(`${baseUrl}/assets/${jsFile}`);
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") || "";
    expect(contentType).toMatch(/(javascript|ecmascript)/i);
  });

  it("3. serves CSS assets with HTTP 200 and text/css MIME type", async () => {
    const files = fs.readdirSync(distAssetsPath);
    const cssFile = files.find((f) => f.startsWith("index-") && f.endsWith(".css"))!;

    const res = await fetch(`${baseUrl}/assets/${cssFile}`);
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") || "";
    expect(contentType).toMatch(/text\/css/i);
  });

  it("4. hashed production assets use immutable caching headers", async () => {
    const files = fs.readdirSync(distAssetsPath);
    const jsFile = files.find((f) => f.startsWith("index-") && f.endsWith(".js"))!;

    const res = await fetch(`${baseUrl}/assets/${jsFile}`);
    expect(res.status).toBe(200);
    const cacheControl = res.headers.get("cache-control") || "";
    expect(cacheControl).toContain("immutable");
    expect(cacheControl).toContain("max-age=31536000");
  });

  it("5. permits browser same-origin request with Origin header to load assets without 403", async () => {
    const files = fs.readdirSync(distAssetsPath);
    const jsFile = files.find((f) => f.startsWith("index-") && f.endsWith(".js"))!;

    // Browser sending Origin header matching server host
    const res = await fetch(`${baseUrl}/assets/${jsFile}`, {
      headers: { Origin: `http://${serverHost}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(`http://${serverHost}`);
  });

  it("6. permits canonical Render external HTTPS Origin header to load assets without 403", async () => {
    const files = fs.readdirSync(distAssetsPath);
    const cssFile = files.find((f) => f.startsWith("index-") && f.endsWith(".css"))!;

    // Browser sending Origin header matching Render cloud host
    const res = await fetch(`${baseUrl}/assets/${cssFile}`, {
      headers: { Origin: "https://myraa-ai-q0h3.onrender.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://myraa-ai-q0h3.onrender.com");
    expect(res.headers.get("content-type")).toMatch(/text\/css/i);
  });

  it("7. rejects HTTP origin with the same hostname (scheme mismatch) with 403", async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      headers: { Origin: "http://myraa-ai-q0h3.onrender.com" },
    });
    expect(res.status).toBe(403);
    const data = await res.json() as any;
    expect(data.error).toContain("CORS_ORIGIN_DENIED");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("8. rejects different port with the same hostname with 403", async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      headers: { Origin: "https://myraa-ai-q0h3.onrender.com:8443" },
    });
    expect(res.status).toBe(403);
    const data = await res.json() as any;
    expect(data.error).toContain("CORS_ORIGIN_DENIED");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("9. rejects untrusted cross-origin request with 403 CORS_ORIGIN_DENIED", async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      headers: { Origin: "https://malicious-cross-origin.com" },
    });
    expect(res.status).toBe(403);
    const data = await res.json() as any;
    expect(data.error).toContain("CORS_ORIGIN_DENIED");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("10. rejects malformed origins with 403 CORS_ORIGIN_DENIED", async () => {
    const malformedOrigins = ["not-a-valid-url", "javascript:alert(1)", "://bad-url", "http://", "ftp://evil.com"];
    for (const badOrigin of malformedOrigins) {
      const res = await fetch(`${baseUrl}/api/config`, {
        headers: { Origin: badOrigin },
      });
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("10b. rejects attacker-controlled Host header with matching Origin (host spoofing defense) with 403", async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      headers: {
        Host: "attacker-controlled-host.com",
        Origin: "https://attacker-controlled-host.com",
      },
    });
    expect(res.status).toBe(403);
    const data = await res.json() as any;
    expect(data.error).toContain("CORS_ORIGIN_DENIED");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("11. SPA fallback returns 404 for missing /assets/* requests and does NOT return index.html", async () => {
    const res = await fetch(`${baseUrl}/assets/missing-file-${Date.now()}.css`);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("<!doctype html>");
    expect(text).toBe("Not Found");
  });

  it("12. SPA fallback returns 404 for unhandled /api/* requests and does NOT return index.html", async () => {
    const res = await fetch(`${baseUrl}/api/non_existent_route_${Date.now()}`);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("<!doctype html>");
  });

  it("13. SPA fallback returns index.html for client application routes", async () => {
    const res = await fetch(`${baseUrl}/workspace`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<!doctype html>");
    expect(text).toContain("MYRAA");
  });

  it("14. API authentication and authorization remain fully enforced", async () => {
    // Protected API route without token is rejected with 401
    const res = await fetch(`${baseUrl}/api/memories`);
    expect(res.status).toBe(401);
  });
});
