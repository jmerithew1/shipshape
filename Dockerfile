# Multi-stage production image (Week-4 implementation rule 5).
#
# The previous Dockerfile COPY'd pre-built shared/dist and api/dist from the
# developer's machine — a clean checkout could not build the image, and the
# artifact that ran in production was whatever happened to be on the laptop
# that built it. Now the image builds its own dist in a builder stage, so
# `docker build` from a clean checkout is the whole story, and the GIT_SHA
# build-arg stamps provenance into the image.
#
#   docker build --build-arg GIT_SHA=$(git rev-parse --short HEAD) -t ship-api:$(git rev-parse --short HEAD) .
#
# Use ECR Public Node.js image (Docker Hub is blocked in government environments)
FROM public.ecr.aws/docker/library/node:20-slim AS builder

WORKDIR /app

# Disable SSL strict mode for government VPN environments (MUST be before any npm commands)
RUN npm config set strict-ssl false
RUN npm install -g pnpm@10.27.0 && pnpm config set strict-ssl false

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY api/package.json ./api/
COPY shared/package.json ./shared/

# Full install (dev deps included — tsc runs here), then build shared + api
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @ship/shared --filter @ship/api --filter .
COPY shared/ ./shared/
COPY api/ ./api/
RUN pnpm --filter @ship/shared run build && pnpm --filter @ship/api run build

# ---- runtime stage: production dependencies + built output only ----
FROM public.ecr.aws/docker/library/node:20-slim

ARG GIT_SHA=unknown
LABEL org.opencontainers.image.revision=$GIT_SHA
ENV GIT_SHA=$GIT_SHA

WORKDIR /app

RUN npm config set strict-ssl false
RUN npm install -g pnpm@10.27.0 && pnpm config set strict-ssl false

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY api/package.json ./api/
COPY shared/package.json ./shared/

RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @ship/shared --filter @ship/api --filter . && pnpm store prune

COPY --from=builder /app/shared/dist/ ./shared/dist/
COPY --from=builder /app/api/dist/ ./api/dist/

EXPOSE 80

ENV NODE_ENV=production
ENV VITE_APP_ENV=production
ENV PORT=80

# Start the application (run migrations first to ensure schema exists)
WORKDIR /app/api
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
