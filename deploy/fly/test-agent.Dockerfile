# syntax=docker/dockerfile:1.7

FROM rust:1.95-bookworm AS builder
WORKDIR /build
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN cargo build --release --locked -p buzz-acp -p buzz-agent -p buzz-cli -p buzz-dev-mcp \
    && strip target/release/buzz-acp target/release/buzz-agent \
        target/release/buzz target/release/buzz-dev-mcp

FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/target/release/buzz-acp /usr/local/bin/buzz-acp
COPY --from=builder /build/target/release/buzz-agent /usr/local/bin/buzz-agent
COPY --from=builder /build/target/release/buzz /usr/local/bin/buzz
COPY --from=builder /build/target/release/buzz-dev-mcp /usr/local/bin/buzz-dev-mcp
USER node
WORKDIR /home/node
ENTRYPOINT ["/usr/local/bin/buzz-acp"]
