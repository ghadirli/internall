'use strict';

/**
 * electron-builder afterPack hook.
 *
 * There is no Apple Developer ID here, so `mac.identity` is null and
 * electron-builder skips signing entirely. An app with no proper signature is
 * reported by Gatekeeper as *damaged* on Apple Silicon, which is the worst
 * possible message for whoever you send it to. Signing ad-hoc here — before the
 * DMG is assembled — at least gets the ordinary "unidentified developer"
 * treatment, which a recipient can get past without the Terminal.
 */
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  // A universal build packs each architecture into its own `*-temp` directory
  // first, then merges them — and the merge insists every non-binary file match
  // byte for byte. Signing a temp pass changes _CodeSignature and breaks it, so
  // only the merged app gets signed.
  if (context.appOutDir.includes('-temp')) return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', appPath], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed  ${appPath}`);
};
