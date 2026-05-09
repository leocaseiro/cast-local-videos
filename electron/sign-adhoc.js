// electron-builder afterPack hook: ad-hoc sign the .app on macOS.
//
// We don't have an Apple Developer ID, so electron-builder's signing step
// gets skipped — leaving the bundle with only the linker-supplied binary
// signature. On Apple Silicon, downloading such a bundle and trying to
// launch it surfaces "CastLocalVideos.app is damaged and can't be opened",
// because Gatekeeper requires a real bundle signature on quarantined apps.
//
// Running `codesign --sign -` produces a full ad-hoc signature (sealed
// resources, Info.plist binding, the works). It's not Developer-ID signed,
// so users still see the "unidentified developer" warning on first launch,
// but right-click → Open / Open Anyway then succeeds.

const { execSync } = require('child_process');
const path = require('path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`[adhoc-sign] codesign --sign - "${appPath}"`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });

  // Sanity check: confirm the bundle now has sealed resources.
  const out = execSync(`codesign -dv --verbose=2 "${appPath}" 2>&1`).toString();
  if (!/Signature=adhoc/.test(out) || /Sealed Resources=none/.test(out)) {
    throw new Error(`[adhoc-sign] codesign produced an incomplete signature:\n${out}`);
  }
  console.log('[adhoc-sign] ad-hoc signed OK');
};
