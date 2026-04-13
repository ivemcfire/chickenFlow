# ── Stage 1: Build ─────────────────────────────────────────────────────────────
# No native modules — pure-JS postgres driver, no better-sqlite3.
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

COPY package*.json ./
RUN npm ci --legacy-peer-deps --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/server/db/migrations ./src/server/db/migrations
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts

RUN mkdir -p /data/captures
VOLUME ["/data"]

EXPOSE 4000
ENV PORT=4000
ENV CAPTURES_DIR=/data/captures

CMD ["node", "dist/app/server/server.mjs"]
