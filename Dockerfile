# ADR-007: portable OCI image, Node/Fastify, stateless, config via env vars,
# storage (PostgreSQL/R2) outside the container. API and worker ship from
# this SAME image with different commands (see docker-compose.staging.yml).

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY scripts/migrate.cjs scripts/provision-staging-runtime-login.cjs ./scripts/

RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 3000

# No curl in node:alpine by default -- Node itself makes the health probe,
# matching ADR-007's "health checks" quality gate item.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health/live').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/api/server.js"]
