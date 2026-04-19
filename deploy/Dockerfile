FROM oven/bun:1.1-debian

# git for notes repo + ssh client for deploy key + ca-certs for HTTPS to OpenAI/Supabase
RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssh-client ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

# App source
COPY src ./src
COPY deploy ./deploy
COPY recipes ./recipes
COPY skills ./skills
COPY templates ./templates

RUN chmod +x /app/deploy/start.sh

ENV PORT=8080
EXPOSE 8080

CMD ["/app/deploy/start.sh"]
