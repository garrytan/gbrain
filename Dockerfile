FROM oven/bun:1.3.13

WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile

COPY . .

ENV NODE_ENV=production
ENV GBRAIN_HOME=/data/gbrain
ENV PORT=3000

EXPOSE 3000

CMD ["bash", "scripts/railway-start.sh"]
