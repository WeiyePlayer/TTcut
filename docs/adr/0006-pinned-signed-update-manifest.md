# Verify self-signed updates with a pinned signed manifest

TTcut keeps its self-signed `CN=weiye` Authenticode certificate instead of
purchasing a publicly trusted code-signing certificate. Windows therefore
reports an otherwise intact installer as `UnknownError / UntrustedRoot`.
`electron-updater` treats every non-`Valid` Authenticode result as an invalid
publisher and cannot install the update.

The application replaces the default NSIS code-signature verifier with a
strict application-owned verifier. Every official Release contains:

- `update-manifest.json`, binding the version, channel, installer filename,
  byte length, SHA-512 digest, Authenticode subject, and certificate thumbprint;
- `update-manifest.json.sig`, an RSA-SHA256 signature over the exact manifest
  bytes, produced by the same non-exportable private key used for Authenticode.

Main embeds the public certificate through `src/main/update-trust.json`. It
downloads the two small manifest assets from the exact `v<version>` GitHub
Release, verifies the detached signature before parsing the manifest, hashes
the downloaded installer as a stream, and inspects Authenticode. It accepts
either a normally `Valid` signature or the pinned self-signed certificate whose
only chain failure is `UntrustedRoot`. A missing timestamp, changed file,
unknown key, wrong subject/thumbprint, malformed manifest, or any other
Authenticode state is rejected.

Official release construction fails unless the selected certificate is already
present in the embedded trust list. Certificate rotation therefore requires an
overlap release: first ship an application that trusts both the current and
next public certificates while still signing with the current key, and only
then sign a later Release with the next key.

This decision does not add the self-signed certificate to a user's Windows
Root store, including during release verification, and does not disable update
verification. Versions 1.1.0 and 1.1.1
cannot execute this verifier, so they require one Bootstrap Update by manually
installing 1.1.2. Automatic updates resume from 1.1.2 onward.
