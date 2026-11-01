#!/usr/bin/env bash
# crow-manifest.json — a release's index of its own assets.
#
# WHY THIS EXISTS. The IDE's asset filenames carry the VS Code product version,
# and that version ends in a patch computed at build time:
#
#   get_repo.sh:  TIME_PATCH=$( printf "%04d" $(($(date +%-j) * 24 + $(date +%-H))) )
#                 RELEASE_VERSION="${MS_TAG}${TIME_PATCH}"
#
# so tag v0.1.1 publishes crow_1.135.07321_amd64.deb. Nothing about the git tag
# appears in the name, and the patch is day-of-year*24+hour — a downloader that
# knows the tag cannot construct the filename. Its options are the GitHub API
# (60 unauthenticated calls/hour/IP, and CI runners share an IP) or a manifest.
# This is the manifest, and it is reachable with no API call at all:
#
#   https://github.com/<owner>/<repo>/releases/latest/download/crow-manifest.json
#   https://github.com/<owner>/<repo>/releases/download/<tag>/crow-manifest.json
#
# It maps a stable key to the real filename plus its sha256 and size, so the
# download can be verified before it is unpacked — including the Windows
# installers, which the vendored pipeline ships no checksums for.
#
# TWO SUBCOMMANDS, because the knowledge is split across two CI jobs:
#
#   fragment  run per platform at the end of `build.sh --assets`. The build is
#             the only place that knows which of its own files is the .deb and
#             which is the reh-web tarball. Writes crow-ide-<platform>-<arch>.json
#             into assets/, which rides to the release job inside the crow-ide-*
#             artifact. Classification is best-effort here ON PURPOSE: this runs
#             after an hours-long build, so an unrecognised file warns and is
#             left out rather than throwing the artifacts away.
#
#   merge     run once by build-ide.yml's `release` job over the merged dist/.
#             Concatenates the fragments, hashes every file they name, and
#             writes crow-manifest.json. This is the strict half — it fails on a
#             version skew between platforms, on a fragment naming a file that
#             is not there, and on any asset no fragment claimed. It costs
#             seconds and the artifacts are already uploaded, so failing here is
#             cheap and re-running just this job is enough.
#
# The Rust agent is deliberately absent: build-tui.yml publishes it as
# crow-agent-<target>.tar.gz, already version-free and constructible from the
# target triple, and its release job runs concurrently with this one so it could
# not be indexed from here reliably.
#
#   ./manifest.sh fragment --assets-dir vscodium/assets --platform linux \
#                          --arch x64 --release-version 1.135.07321 \
#                          --vscode-tag 1.135.0
#   ./manifest.sh merge --dist-dir dist --tag v0.1.1 --repository crow-cli/crow \
#                       --out dist/crow-manifest.json
set -euo pipefail

die() { echo "manifest.sh: $*" >&2; exit 1; }

# The asset names are crow's own — build.sh lower-cases VSCodium's and drops the
# display name, so one case statement covers all five platforms. Order matters:
# the reh/reh-web/cli tarballs are *.tar.gz too, and the updates-disabled .msi is
# an .msi. The keys are the contract `crow-cli install crow` codes against.
kind_of() {
  case "$1" in
    crow-reh-web-*.tar.gz)         printf 'reh-web-tar.gz' ;;
    crow-reh-*.tar.gz)             printf 'reh-tar.gz' ;;
    crow-cli-*.tar.gz)             printf 'cli-tar.gz' ;;
    crow-*-updates-disabled-*.msi) printf 'msi-updates-disabled' ;;
    crow-user-setup-*.exe)         printf 'user-setup-exe' ;;
    crow-setup-*.exe)              printf 'setup-exe' ;;
    crow-linux-*.tar.gz)           printf 'tar.gz' ;;
    crow-darwin-*.zip)             printf 'zip' ;;
    crow-win32-*.zip)              printf 'zip' ;;
    *.deb)                         printf 'deb' ;;
    *.rpm)                         printf 'rpm' ;;
    *.dmg)                         printf 'dmg' ;;
    *.msi)                         printf 'msi' ;;
    *)                             printf '' ;;
  esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{ print $1 }'
  else shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

size_of() { stat -c%s "$1" 2>/dev/null || stat -f%z "$1"; }

cmd="${1:-}"
[[ -n "${cmd}" ]] || die "need a subcommand: fragment | merge"
shift

case "${cmd}" in
  fragment)
    assets_dir="" platform="" arch="" release_version="" vscode_tag=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --assets-dir)      assets_dir="$2";      shift 2 ;;
        --platform)        platform="$2";        shift 2 ;;
        --arch)            arch="$2";            shift 2 ;;
        --release-version) release_version="$2"; shift 2 ;;
        --vscode-tag)      vscode_tag="$2";      shift 2 ;;
        *) die "fragment: unknown argument: $1" ;;
      esac
    done
    for v in assets_dir platform arch release_version; do
      [[ -n "${!v}" ]] || die "fragment: --${v//_/-} is required"
    done
    [[ -d "${assets_dir}" ]] || die "fragment: no such directory: ${assets_dir}"

    files='{}'
    for f in "${assets_dir}"/*; do
      [[ -f "${f}" ]] || continue
      base="$( basename "${f}" )"
      # The checksums are sidecars of the files being indexed, and the fragment
      # from a previous run is not an asset.
      case "${base}" in *.sha256|*.sha1|*.json) continue ;; esac
      kind="$( kind_of "${base}" )"
      if [[ -z "${kind}" ]]; then
        echo "manifest.sh: WARNING not classified, left out of the manifest: ${base}" >&2
        continue
      fi
      if jq -e --arg k "${kind}" 'has($k)' <<<"${files}" >/dev/null; then
        die "fragment: two assets classify as '${kind}': $( jq -r --arg k "${kind}" '.[$k]' <<<"${files}" ) and ${base}"
      fi
      files="$( jq --arg k "${kind}" --arg v "${base}" '.[$k] = $v' <<<"${files}" )"
    done
    [[ "${files}" != "{}" ]] || die "fragment: ${assets_dir} holds nothing classifiable"

    out="${assets_dir}/crow-ide-${platform}-${arch}.json"
    jq -n --arg p "${platform}" --arg a "${arch}" \
          --arg rv "${release_version}" --arg vt "${vscode_tag}" \
          --argjson files "${files}" \
       '{platform:$p, arch:$a, release_version:$rv, vscode_tag:$vt, files:$files}' > "${out}"
    echo "manifest.sh: fragment ${out} ($( jq 'length' <<<"${files}" ) assets)"
    ;;

  merge)
    dist_dir="" tag="" repository="" out=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --dist-dir)   dist_dir="$2";   shift 2 ;;
        --tag)        tag="$2";        shift 2 ;;
        --repository) repository="$2"; shift 2 ;;
        --out)        out="$2";        shift 2 ;;
        *) die "merge: unknown argument: $1" ;;
      esac
    done
    for v in dist_dir tag repository out; do
      [[ -n "${!v}" ]] || die "merge: --${v//_/-} is required"
    done
    [[ -d "${dist_dir}" ]] || die "merge: no such directory: ${dist_dir}"

    shopt -s nullglob
    frags=( "${dist_dir}"/crow-ide-*.json )
    shopt -u nullglob
    [[ ${#frags[@]} -gt 0 ]] || die "merge: no crow-ide-*.json fragments in ${dist_dir}"

    platforms='{}' indexed='{}' release_version="" vscode_tag=""
    for frag in "${frags[@]}"; do
      platform="$( jq -r '.platform' "${frag}" )"
      arch="$( jq -r '.arch' "${frag}" )"
      frv="$( jq -r '.release_version' "${frag}" )"
      fvt="$( jq -r '.vscode_tag // ""' "${frag}" )"

      # The whole point of pinning RELEASE_VERSION in the workflow's plan job is
      # that one release stamps one product version. If two platforms disagree,
      # the release is carrying two genuinely different builds of the same tag
      # and must not publish.
      if [[ -z "${release_version}" ]]; then
        release_version="${frv}"; vscode_tag="${fvt}"
      elif [[ "${release_version}" != "${frv}" ]]; then
        die "merge: RELEASE_VERSION skew — ${release_version} vs ${frv} in $( basename "${frag}" )"
      fi

      assets='{}'
      while IFS=$'\t' read -r kind file; do
        [[ -n "${kind}" && -n "${file}" ]] || continue
        path="${dist_dir}/${file}"
        [[ -f "${path}" ]] || die "merge: $( basename "${frag}" ) names ${file}, which is not in ${dist_dir}"
        assets="$( jq --arg k "${kind}" --arg f "${file}" \
                      --arg s "$( sha256_of "${path}" )" --argjson n "$( size_of "${path}" )" \
                   '.[$k] = {file:$f, sha256:$s, size:$n}' <<<"${assets}" )"
        indexed="$( jq --arg f "${file}" '.[$f] = true' <<<"${indexed}" )"
      done < <( jq -r '.files | to_entries[] | "\(.key)\t\(.value)"' "${frag}" )

      key="${platform}-${arch}"
      if jq -e --arg k "${key}" 'has($k)' <<<"${platforms}" >/dev/null; then
        die "merge: two fragments claim platform ${key}"
      fi
      platforms="$( jq --arg k "${key}" --arg p "${platform}" --arg a "${arch}" \
                       --argjson assets "${assets}" \
                   '.[$k] = {platform:$p, arch:$a, assets:$assets}' <<<"${platforms}" )"
      echo "merge: ${key} — $( jq 'length' <<<"${assets}" ) assets"
    done

    # Coverage: every published file must be in the manifest. A new asset type
    # that kind_of does not know about is a hole the installer would fall into
    # silently, so it stops the release instead.
    for f in "${dist_dir}"/*; do
      [[ -f "${f}" ]] || continue
      base="$( basename "${f}" )"
      case "${base}" in *.sha256|*.sha1|*.json) continue ;; esac
      jq -e --arg f "${base}" 'has($f)' <<<"${indexed}" >/dev/null \
        || die "merge: no fragment claimed ${base} — teach manifest.sh kind_of about it"
    done

    jq -n --arg repo "${repository}" --arg tag "${tag}" --arg rv "${release_version}" \
          --arg vt "${vscode_tag}" --argjson platforms "${platforms}" \
          --arg ts "$( date -u +%Y-%m-%dT%H:%M:%SZ )" \
       '{ schema: 1,
          repository: $repo,
          tag: $tag,
          base_url: ("https://github.com/" + $repo + "/releases/download/" + $tag),
          generated_at: $ts,
          release_version: $rv,
          vscode_tag: $vt,
          platforms: $platforms }' > "${out}"
    echo "merge: wrote ${out} ($( jq '.platforms | length' <<<"$( cat "${out}" )" ) platforms)"
    ;;

  *)
    die "unknown subcommand: ${cmd} (want fragment | merge)"
    ;;
esac
