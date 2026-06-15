# Build context: repo root.
FROM node:26-alpine AS build
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @tremurex/web --ignore-scripts

COPY apps/web apps/web
RUN pnpm --filter @tremurex/web build

FROM nginx:1.27-alpine
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
