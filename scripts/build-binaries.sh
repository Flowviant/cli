#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
command -v bun >/dev/null 2>&1 || { echo 'bun is required to build releases' >&2; exit 1; }
version=$(bun -p 'require("./package.json").version')
mkdir -p dist

# Every binary is built on bun's OFFICIAL runtime for its target, downloaded
# from bun's GitHub release. When --target matches the build machine, bun
# otherwise copies ITS OWN executable, and a bun from nix names
# /nix/store/…/ld-linux-x86-64.so.2 as its loader: 0.100.0 and 0.101.0 shipped
# linux-x64 binaries that failed on every normal distro with "cannot execute:
# required file not found". x64 builds are `baseline` (no AVX2 needed).
bun_version=$(bun --version)
cache="${XDG_CACHE_HOME:-$HOME/.cache}/flowviant-bun/$bun_version"
mkdir -p "$cache"

runtime() {
  zip="$1"
  if [ ! -x "$cache/$zip/bun" ]; then
    curl -fsSL -o "$cache/$zip.zip" "https://github.com/oven-sh/bun/releases/download/bun-v$bun_version/$zip.zip"
    unzip -oq "$cache/$zip.zip" -d "$cache"
  fi
  printf %s "$cache/$zip/bun"
}

for pair in linux-x64:bun-linux-x64-baseline linux-arm64:bun-linux-aarch64 darwin-x64:bun-darwin-x64-baseline darwin-arm64:bun-darwin-aarch64; do
  target=${pair%%:*}
  zip=${pair#*:}
  name="flowviant-$version-$target"
  case "$zip" in *x64-baseline) flag="bun-$target-baseline" ;; *) flag="bun-$target" ;; esac
  bun build --compile --target="$flag" --compile-executable-path="$(runtime "$zip")" --define "__FLOWVIANT_BUILD_VERSION__=\"$version\"" bin/cli.mjs --outfile="dist/$name"
done

# A Linux binary must name the loader every glibc distro has. Refuse anything
# else (a /nix/store path above all) before it can reach a release.
bun -e '
const fs = require("node:fs");
const version = require("./package.json").version;
const want = { "linux-x64": "/lib64/ld-linux-x86-64.so.2", "linux-arm64": "/lib/ld-linux-aarch64.so.1" };
for (const [target, loader] of Object.entries(want)) {
  const b = fs.readFileSync(`dist/flowviant-${version}-${target}`);
  const phoff = Number(b.readBigUInt64LE(0x20)), size = b.readUInt16LE(0x36), count = b.readUInt16LE(0x38);
  let interp = null;
  for (let i = 0; i < count; i++) {
    const at = phoff + i * size;
    if (b.readUInt32LE(at) !== 3) continue; // PT_INTERP
    const off = Number(b.readBigUInt64LE(at + 8)), len = Number(b.readBigUInt64LE(at + 32));
    interp = b.subarray(off, off + len).toString().replace(/\0+$/, "");
  }
  if (interp !== loader) { console.error(`dist/flowviant-${version}-${target} names loader ${interp}, not ${loader}`); process.exit(1); }
}
'

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
