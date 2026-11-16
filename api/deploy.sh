#!/usr/bin/env bash
# Stage the bundled API in R2 through the yt-factory-stage worker (nonce in ~/.config/ytf/stage.nonce).
# Then deploy it from R2 with the Cloudflare API (see README "Deploy the API").
set -euo pipefail
cd "$(dirname "$0")"
npx -y esbuild@0.25 src/index.js --bundle --format=esm --platform=neutral --outfile=/tmp/yt-factory-api.js
curl -fsS -X PUT https://yt-factory-stage.thl007.workers.dev/stage/yt-factory-api.js \
  -H "x-nonce: $(cat ~/.config/ytf/stage.nonce)" --data-binary @/tmp/yt-factory-api.js
echo
