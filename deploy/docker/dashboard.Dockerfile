# Cloudlane Dashboard Dockerfile
# Builds SvelteKit static assets. The installer extracts them from this image.

FROM node:22-alpine AS builder
WORKDIR /build

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY packages/design-tokens/package.json ./packages/design-tokens/
COPY apps/dashboard/package.json apps/dashboard/tsconfig.json apps/dashboard/svelte.config.js apps/dashboard/vite.config.ts ./apps/dashboard/

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
RUN pnpm install --frozen-lockfile

COPY packages/contracts/src ./packages/contracts/src/
COPY packages/design-tokens/src ./packages/design-tokens/src/
COPY apps/dashboard/src ./apps/dashboard/src/
COPY apps/dashboard/static ./apps/dashboard/static/
COPY apps/dashboard/app.html ./apps/dashboard/

RUN pnpm --filter @cloudlane/contracts build
RUN cd apps/dashboard && npx svelte-kit sync
RUN pnpm --filter @cloudlane/dashboard build

# Package static assets into a tarball
FROM alpine:3.20 AS packager
RUN mkdir -p /dashboard
COPY --from=builder /build/apps/dashboard/build /dashboard
RUN cd / && tar czf /dashboard.tar.gz dashboard/

# Output stage — the installer does `docker create` + `docker cp` to extract
FROM scratch AS export
COPY --from=packager /dashboard.tar.gz /dashboard.tar.gz
