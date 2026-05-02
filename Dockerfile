FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libasound2 \
    libxrandr2 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxext6 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-xcb1 \
    fonts-liberation \
    ca-certificates \
    && ln -sf /usr/bin/chromium /usr/bin/chromium-browser 2>/dev/null || true \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_OPTIONS="--max-old-space-size=384"

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "server.js"]