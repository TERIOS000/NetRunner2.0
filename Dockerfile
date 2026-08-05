FROM oven/bun:1.3.8-debian AS build

USER root
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json biome.json ./
COPY src ./src
RUN bun run typecheck && bun run lint && bun test

FROM oven/bun:1.3.8-debian AS runtime

USER root
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY scripts/docker-run.sh ./scripts/docker-run.sh

RUN chmod 0755 ./scripts/docker-run.sh \
    && mkdir -p /app/logs /app/state

ENV NODE_ENV=production \
    TZ=Asia/Bangkok

ENTRYPOINT ["/app/scripts/docker-run.sh"]
CMD ["run"]
