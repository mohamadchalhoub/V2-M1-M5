# Multi-stage build using Next.js's `output: "standalone"` (next.config.ts) —
# a self-contained server.js with only the traced dependencies, so the
# runtime image needs no full node_modules copy or npm install at all.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# BACKEND_API_URL is read at REQUEST time (lib/api.ts), not build time — no
# build-time env vars are needed here, unlike a typical NEXT_PUBLIC_ setup.
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Drop root for the network-facing process — node:20-alpine already ships a
# non-root `node` user (uid 1000).
USER node

EXPOSE 3001
ENV PORT=3001
# Without this, the standalone server.js reads process.env.HOSTNAME, which
# Linux/Docker auto-populates to the container's own hex id — so it binds to
# that one specific container IP instead of every interface. Other
# containers can still reach it via the `web` service name (Docker DNS
# resolves to that same IP), but `localhost` inside the container itself
# cannot, which is exactly what docker-compose.prod.yml's own healthcheck
# calls — so the container reports permanently unhealthy despite serving
# real traffic. Confirmed via `docker exec ... cat /proc/net/tcp` showing a
# bind to 172.x.x.x instead of 0.0.0.0 during production-readiness review.
ENV HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
