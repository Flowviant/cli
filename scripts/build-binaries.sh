#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
command -v bun >/dev/null 2>&1 || { echo 'bun is required to build releases' >&2; exit 1; }
version=$(bun -p 'require("./package.json").version')
mkdir -p dist

for target in linux-x64 linux-arm64 darwin-x64 darwin-arm64; do
  name="flowviant-$version-$target"
  bun build --compile --target="bun-$target" --define "__FLOWVIANT_BUILD_VERSION__=\"$version\"" bin/cli.mjs --outfile="dist/$name"
done

bun -e '
const fs = require("node:fs");
const crypto = require("node:crypto");
const version = require("./package.json").version;
const files = {};
for (const target of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]) {
  const name = `flowviant-${version}-${target}`;
  const data = fs.readFileSync(`dist/${name}`);
  files[target] = { name, sha256: crypto.createHash("sha256").update(data).digest("hex"), bytes: data.length };
}
fs.writeFileSync("dist/manifest.json", JSON.stringify({ version, files }) + "\n");
'
echo "Built dist/manifest.json for $version"
