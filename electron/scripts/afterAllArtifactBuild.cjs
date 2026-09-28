'use strict';

/**
 * MYRAA — electron-builder `afterAllArtifactBuild` Hook
 *
 * Ensures MYRAA.exe inside win-unpacked retains its complete OriginalFilename /
 * FileDescription PE metadata (without mutating an already-signed binary) and
 * runs the post-build Authenticode & Metadata Verification audit across all
 * Windows release artifacts.
 */

const fs = require('fs');
const path = require('path');
const { stampPeMetadata, resolveSigningCredentials } = require('./signWindowsExecutable.cjs');
const { runWindowsReleaseAudit } = require('./verifyWindowsRelease.cjs');

module.exports = async function afterAllArtifactBuild(buildResult) {
  const outDir = buildResult.outDir || path.resolve(process.cwd(), 'release');
  const unpackedExe = path.join(outDir, 'win-unpacked', 'MYRAA.exe');
  if (fs.existsSync(unpackedExe) && !resolveSigningCredentials()) {
    stampPeMetadata(unpackedExe, {
      fileDescription: 'MYRAA Desktop AI Assistant',
      internalName: 'MYRAA',
      originalFilename: 'MYRAA.exe',
    });
  }

  runWindowsReleaseAudit({ outDir, throwOnMetadataError: true });
  return [];
};
