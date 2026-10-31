#!/usr/bin/env bash
# Install crow's bundled extensions (./bundled-exts.json) into every packaged
# tree under ./vscodium as BUILT-INS.
#
#   ./bundle-exts.sh [platform] [arch]   default: linux x64
#
# The platform is VS Code's, not the OS name: linux, darwin or win32. It is also
# the Open VSX targetPlatform a `targetPlatform: "auto"` entry resolves to.
#
# Built-ins are scanned from a tree's extensions dir at startup, so bundling the
# Jupyter + Python stack this way means the notebook kernel picker and the
# interpreter/environment pickers work with no marketplace install and no
# first-run network -- in the desktop app and in the web build alike.
#
# vsix downloads are cached in .build/exts/, so only the first run (or a version
# bump in the manifest) needs the network. ./build.sh calls this after gulp and
# before --deb, so the .deb carries the extensions too.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

PLATFORM_OS="${1:-linux}"
ARCH="${2:-x64}"
PLATFORM="${PLATFORM_OS}-${ARCH}"
MANIFEST="./bundled-exts.json"
CACHE="./.build/exts"

[[ -f "${MANIFEST}" ]] || { echo "crow-gui: no ${MANIFEST}" >&2; exit 1; }
command -v unzip >/dev/null 2>&1 || { echo "crow-gui: bundle-exts.sh needs unzip" >&2; exit 1; }

# Only the trees this build actually produced (a --no-web build has no reh-web,
# reh exists only with --reh). macOS nests the workbench inside the .app bundle.
if [[ "${PLATFORM_OS}" == "darwin" ]]; then
  # A glob that matches nothing stays literal, and [[ -d ]] then fails quietly —
  # an `ls` in a command substitution would trip `set -e` instead.
  DESKTOP_EXTS=""
  for app in "vscodium/VSCode-${PLATFORM}"/*.app; do
    [[ -d "${app}" ]] || continue
    DESKTOP_EXTS="${app}/Contents/Resources/app/extensions"
    break
  done
else
  DESKTOP_EXTS="vscodium/VSCode-${PLATFORM}/resources/app/extensions"
fi

TARGETS=()
for d in "${DESKTOP_EXTS}" \
         "vscodium/vscode-reh-web-${PLATFORM}/extensions" \
         "vscodium/vscode-reh-${PLATFORM}/extensions"; do
  if [[ -d "${d}" ]]; then TARGETS+=("${d}"); fi
done
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "crow-gui: no packaged tree for ${PLATFORM} under ./vscodium — nothing to bundle into" >&2
  exit 1
fi

# jq on Windows ships as a native mingw binary and writes CRLF to a pipe, so
# every value it hands back carries a trailing CR: a gallery URL of
# "https://open-vsx.org/api\r" is what `curl: (3) URL rejected: Bad path` was.
# One `tr` after jq, not a `\r`-strip at every use.
jqx() { jq "$@" | tr -d '\r'; }

GALLERY="$(jqx -r '.gallery' "${MANIFEST}")"
mkdir -p "${CACHE}"

while read -r id version tp; do
  [[ -n "${id}" ]] || continue
  if [[ "${tp}" == "auto" ]]; then tp="${PLATFORM}"; fi
  ns="${id%%.*}"; name="${id#*.}"
  slug="${id}-${version}${tp:+@${tp}}"
  vsix="${CACHE}/${slug}.vsix"

  if [[ ! -f "${vsix}" ]]; then
    api="${GALLERY}/${ns}/${name}${tp:+/${tp}}/${version}"
    # ${x@Q} quotes invisibly wrong input (a stray CR, a space) as $'\r', so the
    # log shows the bug instead of a URL that looks correct.
    if ! meta="$(curl -fsSL "${api}")"; then
      printf 'crow-gui: curl failed for %s\n' "${api@Q}" >&2
      exit 1
    fi
    url="$(jqx -r '.files.download // empty' <<<"${meta}")"
    if [[ -z "${url}" ]]; then
      printf 'crow-gui: Open VSX has no download for %s (%s)\n' "${slug@Q}" "${api@Q}" >&2
      exit 1
    fi
    echo "crow-gui: fetching ${slug}.vsix from ${url}"
    curl -fsSL --retry 3 -o "${vsix}.part" "${url}"
    mv "${vsix}.part" "${vsix}"
  fi

  # A vsix is a zip whose `extension/` member IS the extension directory.
  stage="$(mktemp -d)"
  unzip -q "${vsix}" 'extension/*' -d "${stage}"
  if [[ ! -f "${stage}/extension/package.json" ]]; then
    echo "crow-gui: ${slug}.vsix has no extension/package.json" >&2
    rm -rf "${stage}"; exit 1
  fi
  for d in "${TARGETS[@]}"; do
    rm -rf "${d:?}/${id}"
    cp -r "${stage}/extension" "${d}/${id}"
  done
  rm -rf "${stage}"
  echo "crow-gui: built-in ${id} ${version}${tp:+ (${tp})} → ${#TARGETS[@]} tree(s)"
done < <(jqx -r '.extensions[] | [.id, .version, (.targetPlatform // "")] | @tsv' "${MANIFEST}")
