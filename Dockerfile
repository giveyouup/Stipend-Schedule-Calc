# ── Stage 1: Build React frontend ────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /build/client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# ── Stage 2: Production server ────────────────────────────────────────────────
FROM node:20-alpine

# better-sqlite3 needs Python + build tools for native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install server dependencies
COPY server/package*.json ./
RUN npm install --omit=dev

COPY server/ ./

# Copy React build output from Stage 1
COPY --from=builder /build/client/dist ./client/dist

# Data directory (mount a volume here for persistence)
RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_DIR=/data

EXPOSE 3000

CMD ["node", "index.js"]
