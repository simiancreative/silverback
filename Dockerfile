FROM node:20-slim

WORKDIR /app

# Install system deps
RUN apt-get update && apt-get install -y \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy package files and install
COPY package.json package-lock.json ./
RUN npm ci --production

# Copy built code
COPY dist/ ./dist/
COPY config/ ./config/

# Non-root user
RUN groupadd -r botuser && useradd -r -g botuser botuser
USER botuser

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
