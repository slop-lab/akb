FROM node:24.22.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:r4 && npm prune --omit=dev

FROM postgres:17-bookworm AS postgres-client

FROM node:24.22.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PATH=/usr/lib/postgresql/17/bin:$PATH
WORKDIR /app
RUN apt-get update \
    && apt-get install --yes --no-install-recommends libpq5 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=postgres-client /usr/lib/postgresql/17/bin/pg_dump /usr/lib/postgresql/17/bin/pg_dump
COPY --from=postgres-client /usr/lib/postgresql/17/bin/pg_restore /usr/lib/postgresql/17/bin/pg_restore
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["npm", "run", "start:r4"]
