# ── Stage 1: Build ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --legacy-peer-deps

COPY . .
RUN npm run build
RUN npx drizzle-kit generate

# ── Stage 2: Runtime ───────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

# Native build deps for better-sqlite3
RUN apk add --no-cache python3 make g++

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/src/server/db/migrations ./src/server/db/migrations
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts

# Writable data directory (mapped to PVC in k3s)
RUN mkdir -p /data/captures
VOLUME ["/data"]

EXPOSE 4000
ENV PORT=4000
ENV DB_PATH=/data/chickenflow.db
ENV CAPTURES_DIR=/data/captures

# Run migrations then start
CMD ["sh", "-c", "npx drizzle-kit migrate && node dist/app/server/server.mjs"]
