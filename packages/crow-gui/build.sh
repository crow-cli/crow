#!/usr/bin/env bash
# Build crow's IDE: the desktop app and the web server, from the
# vendored VSCodium pipeline in ./vscodium with crow's branding from ./crow.env.
#
#   ./build.sh                desktop app + web server (linux x64, stable pin)
#   ./build.sh --arch arm64
#   ./build.sh --os osx|windows   build another platform (default: linux)
#   ./build.sh --no-web       desktop app only
#   ./build.sh --reh          also build the remote/ssh server (reh)
#   ./build.sh --latest       track newest upstream VS Code instead of the pin
#   ./build.sh --assets       also roll release artifacts into vscodium/assets/
#   ./build.sh --deb          also build the .deb (linux; needs fakeroot+dpkg-dev)
#   ./build.sh --rpm          also build the .rpm (linux; needs rpm + rpmbuild)
#   ./build.sh --msi          windows: also build the MSI (off by default —
#                             build/windows/msi/* is still VSCodium-branded)
#   ./build.sh --prepare-only fetch + patch + npm ci, stop before gulp
#   ./build.sh --fresh        delete vscodium/vscode/ and start the checkout over
#
# Each platform must be built ON that platform: the desktop packaging is
# electron-packager plus OS-native tools (dpkg/rpmbuild, hdiutil/zip, Inno
# Setup), and the Rust CLI is compiled for the host.
#
# Artifacts land in ./vscodium (all gitignored there):
#   VSCode-<platform>-<arch>/       desktop app (linux|darwin|win32)
#                                   linux/win32: bin/crow launches Electron
#   vscode-reh-web-<platform>-<arch>/  web server; bin/crow-server serves it
#   vscode-reh-<platform>-<arch>/   remote server (--reh only)
#   assets/                         (--assets only) — per-platform:
#     linux    .tar.gz, .deb (--deb), .rpm (--rpm), reh + reh-web + cli
#              .tar.gz, a .sha256/.sha1 beside each file
#     darwin   .zip, .dmg, reh + reh-web + cli .tar.gz, a .sha256/.sha1
#              beside each file (unsigned without CERTIFICATE_OSX_*)
#     win32    .zip, Inno system/user setup .exe, reh + reh-web (x64 only) and
#              cli .tar.gz
#
# Every packaged tree also carries crow's bundled extensions as BUILT-INS: the
# chat extension (built from ../vscode-acp with bun) and the Jupyter + Python
# stack pinned in ./bundled-exts.json, fetched from Open VSX by
# ./bundle-exts.sh and cached in .build/exts/.
#
# First run needs network (npm ci, cargo, electron/reh deps, the vsix fetches)
# and takes a while; a rebuild after a source change is mostly gulp. Requires:
# bash, git, jq, curl, unzip, node + npm matching vscode/.nvmrc, python3,
# libx11/libxkbfile/libsecret headers, rustup + cargo for the CLI, and bun —
# plus, per platform: fakeroot + dpkg-dev (--deb) and rpm + rpmbuild (--rpm) on
# linux, 7z and Inno Setup on windows (the Inno compiler comes from VS Code's
# own npm devDependencies).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
HERE="$(pwd)"

ARCH="x64"
BUILD_OS="${OS_NAME:-linux}"
REH="no"
REH_WEB="yes"
ASSETS="no"
DEB="no"
RPM="no"
MSI="no"
PREPARE_ONLY="no"
FRESH="no"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -a|--arch)      ARCH="$2"; shift 2 ;;
    --os)           BUILD_OS="$2"; shift 2 ;;
    --reh)          REH="yes"; shift ;;
    --no-web)       REH_WEB="no"; shift ;;
    --latest)       export VSCODE_LATEST=yes; shift ;;
    --assets)       ASSETS="yes"; shift ;;
    --deb)          DEB="yes"; shift ;;
    --rpm)          RPM="yes"; shift ;;
    --msi)          MSI="yes"; shift ;;
    --prepare-only) PREPARE_ONLY="yes"; shift ;;
    --fresh)        FRESH="yes"; shift ;;
    -h|--help)      awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)              echo "crow-gui: unknown argument: $1" >&2; exit 2 ;;
  esac
done

# shellcheck source=./crow.env
source ./crow.env

# VS Code's own platform names (the artifact-tree suffixes and the Open VSX
# targetPlatform values), which are not OS_NAME's: osx->darwin, windows->win32.
case "${BUILD_OS}" in
  linux)   PLAT="linux" ;;
  osx)     PLAT="darwin" ;;
  windows) PLAT="win32" ;;
  *) echo "crow-gui: --os must be linux, osx or windows (got '${BUILD_OS}')" >&2; exit 2 ;;
esac

# The desktop tree electron-packager produces, and the app dir inside it whose
# extensions/ holds the BUILT-INs. macOS nests the workbench one level deeper.
DESKTOP="VSCode-${PLAT}-${ARCH}"
if [[ "${BUILD_OS}" == "osx" ]]; then
  DESKTOP_APP="${DESKTOP}/${APP_NAME}.app/Contents/Resources/app"
else
  DESKTOP_APP="${DESKTOP}/resources/app"
fi

# Linux packages, and the Windows MSI, are built with host tools for this host.
if [[ "${DEB}" == "yes" || "${RPM}" == "yes" ]] && [[ "${BUILD_OS}" != "linux" ]]; then
  echo "crow-gui: --deb/--rpm are linux-only (--os is ${BUILD_OS})" >&2
  exit 2
fi
if [[ "${MSI}" == "yes" ]] && [[ "${BUILD_OS}" != "windows" ]]; then
  echo "crow-gui: --msi is windows-only (--os is ${BUILD_OS})" >&2
  exit 2
fi

# vscode/.nvmrc is a hard contract (node 24.x for this pin) but
# prepare_vscode.sh exports VSCODE_SKIP_NODE_VERSION_CHECK on linux, so a wrong
# node fails deep inside gulp instead of up front. Check here, and switch via
# fnm when it is available.
REQUIRED_NODE="$(cat vscodium/.nvmrc)"
CURRENT_NODE="$(node -v 2>/dev/null || echo none)"
if [[ "${CURRENT_NODE#v}" != "${REQUIRED_NODE}" ]]; then
  if command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env)"
    fnm install "${REQUIRED_NODE}" >/dev/null 2>&1 || true
    fnm use "${REQUIRED_NODE}" >/dev/null
    echo "crow-gui: node $(node -v) (fnm; .nvmrc wants ${REQUIRED_NODE})"
  else
    echo "crow-gui: node is ${CURRENT_NODE} but vscodium/.nvmrc wants v${REQUIRED_NODE}." >&2
    echo "  install fnm, or put node v${REQUIRED_NODE} on PATH, and re-run." >&2
    exit 1
  fi
fi

export SHOULD_BUILD=yes
export CI_BUILD=no
export OS_NAME="${BUILD_OS}"
export VSCODE_ARCH="${ARCH}"
export VSCODE_QUALITY=stable
export SHOULD_BUILD_REH="${REH}"
export SHOULD_BUILD_REH_WEB="${REH_WEB}"
export MAX_OLD_SPACE_SIZE="${MAX_OLD_SPACE_SIZE:-8192}"

# The pinned VS Code commit is a ~340MB fetch from GitHub. Seed it from a local
# clone instead when one has the commit: CROW_VSCODE_SRC=<path> forces a source,
# otherwise a sibling vscode/ checkout in the workspace is used if it matches.
if [[ -n "${CROW_VSCODE_SRC:-}" ]]; then
  export VSCODE_ORIGIN="${CROW_VSCODE_SRC}"
  echo "crow-gui: vscode source ${VSCODE_ORIGIN} (CROW_VSCODE_SRC)"
elif [[ -z "${VSCODE_ORIGIN:-}" && "${VSCODE_LATEST:-no}" != "yes" ]]; then
  PINNED_COMMIT="$(jq -r '.commit' vscodium/upstream/stable.json)"
  for candidate in "${HERE}/../../vscode" "${HOME}/src/crow-gui/vscode"; do
    [[ -e "${candidate}/.git" ]] || continue
    if git -C "${candidate}" cat-file -e "${PINNED_COMMIT}^{commit}" 2>/dev/null; then
      export VSCODE_ORIGIN="$(cd "${candidate}" && pwd)"
      echo "crow-gui: vscode source ${VSCODE_ORIGIN} @ ${PINNED_COMMIT:0:9} (local clone)"
      break
    fi
  done
fi

# The vendored pipeline reads many optional variables (RELEASE_VERSION,
# SHOULD_BUILD_CLI, npm_config_arch, …) and uses grep-in-pipeline, so it is not
# written for `set -u`/pipefail. Everything above keeps them; the sourced stages
# below do not.
set +u
set +o pipefail

cd vscodium

if [[ "${FRESH}" == "yes" && -d vscode ]]; then
  echo "crow-gui: --fresh — deleting vscode/ ($(du -sh vscode | cut -f1))"
  rm -rf vscode
fi

# get_repo.sh cannot run over an existing vscode/ (it git-inits and re-adds the
# remote), and prepare_vscode.sh cannot patch a tree twice, so resume from a
# prepared checkout when there is one. --fresh starts over.
if [[ -f vscode/.crow-prepared ]]; then
  export RELEASE_VERSION="$(cat vscode/.crow-prepared)"
  export MS_COMMIT="$(git -C vscode rev-parse HEAD)"
  export MS_TAG="$(jq -r '.tag' "upstream/${VSCODE_QUALITY}.json")"
  echo "crow-gui: reusing prepared vscode/ @ ${MS_COMMIT:0:9} (${RELEASE_VERSION})"
else
  # shellcheck disable=SC1091
  . ./get_repo.sh
  echo "crow-gui: RELEASE_VERSION=${RELEASE_VERSION} MS_TAG=${MS_TAG} MS_COMMIT=${MS_COMMIT:0:9}"
  # prepare_vscode.sh patches the pristine checkout IN PLACE and runs npm ci, so
  # it has to happen here: everything below — compile-web included — needs
  # vscode/node_modules. Writing .crow-prepared is both what lets a later run
  # resume and what makes the vendored build.sh skip its own prepare, which
  # cannot run twice (every patch would fail as already applied).
  # shellcheck disable=SC1091
  . ./prepare_vscode.sh
  echo "${RELEASE_VERSION}" > vscode/.crow-prepared
fi

if [[ "${PREPARE_ONLY}" == "yes" ]]; then
  echo "crow-gui: prepared vscodium/vscode (patched, npm ci done) — stopping before gulp"
  exit 0
fi

# prepare_vscode.sh copies the branding resources (src/stable/*: icons,
# .desktop, appdata) into the checkout only when it PREPARES it, so a resumed
# build would package stale art. The copy is idempotent; redo it every run.
( cp -rp src/stable/* vscode/ )

# prepare_vscode.sh copies the VENDORED LICENSE — VSCodium's MIT text — into the
# checkout as LICENSE.txt, so About → License would credit VSCodium. crow's own
# license belongs there instead. It is replaced on every run (not just on
# prepare) because the copy above is idempotent and a resumed build never
# re-runs prepare_vscode.sh.
cp -f "${HERE}/../../LICENSE.md" vscode/LICENSE.txt

# Upstream compiles the extensions' BROWSER bundles (gulp compile-web) only for
# the static vscode-web product; the reh/reh-web servers ship node entries
# only, so a serve-web workbench fails to activate e.g. vscode.ipynb
# ("Not Found") and notebooks cannot open at all. Compile them here, before the
# packaging tasks snapshot extensions/ into .build/extensions.
( cd vscode && npm run gulp compile-web )

# shellcheck disable=SC1091
. ./build.sh

# crow's bundled extensions, dropped into every packaged tree as BUILT-INS:
# built-ins are scanned from the extensions dir at startup, so there is no
# marketplace install and `install crow` picks them up together with the tree.
# Both steps run before --deb so the .deb carries them too.
#
# The Jupyter + Python stack (./bundled-exts.json, fetched from Open VSX) is
# what gives a notebook its kernel picker and the status bar its interpreter
# picker; without it crow opens .ipynb with the bare built-in ipynb editor and
# no way to run a cell.
"${HERE}/bundle-exts.sh" "${PLAT}" "${ARCH}"

# crow's own ACP chat extension, built from packages/vscode-acp with bun.
ACP_SRC="${HERE}/../vscode-acp"
if [[ -d "${ACP_SRC}" ]]; then
  command -v bun >/dev/null 2>&1 || {
    echo "crow-gui: packages/vscode-acp needs bun on PATH to build" >&2; exit 1; }
  ( cd "${HERE}/../.." && bun install >/dev/null )
  ( cd "${ACP_SRC}" && bun install >/dev/null && bun run build )
  for extdir in "${DESKTOP_APP}/extensions" \
                "vscode-reh-web-${PLAT}-${ARCH}/extensions" \
                "vscode-reh-${PLAT}-${ARCH}/extensions"; do
    [[ -d "${extdir}" ]] || continue
    rm -rf "${extdir}/crow-acp"
    mkdir -p "${extdir}/crow-acp"
    cp -r "${ACP_SRC}/dist" "${ACP_SRC}/media" "${ACP_SRC}/package.json" \
          "${ACP_SRC}/LICENSE.md" "${extdir}/crow-acp/"
    echo "crow-gui: built-in extension crow-acp → vscodium/${extdir}/crow-acp"
  done
fi

if [[ "${DEB}" == "yes" ]]; then
  # prepare-deb lays out .build/linux/deb/<debarch>/crow-<debarch>/ and computes
  # Depends with the host dpkg-shlibdeps (patches/user/03-deb-host-shlibdeps.patch);
  # build-deb chmods chrome-sandbox 4755 (patches/user/04) and runs fakeroot
  # dpkg-deb, so the archive carries the root:root ownership Chromium demands.
  command -v fakeroot >/dev/null 2>&1 && command -v dpkg-deb >/dev/null 2>&1 ||
    { echo "crow-gui: --deb needs fakeroot and dpkg-dev" >&2; exit 1; }
  mkdir -p assets
  (
    cd vscode
    npm run gulp "vscode-linux-${VSCODE_ARCH}-prepare-deb"
    npm run gulp "vscode-linux-${VSCODE_ARCH}-build-deb"
  )
  mv vscode/.build/linux/deb/*/deb/*.deb assets/
fi

if [[ "${RPM}" == "yes" ]]; then
  # Same shape as --deb: prepare-rpm stages into .build/linux/rpm/<rpmarch>/,
  # build-rpm runs rpmbuild over it. rpm must be able to build without a
  # _topdir of its own, so the gulp task sets that up inside vscode/.
  command -v rpmbuild >/dev/null 2>&1 ||
    { echo "crow-gui: --rpm needs rpm and rpmbuild" >&2; exit 1; }
  mkdir -p assets
  (
    cd vscode
    npm run gulp "vscode-linux-${VSCODE_ARCH}-prepare-rpm"
    npm run gulp "vscode-linux-${VSCODE_ARCH}-build-rpm"
  )
  mv vscode/.build/linux/rpm/*/*.rpm assets/
fi

if [[ "${ASSETS}" == "yes" ]]; then
  # CI_BUILD=yes keeps stores/snapcraft out of it; the .deb/.rpm were built
  # above (--deb/--rpm) and are only moved here, not rebuilt. The tarballs are
  # what `crow-cli install crow` downloads, plus the reh/reh-web servers and the
  # Rust CLI archive. Each platform packages what its own tooling can:
  #   linux            tar.gz, reh + reh-web .tar.gz, cli .tar.gz
  #   darwin           .zip, .dmg, reh + reh-web .tar.gz, cli .tar.gz
  #   win32            .zip, Inno system/user setup .exe, reh/reh-web (x64),
  #                    cli .tar.gz — and the MSI only with --msi, because
  #                    build/windows/msi/* is still VSCodium-branded.
  (
    export CI_BUILD=yes
    export SHOULD_BUILD_DEB=no SHOULD_BUILD_RPM=no SHOULD_BUILD_TAR=yes
    if [[ "${BUILD_OS}" == "windows" ]]; then
      if [[ "${MSI}" == "yes" ]]; then
        export SHOULD_BUILD_MSI="${SHOULD_BUILD_MSI:-yes}"
        export SHOULD_BUILD_MSI_NOUP="${SHOULD_BUILD_MSI_NOUP:-yes}"
      else
        export SHOULD_BUILD_MSI=no SHOULD_BUILD_MSI_NOUP=no
      fi
    fi
    # shellcheck disable=SC1091
    . ./prepare_assets.sh
  )

  rechecksum="no"

  # The vendored packager keeps VSCodium's asset naming, where the product name
  # is a proper noun: ${APP_NAME}-linux-…tar.gz, ${APP_NAME}Setup-x64-….exe,
  # ${APP_NAME}.darwin-x64-….dmg. crow's release assets are all lower-case with
  # the display name never in them, so a single slug per platform is matchable
  # by `crow-cli install crow` and by the download table on crow-ai.dev.
  APP_LC="$( echo "${APP_NAME}" | awk '{print tolower($0)}' )"
  for f in assets/*; do
    [[ -f "${f}" ]] || continue
    base="$( basename "${f}" )"
    case "${base}" in
      *.sha256|*.sha1)           continue ;;
      "${APP_NAME}UserSetup-"*)  new="${APP_LC}-user-setup-${base#"${APP_NAME}"UserSetup-}" ;;
      "${APP_NAME}Setup-"*)      new="${APP_LC}-setup-${base#"${APP_NAME}"Setup-}" ;;
      "${APP_NAME}."*)           new="${APP_LC}-${base#"${APP_NAME}."}" ;;
      "${APP_NAME}-"*)           new="${APP_LC}-${base#"${APP_NAME}-"}" ;;
      *)                         continue ;;
    esac
    mv "${f}" "assets/${new}"
    echo "crow-gui: asset ${base} → ${new}"
    rechecksum="yes"
  done

  # The vendored osx packager only makes a .dmg when it can sign and notarize
  # (create-dmg runs inside the CERTIFICATE_OSX_P12_DATA branch), so an
  # unconfigured build would ship a .zip and no disk image. Make the unsigned
  # .dmg here instead.
  if [[ "${BUILD_OS}" == "osx" && -z "${CERTIFICATE_OSX_P12_DATA:-}" ]]; then
    APP_BUNDLE="$( ls -d "VSCode-darwin-${VSCODE_ARCH}"/*.app | head -1 )"
    echo "crow-gui: no signing certificate — building an unsigned .dmg from ${APP_BUNDLE}"
    npx --yes create-dmg --overwrite "${APP_BUNDLE}" assets/ >/dev/null
    mv assets/*.dmg "assets/${APP_LC}-darwin-${VSCODE_ARCH}-${RELEASE_VERSION}.dmg"
    rechecksum="yes"
  fi

  # Renames move files out from under the checksums prepare_assets.sh wrote, so
  # they are recomputed (never left stale) once everything is named. Windows
  # ships no checksums — its installers are signed, not summed.
  if [[ "${rechecksum}" == "yes" && "${BUILD_OS}" != "windows" ]]; then
    rm -f assets/*.sha256 assets/*.sha1
    # shellcheck disable=SC1091
    . ./prepare_checksums.sh
  fi
fi

echo
echo "crow-gui: build complete (${PLAT} ${VSCODE_ARCH})"
if [[ "${BUILD_OS}" == "osx" ]]; then
  echo "  desktop app : vscodium/${DESKTOP}/${APP_NAME}.app"
else
  echo "  desktop app : vscodium/${DESKTOP}/${BINARY_NAME}"
fi
if [[ "${SHOULD_BUILD_REH_WEB}" != "no" ]]; then
  echo "  web server  : vscodium/vscode-reh-web-${PLAT}-${VSCODE_ARCH}/bin/${BINARY_NAME}-server"
fi
if [[ "${SHOULD_BUILD_REH}" != "no" ]]; then
  echo "  remote srv  : vscodium/vscode-reh-${PLAT}-${VSCODE_ARCH}/bin/${BINARY_NAME}-server"
fi
if [[ "${ASSETS}" == "yes" ]]; then
  echo "  assets      : vscodium/assets/"
  for f in assets/*; do
    [[ -f "${f}" ]] && echo "                $(basename "${f}")"
  done
fi
exit 0
