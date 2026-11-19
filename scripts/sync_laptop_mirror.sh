#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${1:-dinoclaro}"
LOCAL_PROJECTS="${HOME}/research"
LOCAL_STORAGE="/home/dino/dupe/storage"

echo "1. Syncing project folders from ${REMOTE_HOST} into ${LOCAL_PROJECTS}..."
mkdir -p "${LOCAL_PROJECTS}" "${LOCAL_STORAGE}/pdfs"
rsync -az -e "ssh -o ServerAliveInterval=10" "${REMOTE_HOST}:/home/dinoclaro/dupe/storage/projects/user_1/" "${LOCAL_PROJECTS}/"

for proj in "${LOCAL_PROJECTS}"/*/; do
  if [[ -d "${proj}" ]]; then
    mkdir -p "${proj}code" "${proj}paper" "${proj}notes" "${proj}diagrams" "${proj}refs/text"
  fi
done

echo "2. Syncing PDF library files to ${LOCAL_STORAGE}/pdfs..."
rsync -az -e "ssh -o ServerAliveInterval=10" "${REMOTE_HOST}:/home/dinoclaro/dupe/storage/pdfs/" "${LOCAL_STORAGE}/pdfs/"

echo "Synced projects in ${LOCAL_PROJECTS}:"
ls -1 "${LOCAL_PROJECTS}"
