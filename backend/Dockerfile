# Multi-stage build (Phase 11 — DEPLOYMENT.md). The `build` stage keeps the
# full node_modules (including the Prisma CLI, a devDependency) so the
# `migrate` compose service can run `prisma migrate deploy` from that same
# image without a second install; `runtime` is the slim image actually
# exposed to the network.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS build
# Needed here too, not just in `runtime` — `prisma generate` itself probes
# the local libssl version to pick the right engine binary target; without
# it, Prisma falls back to a guess ("Defaulting to openssl-1.1.x") that can
# mismatch the actual Alpine OpenSSL 3.x this base image ships.
RUN apk add --no-cache openssl
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:20-alpine AS runtime
# Prisma's query engine needs openssl on Alpine — see Prisma's own Docker guidance.
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# The build stage's `npx prisma generate` produced the actual query-engine
# binary; the fresh `npm ci --omit=dev` above only installed the @prisma/client
# package skeleton, so the generated artifacts are copied over it rather than
# regenerated (regenerating here would need the Prisma CLI, a devDependency
# this stage deliberately doesn't install).
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma

# Create the strategy's runtime-state directory IN THE IMAGE, owned by `node`,
# before dropping root.
#
# This is not cosmetic. A named volume mounted at a path that does not exist in
# the image is created by Docker owned by ROOT, and the process below runs as
# `node` — so every state write fails with EACCES and the observation loop
# spins forever:
#
#   Cycle error (116 consecutive): EACCES: permission denied,
#   open '/app/xauusd-m1m5-runtime/watch-state.json.tmp'
#
# When the path DOES exist in the image, Docker seeds a fresh empty volume from
# it and carries its ownership across, so the volume comes up writable.
RUN mkdir -p /app/xauusd-m1m5-runtime && chown node:node /app/xauusd-m1m5-runtime

# Drop root for the network-facing process — node:20-alpine already ships a
# non-root `node` user (uid 1000); only `runtime` (the `api` service) needs
# this, not the `build`-stage `migrate` one-shot container, which never
# accepts network traffic.
USER node

EXPOSE 3000
CMD ["node", "dist/src/main.js"]
