FROM oven/bun:1
WORKDIR /app

# Install Node.js (needed for claude-agent-acp runtime) and git
RUN apt-get update && \
    apt-get install -y curl git && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install dependencies (includes @zed-industries/claude-agent-acp + ACP SDK)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Verify
RUN node --version && bun --version && git --version && \
    ls node_modules/.bin/claude-agent-acp

# Copy wmlet runtime sources
COPY wmlet.ts auth.ts protocol.ts ./

# Workspace
RUN mkdir -p /workspace && git -C /workspace init
VOLUME /workspace

ENV WMLET_PORT=31337
ENV WORKSPACE_DIR=/workspace

EXPOSE 31337

CMD ["bun", "run", "wmlet.ts"]
