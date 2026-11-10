# ============================================================
# Render Dockerfile for WhatsApp Personal Broadcast Desk
# ============================================================
FROM node:20-slim

# Install system libraries and Chromium for Puppeteer / whatsapp-web.js
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Point Puppeteer to system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PORT=3000
ENV HOST=0.0.0.0
ENV NODE_ENV=production

WORKDIR /app

# Install npm dependencies
COPY package*.json ./
RUN npm clean-install --omit=dev --progress=false || npm install --omit=dev

# Copy application source
COPY . .

# Ensure static production files exist
RUN npm run build || true

EXPOSE 3000

# Run Express server (serves frontend + whatsapp-web.js API)
CMD ["node", "server.js"]
