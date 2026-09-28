# MYRAA Windows Production Code-Signing & Release Trust Architecture

## 1. Build Modes

MYRAA Desktop supports two explicit Windows build modes controlled by `MYRAA_REQUIRE_WINDOWS_SIGNING`:

### A. Development / Personal Testing Mode (`MYRAA_REQUIRE_WINDOWS_SIGNING=false` — Default)
- Produces a fully functional Windows build (`release/MYRAA-Setup-1.0.0.exe` and `release/MYRAA-Portable-1.0.0.exe`) without requiring a certificate.
- Stamps complete `VS_VERSION_INFO` PE metadata (`Mishtron Labs` / `MYRAA` / `1.0.0`) on all executables (`MYRAA.exe`, `myraa-agent.exe`, `MYRAA-Setup-1.0.0.exe`, `MYRAA-Portable-1.0.0.exe`, `Uninstall MYRAA.exe`).
- Never creates or embeds a fake or self-signed certificate.
- Clearly classifies the output as:
  - **`UNSIGNED DEVELOPMENT BUILD`**
  - **`Unsigned Development / Personal Testing Build`**
  - **`isProductionTrustedRelease: false`**

### B. Strict Production Signing Mode (`MYRAA_REQUIRE_WINDOWS_SIGNING=true`)
- Requires a legitimate, trusted production signing identity (Option A or Option B below).
- **Fails the build immediately** if:
  1. No production certificate / Azure Artifact Signing configuration is present.
  2. Signing fails on any executable (`MYRAA.exe`, `myraa-agent.exe`, `elevate.exe`, `Uninstall MYRAA.exe`, `MYRAA-Setup-1.0.0.exe`, `MYRAA-Portable-1.0.0.exe`).
  3. Post-sign `signtool.exe verify /pa /v` fails.
  4. Certificate chain verification (`X509Chain.Build`) fails.
  5. RFC 3161 SHA-256 timestamp signature is missing.
  6. Signer certificate subject does not match publisher (`Mishtron Labs`).
  7. Signature digest algorithm is not `sha256`.

---

## 2. Production Signing Providers (Zero Application Code Changes Required)

Both providers are implemented in [`electron/scripts/signWindowsExecutable.cjs`](../electron/scripts/signWindowsExecutable.cjs) and verified in [`electron/scripts/verifyWindowsRelease.cjs`](../electron/scripts/verifyWindowsRelease.cjs).

### OPTION A — Microsoft Azure Artifact Signing (formerly Azure Trusted Signing)

#### Prerequisite: Microsoft Eligibility & Identity Validation
Before production signing with Azure Artifact Signing, Microsoft requires:
1. An active Azure subscription and an **Artifact Signing Account**.
2. Completion of **Identity Validation** (Organization or Individual Developer validation) inside the Azure Portal.
3. Creation of a **Public Trust Certificate Profile** under the validated identity (`Mishtron Labs`).
4. Assignment of the **Artifact Signing Certificate Profile Signer** RBAC role to the signing principal (CI/CD service principal or developer identity).
5. Installation of the Microsoft Artifact Signing Client Tools (`Azure.CodeSigning.Dlib.dll`).

#### Environment Variables / CI Secrets (Never Commit to Git)
```powershell
$env:MYRAA_REQUIRE_WINDOWS_SIGNING = "true"
$env:AZURE_ARTIFACT_SIGNING_ENDPOINT = "https://eus.codesigning.azure.net/"
$env:AZURE_ARTIFACT_SIGNING_ACCOUNT_NAME = "<artifact-signing-account-name>"
$env:AZURE_ARTIFACT_SIGNING_CERT_PROFILE_NAME = "<public-trust-profile-name>"

# Standard Azure DefaultAzureCredential authentication (or OIDC / az login):
$env:AZURE_TENANT_ID = "<azure-tenant-id>"
$env:AZURE_CLIENT_ID = "<azure-client-id>"
$env:AZURE_CLIENT_SECRET = "<azure-client-secret>"

npm run dist
```

#### Automated Flow
`Azure Artifact Signing` → `Authenticated signing identity (Azure.CodeSigning.Dlib.dll)` → `SHA-256 Authenticode (/fd sha256)` → `Microsoft ACS RFC 3161 Timestamp (http://timestamp.acs.microsoft.com /td sha256)` → `signtool verify /pa + Get-AuthenticodeSignature + X509Chain` → `Signed Release Artifact`.

---

### OPTION B — CA-Issued OV / EV Authenticode Certificate (Fallback)

If Azure Artifact Signing is unavailable in your region or account tier, the pipeline supports any standard Certificate Authority (DigiCert, Sectigo, GlobalSign, SSL.com) OV or EV code-signing certificate:

#### B1. PKCS#12 (`.pfx` / `.p12`) File or Base64 Secret
```powershell
$env:MYRAA_REQUIRE_WINDOWS_SIGNING = "true"
$env:WIN_CSC_LINK = "C:\secure\path\mishtron-labs-ov.pfx" # or base64-encoded PFX string
$env:WIN_CSC_KEY_PASSWORD = "<pfx-password>"

npm run dist
```

#### B2. Windows Certificate Store / Hardware USB Token / Cloud HSM
```powershell
$env:MYRAA_REQUIRE_WINDOWS_SIGNING = "true"
$env:WIN_CERTIFICATE_SHA1 = "<40-char-sha1-thumbprint>"
$env:WIN_CERTIFICATE_STORE = "My"

npm run dist
```
