# VEA ASP — host-agnostic container (works on Railway / Render / Fly.io).
# Build:  docker build -t vea .
# Run:    docker run -p 8402:8402 -e VEA_ATTESTOR_KEY="$(cat attestor_key.json)" vea
#
# Required in production:
#   VEA_ATTESTOR_KEY  — JSON contents of attestor_key.json. Pins the attestor identity
#                       so receipts stay verifiable across redeploys (hosts have
#                       ephemeral disks). If unset, a fresh key is generated per boot.
# Optional:
#   PORT              — injected by most hosts; server reads it (default 8402).
#   ANTHROPIC_API_KEY — enables the 4th (LLM) verification layer; degrades safe if absent.
#   VEA_PROXY         — egress proxy, only if the host needs one.
FROM node:20-slim
WORKDIR /app

# Install deps first for layer caching. Only `undici` at runtime; tsx/typescript are dev
# deps used to run the TypeScript server directly (no separate build step to break).
COPY package*.json ./
RUN npm install --no-audit --no-fund

# App source (see .dockerignore — node_modules, the secret key file, videos, git are excluded).
COPY . .

ENV PORT=8402
EXPOSE 8402

# verify -> execute -> attest, non-custodial.
CMD ["npm", "run", "serve"]
