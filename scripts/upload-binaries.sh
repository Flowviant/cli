#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
command -v bun >/dev/null 2>&1 || { echo 'bun is required to upload releases' >&2; exit 1; }
version=$(bun -p 'require("./package.json").version')
test -f dist/manifest.json || { echo 'run scripts/build-binaries.sh first' >&2; exit 1; }
bun -e '
const fs = require("node:fs");
const crypto = require("node:crypto");
const m = require("./dist/manifest.json");
const p = require("./package.json");
const targets = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
if (m.version !== p.version || Object.keys(m.files).length !== targets.length) process.exit(1);
for (const target of targets) {
  const file = m.files[target];
  const name = `flowviant-${m.version}-${target}`;
  if (file?.name !== name) process.exit(1);
  const data = fs.readFileSync(`dist/${name}`);
  if (data.length !== file.bytes || crypto.createHash("sha256").update(data).digest("hex") !== file.sha256) process.exit(1);
}
' || {
  echo 'manifest checksums do not match this four-target release' >&2; exit 1;
}

# Existing CODEGRAPH bucket in apps/api/wrangler.toml. Publish latest last:
# a client must never see a manifest before every binary is in R2.
bucket=flowviant-code-graphs
for target in linux-x64 linux-arm64 darwin-x64 darwin-arm64; do
  name="flowviant-$version-$target"
  test -f "dist/$name" || { echo "missing dist/$name" >&2; exit 1; }
  bunx wrangler r2 object put "$bucket/daemon-releases/$version/$name" --file="dist/$name" --content-type=application/octet-stream --remote
done
bunx wrangler r2 object put "$bucket/daemon-releases/$version/manifest.json" --file=dist/manifest.json --content-type=application/json --remote
bunx wrangler r2 object put "$bucket/daemon-releases/latest.json" --file=dist/manifest.json --content-type=application/json --remote
