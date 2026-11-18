# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS base

WORKDIR /app

ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# Prisma engine generation during npm postinstall needs OpenSSL available.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl fonts-liberation \
  && rm -rf /var/lib/apt/lists/*


FROM base AS deps

# Install the bot workspaces without the web app dependencies.
COPY package.json package-lock.json .npmrc ./
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/application/package.json ./packages/application/package.json
COPY scripts/prisma-generate-if-needed.js ./scripts/prisma-generate-if-needed.js

RUN --mount=type=secret,id=proxy_ca \
    [ ! -f /run/secrets/proxy_ca ] || export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; \
    PRISMA_SKIP_POSTINSTALL_GENERATE=1 npm ci --workspace packages/application --workspace packages/contracts --include-workspace-root


FROM deps AS build

# Web source, documentation and CI edits must not invalidate the bot build.
COPY package.json package-lock.json .npmrc tsconfig.json prisma.config.js ./
COPY src ./src
COPY prisma ./prisma
COPY packages ./packages
COPY scripts ./scripts

# Keep generation, compilation, production pruning and import verification in one
# snapshot so vfs builders do not retain a full dependency tree for every step.
RUN --mount=type=secret,id=proxy_ca \
    [ ! -f /run/secrets/proxy_ca ] || export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; \
    npm run prisma:generate \
    && npm run build \
    && npm prune --omit=dev --workspace packages/application --workspace packages/contracts --include-workspace-root \
    && node scripts/check-application-imports.mjs


FROM base AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --chown=node:node --from=build /app/package.json ./package.json
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/packages/application/package.json ./packages/application/package.json
COPY --chown=node:node --from=build /app/packages/application/dist ./packages/application/dist
COPY --chown=node:node --from=build /app/prisma ./prisma
COPY --chown=node:node --from=build /app/prisma.config.js ./prisma.config.js
COPY --chown=node:node --from=build /app/scripts ./scripts

USER node

CMD ["node", "dist/src/index.js"]
