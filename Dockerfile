FROM node:20-slim

# Install system dependencies and Chromium for Puppeteer / WhatsApp Web
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

# Configure environment variables
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PORT=3000
ENV HOST=0.0.0.0
ENV NODE_ENV=production

WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm clean-install --omit=dev --progress=false || npm install --omit=dev

# Copy application code
COPY . .

# Ensure static files are built
RUN npm run build || true

# Expose server port
EXPOSE 3000

# Start Express server with WhatsApp Web automation
CMD ["node", "server.js"]
