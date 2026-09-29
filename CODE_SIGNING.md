# Code signing

The code signing policy for Flowviant is published at
**[flowviant.com/code-signing](https://flowviant.com/code-signing)**.

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

What that means for this repository:

- The binaries built here are for Linux and macOS and are **not** signed with that certificate. The certificate signs the Windows app, [Flowviant/desktop](https://github.com/Flowviant/desktop), whose installer carries this repository's `linux-x64` build.
- Every release is built by [`.github/workflows/release.yml`](.github/workflows/release.yml) on GitHub-hosted runners from a `v*` tag, with `scripts/build-binaries.sh`. Each binary and `manifest.json` gets a GitHub build provenance attestation, and the GitHub Release lists their SHA-256 in `SHA256SUMS`. Check a download with `gh attestation verify <file> --repo Flowviant/cli`.
- The Windows app's release workflow downloads the `linux-x64` binary from this repository's GitHub Release, verifies its attestation and its SHA-256 against `manifest.json`, and only then bundles it.
- The installer (`curl -fsSL https://api.flowviant.com/install.sh | sh`) and the daemon's self-update check each binary's SHA-256 against the release manifest before running it.

Team roles, multi-factor authentication and the privacy statement are on the policy page.
