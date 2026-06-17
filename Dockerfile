# gbrain — standalone K8s pod image
# Build: docker build -t ghcr.io/littlerandom/gbrain:latest .
# Uses git clone + bun install (workaround for bun install -g #218)

FROM oven/bun:1 AS builder

# Install git (not included in oven/bun:1)
RUN apt-get update -qq && apt-get install -y -qq git 2>&1

# Clone and install gbrain from source (workaround for #218)
# bun install -g can produce broken PGLite WASM
COPY . /tmp/gbrain/
RUN cd /tmp/gbrain && \
    bun install 2>&1 && \
    bun link 2>&1

# Verify install
RUN gbrain --version

FROM oven/bun:1

# Copy the installed gbrain from builder
COPY --from=builder /root/.bun /root/.bun
COPY --from=builder /tmp/gbrain /tmp/gbrain

# Create symlink for gbrain command (bun link doesn't auto-create /usr/local/bin/gbrain)
RUN ln -sf /tmp/gbrain/src/cli.ts /usr/local/bin/gbrain

# Make /root accessible to non-root users
RUN chmod 755 /root

# Copy entrypoint
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /root/.gbrain

EXPOSE 3001

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["gbrain", "serve", "--http", "--port", "3001", "--bind", "0.0.0.0"]
