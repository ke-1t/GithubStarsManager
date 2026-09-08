#!/usr/bin/env bash
set -euo pipefail

if (( $# != 0 )); then
  echo "build-images.sh does not accept provenance overrides; derive them from this checkout" >&2
  exit 2
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_root"

if [[ -n "$(git status --porcelain=v1)" ]]; then
  echo "refusing to build from a dirty checkout; commit or preserve the work separately" >&2
  exit 1
fi

source_remote="$(git remote get-url origin)"
case "$source_remote" in
  https://github.com/*)
    source_url="${source_remote%.git}"
    ;;
  git@github.com:*)
    source_url="https://github.com/${source_remote#git@github.com:}"
    source_url="${source_url%.git}"
    ;;
  ssh://git@github.com/*)
    source_url="https://github.com/${source_remote#ssh://git@github.com/}"
    source_url="${source_url%.git}"
    ;;
  *)
    echo "unsupported origin remote for OCI source label" >&2
    exit 1
    ;;
esac

source_revision="$(git rev-parse HEAD)"
short_revision="$(git rev-parse --short=12 HEAD)"
created_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
backend_image="githubstarsmanager-canonical-backend:${short_revision}"
frontend_image="githubstarsmanager-canonical-frontend:${short_revision}"

common_build_args=(
  --build-arg "OCI_SOURCE=${source_url}"
  --build-arg "OCI_REVISION=${source_revision}"
  --build-arg "OCI_CREATED=${created_at}"
)

docker build "${common_build_args[@]}" \
  --file "$repo_root/server/Dockerfile" \
  --tag "$backend_image" \
  "$repo_root/server"

docker build "${common_build_args[@]}" \
  --file "$repo_root/Dockerfile" \
  --tag "$frontend_image" \
  "$repo_root"

assert_label() {
  local image="$1"
  local label="$2"
  local expected="$3"
  local actual
  actual="$(docker image inspect --format "{{index .Config.Labels \"${label}\"}}" "$image")"
  if [[ "$actual" != "$expected" ]]; then
    echo "OCI label mismatch for ${image}: ${label}" >&2
    exit 1
  fi
}

for image in "$backend_image" "$frontend_image"; do
  assert_label "$image" "org.opencontainers.image.source" "$source_url"
  assert_label "$image" "org.opencontainers.image.revision" "$source_revision"
  assert_label "$image" "org.opencontainers.image.created" "$created_at"
done

echo "Built and verified backend=${backend_image} frontend=${frontend_image}"
echo "OCI source=${source_url} revision=${source_revision} created=${created_at}"
