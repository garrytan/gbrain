FROM oven/bun:1.3.13

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile

COPY . .

ENV NODE_ENV=production
ENV GBRAIN_HOME=/data/gbrain
ENV PORT=3000

EXPOSE 3000

CMD ["bash", "scripts/railway-start.sh"]
