# Multi-stage build kept minimal and non-root — scanned in CI by Trivy
# (Readiness Review §7.2) before ever reaching a registry.
FROM node:26-alpine AS base
RUN corepack enable

FROM base AS deps
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/db-core/package.json packages/db-core/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/event-bus-client/package.json packages/event-bus-client/
COPY services/identity/package.json services/identity/
RUN pnpm install --frozen-lockfile --filter @noryx/identity...

FROM deps AS build
WORKDIR /repo
COPY packages/db-core packages/db-core
COPY packages/shared-types packages/shared-types
COPY packages/event-bus-client packages/event-bus-client
COPY services/identity services/identity
RUN pnpm --filter @noryx/shared-types... --filter @noryx/db-core --filter @noryx/identity run build

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S noryx && adduser -S noryx -G noryx
COPY --from=build /repo/services/identity/dist ./dist
COPY --from=build /repo/services/identity/package.json ./
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
USER noryx
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "require('http').get('http://localhost:3001/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "dist/main.js"]
