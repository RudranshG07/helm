FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @mandate/web build

FROM base AS runtime
ENV NODE_ENV=production
RUN addgroup -S helm && adduser -S helm -G helm
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
COPY package.json pnpm-workspace.yaml ./
COPY --from=build /app/apps/web/dist ./apps/web/dist
USER helm
EXPOSE 3000
CMD ["node", "apps/api/src/server.ts"]
