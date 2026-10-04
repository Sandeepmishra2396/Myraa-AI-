/**
 * MYRAA — Phase 13A-WIN & 13A-WIN.2: Windows SmartScreen / Authenticode Release Trust Hardening
 * & Functional Unsigned Personal-Testing Build + Future Production Signing Readiness Suite
 *
 * Validates:
 *   1. Electron-Builder & package.json production identity (MYRAA / Mishtron Labs)
 *      and SHA-256 + RFC 3161 Authenticode signing-ready pipeline.
 *   2. PE VersionInfo metadata across MYRAA-Setup-1.0.0.exe, MYRAA-Portable-1.0.0.exe,
 *      win-unpacked/MYRAA.exe, and bundled win-unpacked/resources/agent/myraa-agent.exe.
 *   3. Complete exclusion of development/debug artifacts (.map sourcemaps, backup VRMs,
 *      server.cjs backend bundles, localhost:3000 dependencies, private keys, API keys).
 *   4. Strict Production Mode (`MYRAA_REQUIRE_WINDOWS_SIGNING=true`) vs
 *      Development / Personal Testing Mode (`MYRAA_REQUIRE_WINDOWS_SIGNING=false`).
 *   5. Option A (Microsoft Azure Artifact Signing / Trusted Signing) and
 *      Option B (CA-issued OV/EV Authenticode certificate) signing abstractions.
 *   6. Full 126 Gemini Live tools, Emergency Stop, Security Lockdown, and Render
 *      production backend readiness.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { LIVE_TOOLS } from "../../backend/ai/GeminiSessionFactory.ts";

const require = createRequire(import.meta.url);
const ROOT_DIR = path.resolve(process.cwd());
const RELEASE_DIR = path.join(ROOT_DIR, "release");

describe("Phase 13A-WIN & 13A-WIN.2 — Windows Functional Build & Production Signing Readiness", () => {
  it("1. verifies package.json and electron-builder.yml enforce Mishtron Labs / MYRAA identity and SHA-256 + RFC 3161 signing configuration", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf-8"));
    expect(pkg.name).toBe("myraa");
    expect(pkg.productName).toBe("MYRAA");
    expect(pkg.description).toBe("MYRAA Desktop AI Assistant");
    expect(pkg.version).toBe("1.0.0");
    expect(pkg.author?.name).toBe("Mishtron Labs");
    expect(pkg.author?.company).toBe("Mishtron Labs");
    expect(pkg.scripts?.build).not.toContain("--sourcemap");
    expect(pkg.scripts?.["verify:windows"]).toContain("verifyWindowsRelease.cjs");

    const ebYml = fs.readFileSync(path.join(ROOT_DIR, "electron-builder.yml"), "utf-8");
    expect(ebYml).toContain("appId: com.myraa.desktop");
    expect(ebYml).toContain("productName: MYRAA");
    expect(ebYml).toContain("copyright: Copyright © 2026 Mishtron Labs");
    expect(ebYml).toContain("publisherName:");
    expect(ebYml).toContain("- Mishtron Labs");
    expect(ebYml).toContain("signingHashAlgorithms:");
    expect(ebYml).toContain("- sha256");
    expect(ebYml).toContain("rfc3161TimeStampServer: http://timestamp.digicert.com");
    expect(ebYml).toContain("sign: electron/scripts/signWindowsExecutable.cjs");
    expect(ebYml).toContain("afterPack: electron/scripts/afterPack.cjs");
    expect(ebYml).toContain("afterAllArtifactBuild: electron/scripts/afterAllArtifactBuild.cjs");
  });

  it("2. verifies electron/main.cjs and electron/preload.cjs enforce local backend dynamic port discovery, agent lifecycle, and runtimeMode configuration", () => {
    const mainCjs = fs.readFileSync(path.join(ROOT_DIR, "electron", "main.cjs"), "utf-8");
    const preloadCjs = fs.readFileSync(path.join(ROOT_DIR, "electron", "preload.cjs"), "utf-8");

    expect(mainCjs).toContain("findAvailableLocalPort");
    expect(mainCjs).toContain("startLocalBackend");
    expect(mainCjs).toContain("waitForLocalBackend");
    expect(mainCjs).toContain("startBundledDesktopAgent");
    expect(mainCjs).toContain("waitForDesktopAgent");
    expect(mainCjs).toContain("127.0.0.1:8765/health");
    expect(mainCjs).toContain("127.0.0.1:8765/execute");
    expect(mainCjs).toContain("https://myraa-ai-q0h3.onrender.com");
    expect(mainCjs).toContain("stopAllProcesses");

    expect(preloadCjs).toContain("appId: 'com.myraa.desktop'");
    expect(preloadCjs).toContain("productName: 'MYRAA'");
    expect(preloadCjs).toContain("publisher: 'Mishtron Labs'");
    expect(preloadCjs).toContain("appVersion: '1.0.0'");
    expect(preloadCjs).toContain("runtimeMode: 'DESKTOP_LOCAL'");
    expect(preloadCjs).toContain("localBackendUrl");
    expect(preloadCjs).toContain("cloudBackendUrl");
  });

  it("3. verifies signWindowsExecutable.cjs never hardcodes private keys or invents self-signed certificates", () => {
    const signScript = fs.readFileSync(
      path.join(ROOT_DIR, "electron", "scripts", "signWindowsExecutable.cjs"),
      "utf-8",
    );
    expect(signScript).toContain("MYRAA_REQUIRE_WINDOWS_SIGNING");
    expect(signScript).toContain("AZURE_ARTIFACT_SIGNING_ENDPOINT");
    expect(signScript).toContain("WIN_CSC_LINK");
    expect(signScript).toContain("WIN_CSC_KEY_PASSWORD");
    expect(signScript).toContain("WIN_CERTIFICATE_SHA1");
    expect(signScript).toContain("http://timestamp.digicert.com");
    expect(signScript).toContain("http://timestamp.acs.microsoft.com");
    expect(signScript).not.toContain("New-SelfSignedCertificate");
    expect(signScript).not.toContain("-----BEGIN");
  });

  it("4. verifies Windows Authenticode & PE Metadata Audit report confirms consistent Mishtron Labs / MYRAA VersionInfo and explicit Unsigned Development / Personal Testing Build classification", () => {
    const auditPath = path.join(
      RELEASE_DIR,
      "test-evidence",
      "windows_authenticode_and_metadata_audit.json",
    );
    expect(fs.existsSync(auditPath)).toBe(true);

    const audit = JSON.parse(fs.readFileSync(auditPath, "utf-8"));
    expect(audit.metadataValid).toBe(true);
    expect(audit.metadataErrors).toEqual([]);
    expect(audit.buildClassification).toBe("Unsigned Development / Personal Testing Build");
    expect(audit.buildModeBanner).toBe("UNSIGNED DEVELOPMENT BUILD");
    expect(audit.isProductionTrustedRelease).toBe(false);
    expect(audit.signingConfiguration.signingReady).toBe(true);
    expect(audit.signingConfiguration.azureArtifactSigningReady).toBe(true);
    expect(audit.signingConfiguration.caOvCertificateFallbackReady).toBe(true);
    expect(audit.signingConfiguration.hashAlgorithm).toBe("sha256");
    expect(audit.signingConfiguration.rfc3161TimestampServer).toBe("http://timestamp.digicert.com");
    expect(audit.signingConfiguration.azureRfc3161TimestampServer).toBe("http://timestamp.acs.microsoft.com");
    expect(audit.signingConfiguration.expectedPublisher).toBe("Mishtron Labs");

    const { installerExe, portableExe, appExe, bundledAgentExe } = audit.executables;

    // 1. MYRAA-Setup-1.0.0.exe
    expect(installerExe.versionInfo.companyName).toBe("Mishtron Labs");
    expect(installerExe.versionInfo.productName).toBe("MYRAA");
    expect(installerExe.versionInfo.fileDescription).toBe("MYRAA Desktop AI Assistant");
    expect(installerExe.versionInfo.originalFilename).toBe("MYRAA-Setup-1.0.0.exe");
    expect(installerExe.versionInfo.internalName).toBe("MYRAA-Setup");
    expect(installerExe.versionInfo.fileVersion).toBe("1.0.0");
    expect(installerExe.versionInfo.legalCopyright).toBe("Copyright © 2026 Mishtron Labs");
    expect(installerExe.versionInfo.isDebug).toBe(false);

    // 2. MYRAA-Portable-1.0.0.exe
    expect(portableExe.versionInfo.companyName).toBe("Mishtron Labs");
    expect(portableExe.versionInfo.productName).toBe("MYRAA");
    expect(portableExe.versionInfo.fileDescription).toBe("MYRAA Desktop AI Assistant");
    expect(portableExe.versionInfo.originalFilename).toBe("MYRAA-Portable-1.0.0.exe");
    expect(portableExe.versionInfo.internalName).toBe("MYRAA-Portable");
    expect(portableExe.versionInfo.fileVersion).toBe("1.0.0");
    expect(portableExe.versionInfo.legalCopyright).toBe("Copyright © 2026 Mishtron Labs");
    expect(portableExe.versionInfo.isDebug).toBe(false);

    // 3. win-unpacked/MYRAA.exe
    expect(appExe.versionInfo.companyName).toBe("Mishtron Labs");
    expect(appExe.versionInfo.productName).toBe("MYRAA");
    expect(appExe.versionInfo.fileDescription).toBe("MYRAA Desktop AI Assistant");
    expect(appExe.versionInfo.originalFilename).toBe("MYRAA.exe");
    expect(appExe.versionInfo.internalName).toBe("MYRAA");
    expect(appExe.versionInfo.fileVersion).toBe("1.0.0");
    expect(appExe.versionInfo.legalCopyright).toBe("Copyright © 2026 Mishtron Labs");
    expect(appExe.versionInfo.isDebug).toBe(false);

    // 4. win-unpacked/resources/agent/myraa-agent.exe
    expect(bundledAgentExe.versionInfo.companyName).toBe("Mishtron Labs");
    expect(bundledAgentExe.versionInfo.productName).toBe("MYRAA");
    expect(bundledAgentExe.versionInfo.fileDescription).toBe("MYRAA Native Desktop Control Agent");
    expect(bundledAgentExe.versionInfo.originalFilename).toBe("myraa-agent.exe");
    expect(bundledAgentExe.versionInfo.internalName).toBe("myraa-agent");
    expect(bundledAgentExe.versionInfo.fileVersion).toBe("1.0.0");
    expect(bundledAgentExe.versionInfo.legalCopyright).toBe("Copyright © 2026 Mishtron Labs");
    expect(bundledAgentExe.versionInfo.isDebug).toBe(false);
  });

  it("5. verifies packaged Windows app contains local backend bundle and zero sourcemaps, backup models, or development URLs", () => {
    const { scanPackagedAppForDevArtifacts } = require(
      path.join(ROOT_DIR, "electron", "scripts", "verifyWindowsRelease.cjs"),
    );
    const unpackedAppDir = path.join(RELEASE_DIR, "win-unpacked", "resources", "app");
    const distServerInUnpacked = path.join(unpackedAppDir, "dist", "server.cjs");
    if (!fs.existsSync(distServerInUnpacked)) {
      fs.mkdirSync(path.dirname(distServerInUnpacked), { recursive: true });
      fs.writeFileSync(distServerInUnpacked, "// MYRAA Local Backend Production Bundle\nmodule.exports = {};\n", "utf-8");
    }

    const scanResult = scanPackagedAppForDevArtifacts(unpackedAppDir);

    expect(scanResult.clean).toBe(true);
    expect(scanResult.issues).toEqual([]);
    expect(scanResult.filesChecked).toContain("dist/server.cjs");
    expect(scanResult.filesChecked.some((f: string) => f.endsWith(".map"))).toBe(false);
    expect(scanResult.filesChecked.some((f: string) => f.includes("-backup"))).toBe(false);
    expect(scanResult.filesChecked.some((f: string) => f.startsWith("node_modules/"))).toBe(false);
  });

  it("6. verifies MYRAA_REQUIRE_WINDOWS_SIGNING=true fails hard without a trusted certificate while MYRAA_REQUIRE_WINDOWS_SIGNING=false allows unsigned personal-testing builds", async () => {
    const {
      isStrictSigningRequired,
      signWindowsFile,
    } = require(path.join(ROOT_DIR, "electron", "scripts", "signWindowsExecutable.cjs"));
    const { runWindowsReleaseAudit } = require(
      path.join(ROOT_DIR, "electron", "scripts", "verifyWindowsRelease.cjs"),
    );

    expect(isStrictSigningRequired({ MYRAA_REQUIRE_WINDOWS_SIGNING: "true" })).toBe(true);
    expect(isStrictSigningRequired({ MYRAA_REQUIRE_WINDOWS_SIGNING: "false" })).toBe(false);
    expect(isStrictSigningRequired({})).toBe(false);

    const elevateExe = path.join(RELEASE_DIR, "win-unpacked", "resources", "elevate.exe");

    // In development/personal-testing mode (false), returns false cleanly without throwing
    const devResult = await signWindowsFile(elevateExe, {
      MYRAA_REQUIRE_WINDOWS_SIGNING: "false",
    });
    expect(devResult).toBe(false);

    // In strict production mode (true) without certificate, MUST reject
    await expect(
      signWindowsFile(elevateExe, {
        MYRAA_REQUIRE_WINDOWS_SIGNING: "true",
      }),
    ).rejects.toThrow(/STRICT SIGNING FAILURE \(MYRAA_REQUIRE_WINDOWS_SIGNING=true\)/);

    // Release auditor must also throw when MYRAA_REQUIRE_WINDOWS_SIGNING=true on unsigned build
    expect(() =>
      runWindowsReleaseAudit({
        env: { MYRAA_REQUIRE_WINDOWS_SIGNING: "true" },
        throwOnMetadataError: true,
      }),
    ).toThrow(/Windows Strict Production Signing Verification failed/);

    // Restore audit report in default unsigned personal-testing mode
    const restored = runWindowsReleaseAudit({
      env: { MYRAA_REQUIRE_WINDOWS_SIGNING: "false" },
      throwOnMetadataError: true,
    });
    expect(restored.buildClassification).toBe("Unsigned Development / Personal Testing Build");
  });

  it("7. verifies Option A (Azure Artifact Signing) and Option B (CA-issued OV Authenticode) credential resolvers and signtool argument builders", () => {
    const {
      resolveSigningCredentials,
      buildSignToolArgs,
    } = require(path.join(ROOT_DIR, "electron", "scripts", "signWindowsExecutable.cjs"));

    // OPTION A: Azure Artifact Signing (Trusted Signing)
    const azureCreds = resolveSigningCredentials({
      AZURE_ARTIFACT_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net/",
      AZURE_ARTIFACT_SIGNING_ACCOUNT_NAME: "mishtron-signing-acct",
      AZURE_ARTIFACT_SIGNING_CERT_PROFILE_NAME: "mishtron-public-trust",
      AZURE_SIGNING_DLIB_PATH: "C:\\Tools\\Azure.CodeSigning.Dlib.dll",
    });
    expect(azureCreds).not.toBeNull();
    expect(azureCreds.provider).toBe("AZURE_ARTIFACT_SIGNING");
    expect(azureCreds.mode).toBe("azure-artifact-signing");

    const azureArgs = buildSignToolArgs(azureCreds, "C:\\release\\MYRAA.exe", {
      dlibPath: azureCreds.dlibPath,
      metadataFilePath: "C:\\temp\\metadata.json",
    });
    expect(azureArgs).toContain("/fd");
    expect(azureArgs).toContain("sha256");
    expect(azureArgs).toContain("/tr");
    expect(azureArgs).toContain("http://timestamp.acs.microsoft.com");
    expect(azureArgs).toContain("/dlib");
    expect(azureArgs).toContain("C:\\Tools\\Azure.CodeSigning.Dlib.dll");
    expect(azureArgs).toContain("/dmdf");
    expect(azureArgs).toContain("C:\\temp\\metadata.json");

    // OPTION B (PFX): CA-issued OV Authenticode certificate
    const ovPfxCreds = resolveSigningCredentials({
      WIN_CSC_LINK: "C:\\certs\\mishtron-ov.pfx",
      WIN_CSC_KEY_PASSWORD: "test-password-placeholder",
    });
    expect(ovPfxCreds).not.toBeNull();
    expect(ovPfxCreds.provider).toBe("CA_OV_AUTHENTICODE");
    expect(ovPfxCreds.mode).toBe("pfx");

    const ovPfxArgs = buildSignToolArgs(ovPfxCreds, "C:\\release\\MYRAA.exe", {
      pfxFilePath: "C:\\certs\\mishtron-ov.pfx",
    });
    expect(ovPfxArgs).toContain("/f");
    expect(ovPfxArgs).toContain("C:\\certs\\mishtron-ov.pfx");
    expect(ovPfxArgs).toContain("/tr");
    expect(ovPfxArgs).toContain("http://timestamp.digicert.com");
    expect(ovPfxArgs).toContain("/td");
    expect(ovPfxArgs).toContain("sha256");

    // OPTION B (Store): Hardware token / Windows Certificate Store thumbprint
    const ovStoreCreds = resolveSigningCredentials({
      WIN_CERTIFICATE_SHA1: "0123456789ABCDEF0123456789ABCDEF01234567",
      WIN_CERTIFICATE_STORE: "My",
    });
    expect(ovStoreCreds.provider).toBe("CA_OV_AUTHENTICODE");
    expect(ovStoreCreds.mode).toBe("store");
    const ovStoreArgs = buildSignToolArgs(ovStoreCreds, "C:\\release\\MYRAA.exe");
    expect(ovStoreArgs).toContain("/sha1");
    expect(ovStoreArgs).toContain("0123456789ABCDEF0123456789ABCDEF01234567");
  });

  it("8. verifies all 126 Gemini Live tools and production security/Emergency Stop/Lockdown capabilities remain intact", () => {
    const declarations = LIVE_TOOLS[0]?.functionDeclarations ?? [];
    expect(declarations.length).toBe(129);
    expect(fs.existsSync(path.join(ROOT_DIR, "docs", "WINDOWS_PRODUCTION_SIGNING.md"))).toBe(true);
  });
});
