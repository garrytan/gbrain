FROM oven/bun:1.3.14-alpine
WORKDIR /app
COPY package.json bun.lock ./
# Installation must not run setup orchestration or start services during a coordinated upgrade.
COPY scripts/ scripts/
RUN bun install --frozen-lockfile --ignore-scripts
COPY . .
# Explicitly copy schema packs and place them in gbrain's lookup path
COPY schema-packs/ /root/.gbrain/schema-packs/
RUN cd admin && bun install --frozen-lockfile --ignore-scripts && cd .. && bun run build:admin
ENV PORT=3131
EXPOSE 3131
# v0.46: --http-secret flag removed; serve-http reads GBRAIN_ADMIN_BOOTSTRAP_TOKEN from env directly (validated >=32 chars at boot)
CMD bun run src/cli.ts serve --http --bind 0.0.0.0 --public-url https://gbrain-production-c2e0.up.railway.app
