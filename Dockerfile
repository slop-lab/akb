FROM node:26.12.1-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe AS build

WORKDIR /app
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY script/setup-blocks.mjs script/setup-blocks.mjs
RUN npm run setup:blocks
COPY . .
RUN npm run build:r4 \
    && npm prune --omit=dev \
    && rm -rf .deps

FROM postgres:17.6-bookworm@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3 AS postgres-client

FROM node:26.12.1-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe AS runtime

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
