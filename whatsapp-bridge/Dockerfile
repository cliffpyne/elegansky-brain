# Render-compatible Dockerfile for the WhatsApp bridge.
#
# whatsapp-web.js → puppeteer → bundled Chromium. The bundled Chromium
# needs a pile of Linux libs to actually launch — install them so the
# puppeteer.launch() call inside whatsapp-web.js succeeds in headless mode.
FROM node:20-bullseye-slim

# Chromium runtime deps (matches the existing SETUP.md list + a couple
# extras puppeteer needs on bullseye).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libnss3 libatk-bridge2.0-0 libgbm1 libasound2 libxshmfence1 \
    libxcomposite1 libxdamage1 libxrandr2 libxkbcommon0 libpango-1.0-0 \
    libcairo2 libcups2 libnspr4 libdrm2 libgtk-3-0 libxss1 libgconf-2-4 \
    fonts-liberation libappindicator3-1 libsecret-1-0 \
    wget gnupg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install npm deps — this downloads puppeteer's bundled Chromium too
# (~190MB, one-time during build).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY bridge.js ./

# Persistent disk mount on Render — set the LocalAuth session dir here so
# the QR-scan survives container restarts.
ENV SESSION_DIR=/var/data/session

CMD ["node", "bridge.js"]
