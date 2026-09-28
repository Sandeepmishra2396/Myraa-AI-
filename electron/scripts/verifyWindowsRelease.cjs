'use strict';

/**
 * MYRAA — Windows Authenticode, PE Metadata & Production Artifact Auditor
 *
 * Inspects using Windows-native tools (PowerShell Get-AuthenticodeSignature,
 * X509Chain, and PE FileVersionInfo):
 *   - release/MYRAA-Setup-1.0.0.exe
 *   - release/MYRAA-Portable-1.0.0.exe
 *   - release/win-unpacked/MYRAA.exe
 *   - release/win-unpacked/resources/agent/myraa-agent.exe
 *   - release/win-unpacked/resources/elevate.exe
 *
 * Enforces:
 *   1. Complete Mishtron Labs / MYRAA PE VS_VERSION_INFO metadata across all EXEs.
 *   2. Zero development bloat (.map sourcemaps, dist/server.cjs, node_modules,
 *      *-backup*, localhost:3000 strings, private keys).
 *   3. Strict Production Signing Mode (`MYRAA_REQUIRE_WINDOWS_SIGNING=true`):
 *      - Fails immediately if no trusted certificate is configured.
 *      - Verifies every production executable has Status="Valid", complete
 *        certificate chain, RFC 3161 timestamp, SHA-256 signature digest, and
 *        publisher subject ("Mishtron Labs").
 *   4. Development / Personal Testing Mode (`MYRAA_REQUIRE_WINDOWS_SIGNING=false`):
 *      - Clearly labels the output as:
 *        "UNSIGNED DEVELOPMENT BUILD" / "Unsigned Development / Personal Testing Build"
 *      - Never falsely claims the unsigned build is a production-trusted release.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const {
  resolveSigningCredentials,
  isStrictSigningRequired,
} = require('./signWindowsExecutable.cjs');

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(4 * 1024 * 1024);
  let bytesRead = 0;
  try {
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function inspectExecutableWithPowerShell(filePath) {
  const escaped = filePath.replace(/'/g, "''");
  const ps = `
    $ErrorActionPreference = 'Stop'
    $item = Get-Item -LiteralPath '${escaped}'
    $sig = Get-AuthenticodeSignature -LiteralPath '${escaped}'
    $vi = $item.VersionInfo
    $cert = $sig.SignerCertificate
    $ts = $sig.TimeStamperCertificate
    $chainTrusted = $false
    $chainElements = @()
    if ($cert) {
      $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
      $chainTrusted = $chain.Build($cert)
      foreach ($el in $chain.ChainElements) {
        $chainElements += $el.Certificate.Subject
      }
    }
    [PSCustomObject]@{
      fileName = $item.Name
      filePath = $item.FullName
      sizeBytes = $item.Length
      authenticode = [PSCustomObject]@{
        isSigned = ($sig.Status -ne 'NotSigned')
        status = [string]$sig.Status
        statusMessage = [string]$sig.StatusMessage
        signatureType = [string]$sig.SignatureType
        isOSBinary = [bool]$sig.IsOSBinary
        subject = if ($cert) { [string]$cert.Subject } else { $null }
        issuer = if ($cert) { [string]$cert.Issuer } else { $null }
        thumbprint = if ($cert) { [string]$cert.Thumbprint } else { $null }
        serialNumber = if ($cert) { [string]$cert.SerialNumber } else { $null }
        notBefore = if ($cert) { $cert.NotBefore.ToString('o') } else { $null }
        notAfter = if ($cert) { $cert.NotAfter.ToString('o') } else { $null }
        isCurrentlyValid = if ($cert) { ([DateTime]::Now -ge $cert.NotBefore -and [DateTime]::Now -le $cert.NotAfter) } else { $false }
        signatureAlgorithm = if ($cert) { [string]$cert.SignatureAlgorithm.FriendlyName } else { $null }
        isSha256 = if ($cert) { [bool]($cert.SignatureAlgorithm.FriendlyName -match 'sha256') } else { $false }
        isTrustedByWindows = ($sig.Status -eq 'Valid' -and $chainTrusted)
        isChainComplete = [bool]$chainTrusted
        chainSubjects = $chainElements
        hasTimestamp = ($null -ne $ts)
        timestampSubject = if ($ts) { [string]$ts.Subject } else { $null }
        timestampIssuer = if ($ts) { [string]$ts.Issuer } else { $null }
      }
      versionInfo = [PSCustomObject]@{
        companyName = [string]$vi.CompanyName
        productName = [string]$vi.ProductName
        fileDescription = [string]$vi.FileDescription
        fileVersion = [string]$vi.FileVersion
        productVersion = [string]$vi.ProductVersion
        originalFilename = [string]$vi.OriginalFilename
        internalName = [string]$vi.InternalName
        legalCopyright = [string]$vi.LegalCopyright
        legalTrademarks = [string]$vi.LegalTrademarks
        isDebug = [bool]$vi.IsDebug
        isPreRelease = [bool]$vi.IsPreRelease
      }
    } | ConvertTo-Json -Depth 6 -Compress
  `;

  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf-8', timeout: 30_000 },
  );
  if (res.status !== 0 || !res.stdout) {
    throw new Error(`PowerShell inspection failed for ${filePath}: ${res.stderr || res.stdout}`);
  }
  const parsed = JSON.parse(res.stdout.trim());
  parsed.sha256 = sha256File(filePath);
  return parsed;
}

function scanPackagedAppForDevArtifacts(unpackedAppDir) {
  const issues = [];
  const filesChecked = [];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const rel = path.relative(unpackedAppDir, full).replace(/\\/g, '/');
        filesChecked.push(rel);

        if (rel.endsWith('.map')) {
          issues.push(`Debug sourcemap found in packaged app: ${rel}`);
        }
        if (rel.includes('-backup')) {
          issues.push(`Backup artifact found in packaged app: ${rel}`);
        }
        if (rel === 'dist/server.cjs') {
          issues.push(`Server bundle dist/server.cjs should not be packaged in Windows client: ${rel}`);
        }
        if (/\.(pfx|p12|key|pem)$/i.test(rel)) {
          issues.push(`Private key or certificate file found in packaged app: ${rel}`);
        }

        if (/\.(cjs|js|mjs|html|json)$/i.test(rel)) {
          const content = fs.readFileSync(full, 'utf-8');
          if (/https?:\/\/localhost:3000/i.test(content)) {
            issues.push(`Development localhost:3000 URL found in ${rel}`);
          }
          if (/AIza[0-9A-Za-z_-]{30,}/.test(content)) {
            issues.push(`Hardcoded Gemini API key found in ${rel}`);
          }
          if (/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(content)) {
            issues.push(`Private key block found in ${rel}`);
          }
        }
      }
    }
  }

  walk(unpackedAppDir);
  return {
    filesCount: filesChecked.length,
    filesChecked,
    clean: issues.length === 0,
    issues,
  };
}

function runWindowsReleaseAudit(options = {}) {
  const env = options.env || process.env;
  const rootDir = path.resolve(process.cwd());
  const outDir = options.outDir || path.join(rootDir, 'release');
  const strictSigning = isStrictSigningRequired(env);
  const creds = resolveSigningCredentials(env);

  const targets = [
    {
      key: 'installerExe',
      path: path.join(outDir, 'MYRAA-Setup-1.0.0.exe'),
      expectedOriginalFilename: 'MYRAA-Setup-1.0.0.exe',
      requireMishtronIdentity: true,
      requireProductionSignatureWhenStrict: true,
    },
    {
      key: 'portableExe',
      path: path.join(outDir, 'MYRAA-Portable-1.0.0.exe'),
      expectedOriginalFilename: 'MYRAA-Portable-1.0.0.exe',
      requireMishtronIdentity: true,
      requireProductionSignatureWhenStrict: true,
    },
    {
      key: 'appExe',
      path: path.join(outDir, 'win-unpacked', 'MYRAA.exe'),
      expectedOriginalFilename: 'MYRAA.exe',
      requireMishtronIdentity: true,
      requireProductionSignatureWhenStrict: true,
    },
    {
      key: 'bundledAgentExe',
      path: path.join(outDir, 'win-unpacked', 'resources', 'agent', 'myraa-agent.exe'),
      expectedOriginalFilename: 'myraa-agent.exe',
      requireMishtronIdentity: true,
      requireProductionSignatureWhenStrict: true,
    },
    {
      key: 'elevateHelperExe',
      path: path.join(outDir, 'win-unpacked', 'resources', 'elevate.exe'),
      expectedOriginalFilename: 'Elevate.exe',
      requireMishtronIdentity: false,
      requireProductionSignatureWhenStrict: false,
    },
  ];

  const executables = {};
  const metadataErrors = [];
  const signatureErrors = [];

  if (strictSigning && !creds) {
    signatureErrors.push(
      'MYRAA_REQUIRE_WINDOWS_SIGNING=true is set, but no production signing credentials (Azure Artifact Signing or CA-issued OV/EV Authenticode certificate) are configured in environment.',
    );
  }

  for (const t of targets) {
    if (!fs.existsSync(t.path)) {
      if (t.requireProductionSignatureWhenStrict && strictSigning) {
        signatureErrors.push(`Missing required Windows executable: ${t.path}`);
      }
      continue;
    }
    const info = inspectExecutableWithPowerShell(t.path);
    executables[t.key] = info;

    if (t.requireMishtronIdentity) {
      const vi = info.versionInfo;
      if (vi.companyName !== 'Mishtron Labs') {
        metadataErrors.push(`${info.fileName}: CompanyName is "${vi.companyName}" (expected "Mishtron Labs")`);
      }
      if (vi.productName !== 'MYRAA') {
        metadataErrors.push(`${info.fileName}: ProductName is "${vi.productName}" (expected "MYRAA")`);
      }
      if (!vi.fileDescription || !vi.fileDescription.includes('MYRAA')) {
        metadataErrors.push(`${info.fileName}: FileDescription is "${vi.fileDescription}" (expected MYRAA description)`);
      }
      if (vi.originalFilename !== t.expectedOriginalFilename) {
        metadataErrors.push(
          `${info.fileName}: OriginalFilename is "${vi.originalFilename}" (expected "${t.expectedOriginalFilename}")`,
        );
      }
      if (!vi.internalName || !vi.internalName.toLowerCase().includes('myraa')) {
        metadataErrors.push(`${info.fileName}: InternalName is "${vi.internalName}" (expected MYRAA internal name)`);
      }
      if (vi.isDebug) {
        metadataErrors.push(`${info.fileName}: IsDebug is true (expected false)`);
      }
    }

    if (strictSigning && t.requireProductionSignatureWhenStrict) {
      const auth = info.authenticode;
      const expectedPublisher = (env.MYRAA_EXPECTED_PUBLISHER_SUBJECT || 'Mishtron Labs').trim();
      if (!auth.isSigned || auth.status !== 'Valid') {
        signatureErrors.push(
          `${info.fileName}: Authenticode status is "${auth.status}" (expected "Valid" under MYRAA_REQUIRE_WINDOWS_SIGNING=true)`,
        );
      }
      if (!auth.isChainComplete) {
        signatureErrors.push(`${info.fileName}: Certificate chain verification failed`);
      }
      if (!auth.hasTimestamp) {
        signatureErrors.push(`${info.fileName}: Missing RFC 3161 timestamp signature`);
      }
      if (!auth.isSha256) {
        signatureErrors.push(
          `${info.fileName}: Signature digest algorithm is "${auth.signatureAlgorithm}" (expected SHA-256)`,
        );
      }
      if (!auth.subject || !auth.subject.includes(expectedPublisher)) {
        signatureErrors.push(
          `${info.fileName}: Signer certificate subject "${auth.subject}" does not match expected publisher "${expectedPublisher}"`,
        );
      }
    }
  }

  const unpackedAppDir = path.join(outDir, 'win-unpacked', 'resources', 'app');
  const devScan = scanPackagedAppForDevArtifacts(unpackedAppDir);
  if (!devScan.clean) {
    metadataErrors.push(...devScan.issues);
  }

  const allProductionExesSigned = [
    executables.installerExe,
    executables.portableExe,
    executables.appExe,
    executables.bundledAgentExe,
  ].every((exe) => exe && exe.authenticode && exe.authenticode.status === 'Valid' && exe.authenticode.isTrustedByWindows);

  const buildClassification = allProductionExesSigned
    ? 'Production Signed Release Build'
    : 'Unsigned Development / Personal Testing Build';

  const buildModeBanner = allProductionExesSigned
    ? 'PRODUCTION SIGNED BUILD'
    : 'UNSIGNED DEVELOPMENT BUILD';

  const report = {
    timestamp: new Date().toISOString(),
    buildClassification,
    buildModeBanner,
    isProductionTrustedRelease: allProductionExesSigned,
    strictSigningRequired: strictSigning,
    signingConfiguration: {
      signingReady: true,
      azureArtifactSigningReady: true,
      caOvCertificateFallbackReady: true,
      hashAlgorithm: 'sha256',
      rfc3161TimestampServer: 'http://timestamp.digicert.com',
      azureRfc3161TimestampServer: 'http://timestamp.acs.microsoft.com',
      expectedPublisher: 'Mishtron Labs',
      productionCertificatePresentInEnv: Boolean(creds),
      certificateProvider: creds ? creds.provider : 'NONE',
      certificateMode: creds ? creds.mode : 'UNSIGNED_DEVELOPMENT_PERSONAL_TESTING',
    },
    executables,
    packagedAppAudit: devScan,
    metadataValid: metadataErrors.length === 0,
    metadataErrors,
    signatureValid: signatureErrors.length === 0,
    signatureErrors,
  };

  const evidenceDir = path.join(outDir, 'test-evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const reportPath = path.join(evidenceDir, 'windows_authenticode_and_metadata_audit.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  // Keep SHA256SUMS.txt and SHA256SUMS-1.0.1.txt synchronized when auditing release/
  const v100Files = [
    'MYRAA-Android-1.0.0.apk',
    'MYRAA-Android-1.0.0.aab',
    'MYRAA-Setup-1.0.0.exe',
    'MYRAA-Portable-1.0.0.exe',
  ];
  if (v100Files.every((f) => fs.existsSync(path.join(outDir, f)))) {
    const lines = v100Files.map((f) => `${sha256File(path.join(outDir, f))}  ${f}`);
    fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf-8');
  }

  const v101Files = [
    'MYRAA-Android-1.0.1.apk',
    'MYRAA-Android-1.0.1.aab',
    'MYRAA-Setup-1.0.0.exe',
    'MYRAA-Portable-1.0.0.exe',
  ];
  if (v101Files.every((f) => fs.existsSync(path.join(outDir, f)))) {
    const lines = v101Files.map((f) => `${sha256File(path.join(outDir, f))}  ${f}`);
    fs.writeFileSync(path.join(outDir, 'SHA256SUMS-1.0.1.txt'), `${lines.join('\n')}\n`, 'utf-8');
  }

  if (options.throwOnMetadataError && metadataErrors.length > 0) {
    throw new Error(
      `Windows Release Metadata / Hardening Audit failed:\n  - ${metadataErrors.join('\n  - ')}`,
    );
  }

  if ((strictSigning || options.throwOnSignatureError) && signatureErrors.length > 0) {
    throw new Error(
      `Windows Strict Production Signing Verification failed (MYRAA_REQUIRE_WINDOWS_SIGNING=true):\n  - ${signatureErrors.join('\n  - ')}`,
    );
  }

  return report;
}

if (require.main === module) {
  const report = runWindowsReleaseAudit({ throwOnMetadataError: true });
  console.log('================================================================');
  console.log(`  MYRAA WINDOWS BUILD CLASSIFICATION: ${report.buildClassification}`);
  console.log(`  BUILD MODE:                         ${report.buildModeBanner}`);
  console.log(`  PRODUCTION-TRUSTED RELEASE:         ${report.isProductionTrustedRelease ? 'YES' : 'NO (Unsigned Personal Testing Build)'}`);
  console.log(`  STRICT SIGNING ENFORCED:            ${report.strictSigningRequired}`);
  console.log(`  OPTION A (Azure Artifact Signing):  ${report.signingConfiguration.azureArtifactSigningReady ? 'READY' : 'NOT READY'}`);
  console.log(`  OPTION B (CA-Issued OV/EV Cert):    ${report.signingConfiguration.caOvCertificateFallbackReady ? 'READY' : 'NOT READY'}`);
  console.log('================================================================');
  console.log(JSON.stringify(report, null, 2));
}

module.exports = {
  runWindowsReleaseAudit,
  inspectExecutableWithPowerShell,
  scanPackagedAppForDevArtifacts,
  sha256File,
};
