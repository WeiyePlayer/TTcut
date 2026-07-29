# TTcut v1.1.1

[简体中文](release-notes-v1.1.1.md) | **English**

`v1.1.1` is a stable patch in the TTcut 1.1 line. It focuses on packaged-update detection, the multi-video entry flow, recoverable batch calibration, and installer-script compatibility.

## Packaging and multi-video workflow

- Automatic updates are enabled only for packaged Windows x64 builds that contain `app-update.yml`, so local packages no longer attempt update checks.
- When the registered installation root differs from the current resource path, official installations still reject an invalid layout while local packages reuse the registered Component Store.
- The upload page accepts multiple MP4 files for Batch tasks and uses consistent Chinese and English multi-video guidance.
- A capture-angle guide helps users check the table, camera, and player positions before analysis.

## Recoverable batch calibration

- Batch tasks automatically calibrate videos in queue order when the page opens.
- An item whose automatic calibration fails remains in the queue and can enter manual four-corner calibration from its cover.
- Ready items can continue through analysis and export without being blocked by items waiting for manual calibration.

## Installer compatibility

- The installation-space check, default-root selection, version comparison, legacy-process shutdown, registration commit, and legacy-uninstall helpers now use syntax available in PowerShell 2.
- Windows x64 remains the primary release target. PowerShell 2 syntax compatibility does not guarantee complete support for every older Windows or Windows Server release, x86, or ARM64.

## Download and verification

- Download `TTcut-1.1.1-x64-Setup.exe`.
- Use `SHA256SUMS.txt` from the same Release to verify the installer, blockmap, update metadata, and SBOM.
- `latest.yml` uses the stable `latest` channel so existing stable builds can discover this version.

The official installer, uninstaller, and application are signed with the self-signed `CN=weiye` Authenticode certificate and carry RFC 3161 timestamps. The certificate is not chained to a public Windows trust root, so Windows may still show an unknown-publisher or SmartScreen warning.
