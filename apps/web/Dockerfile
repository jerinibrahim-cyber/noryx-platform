FROM node:20-alpine AS base
RUN corepack enable

FROM base AS deps
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/ui-kit/package.json packages/ui-kit/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @noryx/web...

FROM deps AS build
WORKDIR /repo
COPY packages/shared-types packages/shared-types
COPY packages/ui-kit packages/ui-kit
COPY apps/web apps/web
RUN pnpm --filter @noryx/ui-kit --filter @noryx/web run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost/ >/dev/null || exit 1
