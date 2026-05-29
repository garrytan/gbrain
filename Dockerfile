FROM oven/bun:1 AS build

WORKDIR /app

COPY package.json bun.lock ./
COPY admin/package.json admin/bun.lock ./admin/

RUN bun install --frozen-lockfile
RUN cd admin && bun install --frozen-lockfile

COPY . .

RUN bun run build:admin
RUN bun run build

FROM oven/bun:1 AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3131
ENV CORTEX_BIND=0.0.0.0
ENV CORTEX_HOME=/data/cortex

COPY --from=build /app/bin/cortex /app/bin/cortex
COPY deploy/saas/entrypoint.sh /usr/local/bin/cortex-entrypoint

RUN mkdir -p /data/cortex \
  && chmod 700 /data/cortex \
  && chmod +x /usr/local/bin/cortex-entrypoint \
  && ln -s /app/bin/cortex /usr/local/bin/cortex

EXPOSE 3131

ENTRYPOINT ["/usr/local/bin/cortex-entrypoint"]
CMD ["web"]
