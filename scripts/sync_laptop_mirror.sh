#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${1:-dinoclaro}"
LOCAL_STORAGE="/home/dino/dupe/storage"

echo "1. Syncing PDFs and project Git repositories from ${REMOTE_HOST} to laptop (${LOCAL_STORAGE})..."
mkdir -p "${LOCAL_STORAGE}/pdfs" "${LOCAL_STORAGE}/projects"
rsync -az "${REMOTE_HOST}:/home/dinoclaro/dupe/storage/pdfs/" "${LOCAL_STORAGE}/pdfs/"
rsync -az "${REMOTE_HOST}:/home/dinoclaro/dupe/storage/projects/" "${LOCAL_STORAGE}/projects/"

echo "2. Syncing paper library metadata from ${REMOTE_HOST} into local laptop database..."
ssh "${REMOTE_HOST}" "/home/dinoclaro/miniforge3/envs/dupe/bin/pg_dump -h 127.0.0.1 -p 5432 -U dupe --data-only --column-inserts -t papers -t tags -t paper_tags -t highlights dupe" \
  | docker exec -i dupe_postgres psql -U dupe -d dupe >/dev/null 2>&1 || true

echo "Laptop mirror synced! If ${REMOTE_HOST} goes down:"
echo "  - Open http://127.0.0.1:8080 on this laptop, OR"
echo "  - Commit/push directly to Overleaf from: ${LOCAL_STORAGE}/projects/user_1/ra-l_pele_offline_mbrl/paper/"
