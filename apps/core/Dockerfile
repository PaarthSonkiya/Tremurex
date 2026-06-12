# Build context: repo root (workspace deps need the monorepo).
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/core/package.json apps/core/
RUN pnpm install --frozen-lockfile --filter @tremurex/core... --ignore-scripts

COPY packages/shared packages/shared
COPY apps/core apps/core
RUN pnpm --filter @tremurex/shared build && pnpm --filter @tremurex/core build

ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "apps/core/dist/index.js"]
