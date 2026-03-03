FROM node:22 AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
COPY scripts/ scripts/
COPY tsconfig.json ./
COPY src/ src/

RUN npm ci

FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/dist dist/

RUN npm prune --omit=dev

COPY hooks/ hooks/
COPY skills/ skills/
COPY vendor/ vendor/

ENV NODE_OPTIONS="--max-old-space-size=8192"

EXPOSE 4747

ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["serve", "--port", "4747", "--host", "0.0.0.0"]
