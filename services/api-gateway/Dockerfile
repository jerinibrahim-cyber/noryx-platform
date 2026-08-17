FROM node:20-alpine AS base
RUN corepack enable

FROM base AS deps
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY services/api-gateway/package.json services/api-gateway/
RUN pnpm install --frozen-lockfile --filter @noryx/api-gateway...

FROM deps AS build
WORKDIR /repo
COPY packages/shared-types packages/shared-types
COPY services/api-gateway services/api-gateway
RUN pnpm --filter @noryx/shared-types... --filter @noryx/api-gateway run build

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S noryx && adduser -S noryx -G noryx
COPY --from=build /repo/services/api-gateway/dist ./dist
COPY --from=build /repo/services/api-gateway/package.json ./
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
# The manifest sync step (CI, or the docker-compose bind mount for local
# dev) populates this at deploy time — see modules/README.md.
RUN mkdir -p ./modules && chown noryx:noryx ./modules
USER noryx
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "dist/main.js"]
