'use strict';

/**
 * MYRAA — electron-builder `afterPack` Hook
 *
 * Responsibilities:
 *   1. Patch NsisTarget.prototype.computeVersionKey in-memory so makensis.exe
 *      natively embeds InternalName and OriginalFilename in both
 *      MYRAA-Setup-1.0.0.exe and MYRAA-Portable-1.0.0.exe (and Uninstall MYRAA.exe).
 *   2. Stamp complete Mishtron Labs / MYRAA PE VS_VERSION_INFO metadata and
 *      application icon onto win-unpacked/MYRAA.exe and
 *      win-unpacked/resources/agent/myraa-agent.exe.
 *   3. Sign bundled native executables inside extraResources (myraa-agent.exe
 *      and elevate.exe) before NSIS packages them.
 */

const fs = require('fs');
const path = require('path');
const { stampPeMetadata, signWindowsFile } = require('./signWindowsExecutable.cjs');

function patchNsisVersionKeyGenerator() {
  try {
    const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget');
    if (NsisTarget && NsisTarget.prototype && !NsisTarget.prototype._myraaPatched) {
      const origComputeVersionKey = NsisTarget.prototype.computeVersionKey;
      NsisTarget.prototype.computeVersionKey = function (short = false) {
        const keys = origComputeVersionKey.call(this, short);
        const localeId = (this.options && this.options.language) || '1033';
        const version = (this.packager && this.packager.appInfo && this.packager.appInfo.version) || '1.0.0';
        const isPortable = Boolean(this.isPortable);
        const internalName = isPortable ? 'MYRAA-Portable' : short ? 'Uninstall-MYRAA' : 'MYRAA-Setup';
        const originalFilename = isPortable
          ? `MYRAA-Portable-${version}.exe`
          : short
            ? 'Uninstall MYRAA.exe'
            : `MYRAA-Setup-${version}.exe`;

        if (!keys.some((k) => k.includes('InternalName'))) {
          keys.push(`/LANG=${localeId} InternalName "${internalName}"`);
        }
        if (!keys.some((k) => k.includes('OriginalFilename'))) {
          keys.push(`/LANG=${localeId} OriginalFilename "${originalFilename}"`);
        }
        return keys;
      };
      NsisTarget.prototype._myraaPatched = true;
    }
  } catch (err) {
    console.warn('[MYRAA-afterPack] Could not patch NsisTarget.computeVersionKey:', err.message);
  }
}

// Apply patch immediately on module load as well as inside the hook
patchNsisVersionKeyGenerator();

module.exports = async function afterPack(context) {
  patchNsisVersionKeyGenerator();

  const appOutDir = context.appOutDir;
  const projectDir = context.packager.projectDir;
  const iconPath = path.join(projectDir, 'build', 'icon.ico');

  const mainExe = path.join(appOutDir, 'MYRAA.exe');
  const agentExe = path.join(appOutDir, 'resources', 'agent', 'myraa-agent.exe');
  const elevateExe = path.join(appOutDir, 'resources', 'elevate.exe');

  // 1. Remove any accidental log or pycache files in resources/agent
  const agentLogsDir = path.join(appOutDir, 'resources', 'agent', 'logs');
  if (fs.existsSync(agentLogsDir)) {
    fs.rmSync(agentLogsDir, { recursive: true, force: true });
  }

  // 2. Stamp complete PE VersionInfo on MYRAA.exe and bundled myraa-agent.exe
  if (fs.existsSync(mainExe)) {
    stampPeMetadata(mainExe, {
      fileDescription: 'MYRAA Desktop AI Assistant',
      internalName: 'MYRAA',
      originalFilename: 'MYRAA.exe',
      iconPath,
    });
    await signWindowsFile(mainExe);
  }

  if (fs.existsSync(agentExe)) {
    stampPeMetadata(agentExe, {
      fileDescription: 'MYRAA Native Desktop Control Agent',
      internalName: 'myraa-agent',
      originalFilename: 'myraa-agent.exe',
      iconPath,
    });
    await signWindowsFile(agentExe);
  }

  if (fs.existsSync(elevateExe)) {
    await signWindowsFile(elevateExe);
  }
};
