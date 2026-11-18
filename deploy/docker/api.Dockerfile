# Cloudlane API Dockerfile
# Multi-stage build: build TypeScript, then run in slim Node image.

FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++ openssl
WORKDIR /build

# Copy workspace root files for pnpm
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY packages/contracts/src ./packages/contracts/src/
COPY apps/api/package.json apps/api/tsconfig.json apps/api/nest-cli.json ./apps/api/

# Install deps
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY packages/contracts/src ./packages/contracts/src/
COPY apps/api/src ./apps/api/src/
COPY apps/api/test ./apps/api/test/

RUN pnpm --filter @cloudlane/contracts build
RUN pnpm --filter @cloudlane/api prisma:generate
RUN pnpm --filter @cloudlane/api build

# Runtime stage
FROM node:22-alpine AS runtime
RUN apk add --no-cache openssl tini
WORKDIR /app

COPY --from=builder /build/package.json /build/pnpm-workspace.yaml /build/pnpm-lock.yaml ./
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=builder /build/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder /build/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /build/apps/api/dist ./apps/api/dist
COPY --from=builder /build/apps/api/src/prisma ./apps/api/src/prisma

ENV NODE_ENV=production
ENV DATABASE_URL=postgresql://cloudlane:CHANGE_ME@postgres:5432/cloudlane?schema=public
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/api/dist/main.js"]
