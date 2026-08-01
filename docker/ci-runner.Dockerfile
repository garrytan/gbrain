FROM oven/bun:1

RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
