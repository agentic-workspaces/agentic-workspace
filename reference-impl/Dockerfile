FROM oven/bun:1
WORKDIR /app

# Install Node.js (needed for claude-code) and git
RUN apt-get update && \
    apt-get install -y curl git && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g @anthropic-ai/claude-code && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Verify
RUN node --version && claude --version && bun --version && git --version

# Copy wmlet
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY wmlet.ts ./

# Workspace
RUN mkdir -p /workspace && git -C /workspace init
VOLUME /workspace

ENV PORT=31337
ENV WORKSPACE_DIR=/workspace

EXPOSE 31337

CMD ["bun", "run", "wmlet.ts"]
