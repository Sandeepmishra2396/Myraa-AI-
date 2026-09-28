'use strict';

/**
 * MYRAA — Production Windows Authenticode Signing & PE Resource Hardening Module
 * Publisher: Mishtron Labs
 *
 * Supports two production signing backends without changing MYRAA application code:
 *
 *   OPTION A — Microsoft Azure Artifact Signing (formerly Azure Trusted Signing):
 *     - AZURE_ARTIFACT_SIGNING_ENDPOINT          (e.g. https://eus.codesigning.azure.net/)
 *     - AZURE_ARTIFACT_SIGNING_ACCOUNT_NAME      (Artifact Signing account name)
 *     - AZURE_ARTIFACT_SIGNING_CERT_PROFILE_NAME (Certificate profile name)
 *     - AZURE_SIGNING_DLIB_PATH                  (optional explicit path to Azure.CodeSigning.Dlib.dll)
 *     - AZURE_SIGNING_METADATA_PATH              (optional explicit path to metadata.json)
 *     - Standard Azure auth env vars (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET)
 *     Note: Microsoft organization/individual identity validation & eligibility must be
 *           completed in Azure Portal before production signing.
 *
 *   OPTION B — CA-Issued OV / EV Authenticode Certificate:
 *     - WIN_CSC_LINK / CSC_LINK                  (file path or base64 PKCS#12 .pfx/.p12)
 *     - WIN_CSC_KEY_PASSWORD / CSC_KEY_PASSWORD  (certificate password)
 *     - WIN_CERTIFICATE_SHA1                     (Windows Certificate Store thumbprint / hardware token)
 *     - WIN_CERTIFICATE_SUBJECT_NAME             (Windows Certificate Store subject)
 *     - WIN_CERTIFICATE_STORE                    (default: "My")
 *     - WIN_ADDITIONAL_CERTIFICATE_FILE          (optional intermediate CA bundle)
 *
 * Strict Production Enforcement:
 *   - MYRAA_REQUIRE_WINDOWS_SIGNING=true
 *     Fails the build immediately if no trusted production certificate is configured,
 *     if signing fails, or if post-sign verification (certificate chain, RFC 3161
 *     timestamp, publisher identity, SHA-256 digest) fails on any executable.
 *   - MYRAA_REQUIRE_WINDOWS_SIGNING=false (default for local dev / personal testing)
 *     Produces a functional "Unsigned Development / Personal Testing Build" and logs
 *     "UNSIGNED DEVELOPMENT BUILD" without inventing or embedding a fake certificate.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const resedit = require('resedit');

const PUBLISHER_NAME = 'Mishtron Labs';
const PRODUCT_NAME = 'MYRAA';
const APP_VERSION = '1.0.0';
const COPYRIGHT_TEXT = 'Copyright © 2026 Mishtron Labs';
const TRADEMARK_TEXT = 'MYRAA is a trademark of Mishtron Labs';
const PRODUCTION_URL = 'https://myraa-ai-q0h3.onrender.com';

const AZURE_ACS_TIMESTAMP_URL = 'http://timestamp.acs.microsoft.com';

const DEFAULT_TIMESTAMP_SERVERS = [
  process.env.MYRAA_RFC3161_TIMESTAMP_URL,
  'http://timestamp.digicert.com',
  'http://timestamp.sectigo.com',
  'http://timestamp.globalsign.com/tsa/r6advanced1',
].filter(Boolean);

/**
 * Returns true when strict production signing enforcement is enabled.
 */
function isStrictSigningRequired(env = process.env) {
  const val = String(
    env.MYRAA_REQUIRE_WINDOWS_SIGNING || env.MYRAA_REQUIRE_PRODUCTION_CERT || 'false',
  )
    .trim()
    .toLowerCase();
  return val === 'true' || val === '1' || val === 'yes';
}

/**
 * Stamps consistent MYRAA / Mishtron Labs PE VS_VERSION_INFO metadata onto a
 * standard Windows PE executable (such as MYRAA.exe or myraa-agent.exe) before signing.
 * Note: NSIS binaries (Setup / Portable / Uninstaller) have their VersionInfo
 * compiled natively by makensis.exe so their compressed overlay offsets never shift.
 */
function stampPeMetadata(filePath, options = {}) {
  if (!fs.existsSync(filePath)) return;
  const baseName = path.basename(filePath);
  const lower = baseName.toLowerCase();

  if (
    lower.includes('-setup-') ||
    lower.includes('-portable-') ||
    lower.includes('uninstall') ||
    lower === 'elevate.exe'
  ) {
    return;
  }

  const isAgent = lower === 'myraa-agent.exe';
  const fileDescription =
    options.fileDescription ||
    (isAgent ? 'MYRAA Native Desktop Control Agent' : 'MYRAA Desktop AI Assistant');
  const internalName =
    options.internalName || path.basename(baseName, path.extname(baseName));
  const originalFilename = options.originalFilename || baseName;

  const buf = fs.readFileSync(filePath);
  const exe = resedit.NtExecutable.from(buf, { ignoreCert: true });
  const res = resedit.NtExecutableResource.from(exe);
  const viList = resedit.Resource.VersionInfo.fromEntries(res.entries);
  const vi =
    viList.length > 0 ? viList[0] : resedit.Resource.VersionInfo.createEmpty();
  const languages = vi.getAllLanguagesForStringValues();
  const lang =
    languages.length > 0 ? languages[0] : { lang: 0x0409, codepage: 1200 };

  vi.setFileVersion(1, 0, 0, 0, lang.lang);
  vi.setProductVersion(1, 0, 0, 0, lang.lang);
  vi.setStringValues(lang, {
    CompanyName: PUBLISHER_NAME,
    ProductName: PRODUCT_NAME,
    FileDescription: fileDescription,
    FileVersion: APP_VERSION,
    ProductVersion: APP_VERSION,
    InternalName: internalName,
    OriginalFilename: originalFilename,
    LegalCopyright: COPYRIGHT_TEXT,
    LegalTrademarks: TRADEMARK_TEXT,
  });
  vi.outputToResourceEntries(res.entries);

  if (options.iconPath && fs.existsSync(options.iconPath)) {
    const iconBuf = fs.readFileSync(options.iconPath);
    const iconFile = resedit.Data.IconFile.from(iconBuf);
    resedit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries,
      1,
      lang.lang,
      iconFile.icons.map((i) => i.data),
    );
  }

  res.outputResource(exe);
  fs.writeFileSync(filePath, Buffer.from(exe.generate()));
}

/**
 * Resolves the Azure Artifact Signing DLib path on Windows.
 */
function resolveAzureSigningDlibPath(env = process.env) {
  const explicit = (env.AZURE_SIGNING_DLIB_PATH || '').trim();
  if (explicit) return explicit;

  const candidates = [
    process.env.LOCALAPPDATA &&
      path.join(
        process.env.LOCALAPPDATA,
        'Microsoft',
        'MicrosoftArtifactSigningClientTools',
        'Azure.CodeSigning.Dlib.dll',
      ),
    process.env.LOCALAPPDATA &&
      path.join(
        process.env.LOCALAPPDATA,
        'Microsoft',
        'MicrosoftTrustedSigningClientTools',
        'Azure.CodeSigning.Dlib.dll',
      ),
    'C:\\Program Files\\Microsoft Artifact Signing Client Tools\\Azure.CodeSigning.Dlib.dll',
    'C:\\Program Files\\Microsoft Trusted Signing Client Tools\\Azure.CodeSigning.Dlib.dll',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return 'Azure.CodeSigning.Dlib.dll';
}

/**
 * Resolves production code-signing configuration from environment variables.
 * Supports:
 *   - OPTION A: Azure Artifact Signing (formerly Trusted Signing)
 *   - OPTION B: CA-issued OV/EV Authenticode certificate (PFX or Windows Certificate Store)
 * Returns null if no production certificate is configured in the environment.
 */
function resolveSigningCredentials(env = process.env) {
  // OPTION A: Microsoft Azure Artifact Signing (Trusted Signing)
  const azureEndpoint = (env.AZURE_ARTIFACT_SIGNING_ENDPOINT || '').trim();
  const azureAccount = (env.AZURE_ARTIFACT_SIGNING_ACCOUNT_NAME || '').trim();
  const azureProfile = (env.AZURE_ARTIFACT_SIGNING_CERT_PROFILE_NAME || '').trim();
  const azureMetadataPath = (env.AZURE_SIGNING_METADATA_PATH || '').trim();

  if ((azureEndpoint && azureAccount && azureProfile) || azureMetadataPath) {
    return {
      provider: 'AZURE_ARTIFACT_SIGNING',
      mode: 'azure-artifact-signing',
      endpoint: azureEndpoint || null,
      accountName: azureAccount || null,
      certificateProfileName: azureProfile || null,
      dlibPath: resolveAzureSigningDlibPath(env),
      metadataPath: azureMetadataPath || null,
      timestampUrl:
        (env.MYRAA_RFC3161_TIMESTAMP_URL || '').trim() || AZURE_ACS_TIMESTAMP_URL,
    };
  }

  // OPTION B (1): CA-Issued OV/EV Certificate via PFX / PKCS#12 file or base64 secret
  const cscLink = (env.WIN_CSC_LINK || env.CSC_LINK || '').trim();
  const cscPassword = (env.WIN_CSC_KEY_PASSWORD || env.CSC_KEY_PASSWORD || '').trim();
  const additionalCertFile = (env.WIN_ADDITIONAL_CERTIFICATE_FILE || '').trim();

  if (cscLink) {
    return {
      provider: 'CA_OV_AUTHENTICODE',
      mode: 'pfx',
      cscLink,
      cscPassword,
      additionalCertFile: additionalCertFile || null,
    };
  }

  // OPTION B (2): CA-Issued OV/EV Certificate via Windows Certificate Store / Hardware Token
  const certSha1 = (env.WIN_CERTIFICATE_SHA1 || '').trim();
  const certSubject = (env.WIN_CERTIFICATE_SUBJECT_NAME || '').trim();
  const certStore = (env.WIN_CERTIFICATE_STORE || 'My').trim();
  const isLocalMachineStore = env.WIN_CERTIFICATE_LOCAL_MACHINE === '1';

  if (certSha1 || certSubject) {
    return {
      provider: 'CA_OV_AUTHENTICODE',
      mode: 'store',
      certSha1: certSha1 || null,
      certSubject: certSubject || null,
      certStore,
      isLocalMachineStore,
      additionalCertFile: additionalCertFile || null,
    };
  }

  return null;
}

/**
 * Resolves signtool.exe on Windows from env, Windows Kits SDK, or electron-builder cache.
 */
async function resolveSignToolPath() {
  if (process.env.SIGNTOOL_PATH && fs.existsSync(process.env.SIGNTOOL_PATH)) {
    return process.env.SIGNTOOL_PATH;
  }

  const kitsRoot = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  if (fs.existsSync(kitsRoot)) {
    const entries = fs.readdirSync(kitsRoot, { withFileTypes: true });
    const versions = entries
      .filter((e) => e.isDirectory() && /^10\./.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse();
    for (const ver of versions) {
      const candidate = path.join(kitsRoot, ver, 'x64', 'signtool.exe');
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  try {
    const { getSignToolPath } = require('app-builder-lib/out/toolsets/windows');
    const toolInfo = await getSignToolPath(undefined, true);
    if (toolInfo && toolInfo.path && fs.existsSync(toolInfo.path)) {
      return toolInfo.path;
    }
  } catch {
    /* fallback */
  }

  return 'signtool.exe';
}

/**
 * Materializes a PFX file path if WIN_CSC_LINK / CSC_LINK is base64-encoded.
 */
function materializePfxFile(cscLink) {
  if (fs.existsSync(cscLink)) {
    return { filePath: path.resolve(cscLink), cleanup: () => {} };
  }
  const cleanBase64 = cscLink.replace(/^data:[^;]+;base64,/, '').trim();
  const tempFile = path.join(
    os.tmpdir(),
    `myraa-signing-cert-${process.pid}-${Date.now()}.pfx`,
  );
  fs.writeFileSync(tempFile, Buffer.from(cleanBase64, 'base64'));
  return {
    filePath: tempFile,
    cleanup: () => {
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch {}
    },
  };
}

/**
 * Materializes an ephemeral Azure Artifact Signing metadata.json file when
 * configured via environment variables.
 */
function materializeAzureMetadataFile(creds) {
  if (creds.metadataPath && fs.existsSync(creds.metadataPath)) {
    return { filePath: path.resolve(creds.metadataPath), cleanup: () => {} };
  }
  const metadata = {
    Endpoint: creds.endpoint,
    CodeSigningAccountName: creds.accountName,
    CertificateProfileName: creds.certificateProfileName,
    CorrelationId: `myraa-windows-${APP_VERSION}-${Date.now()}`,
  };
  const tempFile = path.join(
    os.tmpdir(),
    `myraa-azure-signing-metadata-${process.pid}-${Date.now()}.json`,
  );
  fs.writeFileSync(tempFile, JSON.stringify(metadata, null, 2), 'utf-8');
  return {
    filePath: tempFile,
    cleanup: () => {
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch {}
    },
  };
}

/**
 * Verifies an Authenticode signature via PowerShell Get-AuthenticodeSignature + X509Chain.
 */
function verifySignatureWithPowerShell(targetFile) {
  const psScript = `
    $sig = Get-AuthenticodeSignature -FilePath '${targetFile.replace(/'/g, "''")}'
    $cert = $sig.SignerCertificate
    $ts = $sig.TimeStamperCertificate
    $chainTrusted = $false
    if ($cert) {
      $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
      $chainTrusted = $chain.Build($cert)
    }
    [PSCustomObject]@{
      Status = [string]$sig.Status
      StatusMessage = [string]$sig.StatusMessage
      SignatureType = [string]$sig.SignatureType
      Subject = if ($cert) { [string]$cert.Subject } else { $null }
      Issuer = if ($cert) { [string]$cert.Issuer } else { $null }
      Thumbprint = if ($cert) { [string]$cert.Thumbprint } else { $null }
      NotBefore = if ($cert) { $cert.NotBefore.ToString('o') } else { $null }
      NotAfter = if ($cert) { $cert.NotAfter.ToString('o') } else { $null }
      DigestAlgorithm = if ($cert) { [string]$cert.SignatureAlgorithm.FriendlyName } else { $null }
      IsSha256 = if ($cert) { [bool]($cert.SignatureAlgorithm.FriendlyName -match 'sha256') } else { $false }
      IsChainComplete = [bool]$chainTrusted
      HasTimestamp = ($null -ne $ts)
      TimestampIssuer = if ($ts) { [string]$ts.Subject } else { $null }
    } | ConvertTo-Json -Compress
  `;
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', psScript],
    { encoding: 'utf-8' },
  );
  if (res.status !== 0 || !res.stdout) {
    throw new Error(
      `Get-AuthenticodeSignature failed for ${targetFile}: ${res.stderr || res.stdout}`,
    );
  }
  return JSON.parse(res.stdout.trim());
}

/**
 * Builds the signtool.exe CLI arguments for either Option A (Azure Artifact Signing)
 * or Option B (CA-issued OV/EV Authenticode certificate).
 */
function buildSignToolArgs(creds, targetFile, options = {}) {
  const baseArgs = [
    'sign',
    '/v',
    '/fd',
    'sha256',
    '/d',
    'MYRAA Desktop AI Assistant',
    '/du',
    PRODUCTION_URL,
  ];

  if (creds.mode === 'azure-artifact-signing') {
    const dlibPath = options.dlibPath || creds.dlibPath;
    const dmdfPath = options.metadataFilePath || creds.metadataPath;
    const tsUrl = options.timestampUrl || creds.timestampUrl || AZURE_ACS_TIMESTAMP_URL;
    return [
      ...baseArgs,
      '/tr',
      tsUrl,
      '/td',
      'sha256',
      '/dlib',
      dlibPath,
      '/dmdf',
      dmdfPath,
      targetFile,
    ];
  }

  if (creds.mode === 'pfx') {
    baseArgs.push('/f', options.pfxFilePath || creds.cscLink);
    if (creds.cscPassword) {
      baseArgs.push('/p', creds.cscPassword);
    }
  } else if (creds.mode === 'store') {
    if (creds.certSha1) {
      baseArgs.push('/sha1', creds.certSha1);
    } else if (creds.certSubject) {
      baseArgs.push('/n', creds.certSubject);
    }
    baseArgs.push('/s', creds.certStore || 'My');
    if (creds.isLocalMachineStore) {
      baseArgs.push('/sm');
    }
  }

  if (creds.additionalCertFile && fs.existsSync(creds.additionalCertFile)) {
    baseArgs.push('/ac', path.resolve(creds.additionalCertFile));
  }

  const tsUrl = options.timestampUrl || DEFAULT_TIMESTAMP_SERVERS[0];
  return [...baseArgs, '/tr', tsUrl, '/td', 'sha256', targetFile];
}

/**
 * Signs a single Windows executable using SHA-256 and RFC 3161 timestamping.
 */
async function signWindowsFile(targetFile, env = process.env) {
  const resolvedPath = path.resolve(targetFile);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Target executable to sign does not exist: ${resolvedPath}`);
  }

  // Ensure standard PE executables have complete MYRAA / Mishtron Labs VersionInfo before signing
  stampPeMetadata(resolvedPath);

  const strictMode = isStrictSigningRequired(env);
  const creds = resolveSigningCredentials(env);

  if (!creds) {
    if (strictMode) {
      throw new Error(
        `[MYRAA-Authenticode] STRICT SIGNING FAILURE (MYRAA_REQUIRE_WINDOWS_SIGNING=true): No trusted production signing credentials found for ${path.basename(resolvedPath)}. Configure Option A (AZURE_ARTIFACT_SIGNING_ENDPOINT, AZURE_ARTIFACT_SIGNING_ACCOUNT_NAME, AZURE_ARTIFACT_SIGNING_CERT_PROFILE_NAME) or Option B (WIN_CSC_LINK / CSC_LINK / WIN_CERTIFICATE_SHA1 / WIN_CERTIFICATE_SUBJECT_NAME).`,
      );
    }
    console.log(
      `  • [MYRAA-Authenticode] UNSIGNED DEVELOPMENT BUILD (${path.basename(resolvedPath)}): Unsigned Development / Personal Testing Build (MYRAA_REQUIRE_WINDOWS_SIGNING=false). Skipping Authenticode signing without fake/self-signed cert.`,
    );
    return false;
  }

  const signtool = await resolveSignToolPath();
  let pfxHandle = null;
  let azureMetadataHandle = null;

  try {
    let signedOk = false;
    let lastErr = '';

    if (creds.mode === 'azure-artifact-signing') {
      azureMetadataHandle = materializeAzureMetadataFile(creds);
      const tsCandidates = [creds.timestampUrl, ...DEFAULT_TIMESTAMP_SERVERS].filter(
        (v, i, a) => Boolean(v) && a.indexOf(v) === i,
      );
      for (const tsUrl of tsCandidates) {
        const args = buildSignToolArgs(creds, resolvedPath, {
          dlibPath: creds.dlibPath,
          metadataFilePath: azureMetadataHandle.filePath,
          timestampUrl: tsUrl,
        });
        const run = spawnSync(signtool, args, { encoding: 'utf-8', timeout: 120_000 });
        if (run.status === 0) {
          signedOk = true;
          break;
        }
        lastErr = `${run.stdout || ''}\n${run.stderr || ''}`.trim();
      }
    } else {
      if (creds.mode === 'pfx') {
        pfxHandle = materializePfxFile(creds.cscLink);
      }
      for (const tsUrl of DEFAULT_TIMESTAMP_SERVERS) {
        const args = buildSignToolArgs(creds, resolvedPath, {
          pfxFilePath: pfxHandle ? pfxHandle.filePath : undefined,
          timestampUrl: tsUrl,
        });
        const run = spawnSync(signtool, args, { encoding: 'utf-8', timeout: 120_000 });
        if (run.status === 0) {
          signedOk = true;
          break;
        }
        lastErr = `${run.stdout || ''}\n${run.stderr || ''}`.trim();
      }
    }

    if (!signedOk) {
      throw new Error(
        `[MYRAA-Authenticode] signtool.exe failed for ${path.basename(resolvedPath)} (${creds.provider}): ${lastErr}`,
      );
    }

    // 1. Verify Default Authenticode Policy & Certificate Chain via signtool verify /pa /v
    const verifyRun = spawnSync(signtool, ['verify', '/pa', '/v', resolvedPath], {
      encoding: 'utf-8',
      timeout: 60_000,
    });
    if (verifyRun.status !== 0) {
      throw new Error(
        `[MYRAA-Authenticode] signtool verify /pa failed for ${path.basename(resolvedPath)}: ${verifyRun.stdout || ''}\n${verifyRun.stderr || ''}`,
      );
    }

    // 2. Verify Status, Chain, RFC 3161 Timestamp, Publisher, and SHA-256 via PowerShell
    const psCheck = verifySignatureWithPowerShell(resolvedPath);
    if (psCheck.Status !== 'Valid') {
      throw new Error(
        `[MYRAA-Authenticode] Get-AuthenticodeSignature status is "${psCheck.Status}" (${psCheck.StatusMessage}) for ${path.basename(resolvedPath)}`,
      );
    }
    if (!psCheck.IsChainComplete) {
      throw new Error(
        `[MYRAA-Authenticode] Certificate chain verification failed for ${path.basename(resolvedPath)}`,
      );
    }
    if (!psCheck.HasTimestamp) {
      throw new Error(
        `[MYRAA-Authenticode] RFC 3161 timestamp missing on ${path.basename(resolvedPath)}`,
      );
    }
    if (!psCheck.IsSha256) {
      throw new Error(
        `[MYRAA-Authenticode] Signature digest is "${psCheck.DigestAlgorithm}" (expected SHA-256) on ${path.basename(resolvedPath)}`,
      );
    }
    const expectedPublisher = (
      env.MYRAA_EXPECTED_PUBLISHER_SUBJECT || PUBLISHER_NAME
    ).trim();
    if (!psCheck.Subject || !psCheck.Subject.includes(expectedPublisher)) {
      throw new Error(
        `[MYRAA-Authenticode] Signer certificate subject "${psCheck.Subject}" does not match expected publisher "${expectedPublisher}" on ${path.basename(resolvedPath)}`,
      );
    }

    console.log(
      `  • [MYRAA-Authenticode] SIGNED & VERIFIED ${path.basename(resolvedPath)} (Provider="${creds.provider}", Subject="${psCheck.Subject}", Timestamp="${psCheck.TimestampIssuer}")`,
    );
    return true;
  } finally {
    if (pfxHandle) {
      pfxHandle.cleanup();
    }
    if (azureMetadataHandle) {
      azureMetadataHandle.cleanup();
    }
  }
}

/**
 * Default export invoked by electron-builder's `win.signtoolOptions.sign` hook.
 */
async function signHook(configuration) {
  const targetPath =
    typeof configuration === 'string' ? configuration : configuration?.path;
  if (!targetPath) return false;
  return signWindowsFile(targetPath);
}

module.exports = signHook;
module.exports.signWindowsFile = signWindowsFile;
module.exports.stampPeMetadata = stampPeMetadata;
module.exports.resolveSigningCredentials = resolveSigningCredentials;
module.exports.resolveAzureSigningDlibPath = resolveAzureSigningDlibPath;
module.exports.buildSignToolArgs = buildSignToolArgs;
module.exports.isStrictSigningRequired = isStrictSigningRequired;
module.exports.verifySignatureWithPowerShell = verifySignatureWithPowerShell;
