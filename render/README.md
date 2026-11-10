# Deploy WhatsApp Personal Broadcast Desk on Render

This folder contains all configuration files needed to deploy the application on [Render](https://render.com) with full **WhatsApp Web automation (Chromium + Puppeteer)** support.

---

## 🚀 Option 1: Deploy with Docker (Recommended)

Docker is the most reliable way to run `whatsapp-web.js` on Render because Chromium and its required Linux graphics/font libraries are pre-installed in the container.

### Step-by-Step Instructions:

1. **Push your code to GitHub or GitLab**:
   Make sure `Dockerfile`, `.dockerignore`, `server.js`, and `package.json` are committed to your repository.

2. **Log into Render**:
   - Go to [dashboard.render.com](https://dashboard.render.com).
   - Click **New +** &rarr; **Web Service**.

3. **Connect your Repository**:
   - Select your GitHub / GitLab repository.

4. **Configure the Service**:
   - **Name**: `whatsapp-broadcast-desk` (or any name you prefer)
   - **Region**: Choose the closest region (e.g. `Oregon (US West)` or `Frankfurt (EU)`)
   - **Environment / Runtime**: Select **Docker**
   - **Dockerfile Path**: `Dockerfile` (or `render/Dockerfile` if deploying from subfolder)
   - **Instance Type**: **Free**

5. **Environment Variables**:
   Under **Environment Variables**, add:
   | Key | Value | Description |
   |---|---|---|
   | `PORT` | `3000` | Port for Express server |
   | `HOST` | `0.0.0.0` | Bind address for Render |
   | `NODE_ENV` | `production` | Production mode |
   | `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` | `true` | Uses installed Chromium |
   | `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium` | Path to system Chromium |

6. **Deploy**:
   - Click **Create Web Service**.
   - Render will build the container, install Chromium, start `server.js`, and provide a public URL like `https://whatsapp-broadcast-desk.onrender.com`.

---

## ⚡ Option 2: Deploy with Render Blueprint (`render.yaml`)

If your repository has `render.yaml` at the root:

1. Go to [dashboard.render.com/blueprints](https://dashboard.render.com/blueprints).
2. Click **New Blueprint Instance**.
3. Select your repository.
4. Render automatically configures the service, ports, and environment variables.
5. Click **Apply**.

---

## 💻 Option 3: Deploy with Native Node.js (Without Docker)

If you prefer Render's native Node.js runtime instead of Docker:

1. On Render, select **Runtime**: `Node`.
2. Set:
   - **Build Command**: `chmod +x ./render/render-build.sh && ./render/render-build.sh`
   - **Start Command**: `node server.js`
3. Add Environment Variables:
   - `PUPPETEER_CACHE_DIR`: `/opt/render/project/src/.cache/puppeteer`
   - `PORT`: `3000`
   - `HOST`: `0.0.0.0`

---

## 📱 Pairing WhatsApp on Render

1. Open your Render web service URL (`https://your-service.onrender.com`).
2. Sign in or register with your email (via Firebase).
3. Go to the **WhatsApp Connect** tab.
4. Click **Start Pairing / Generate QR**.
5. Scan the QR code with WhatsApp on your phone:
   - **Settings** (or **Menu ⋮**) &rarr; **Linked Devices** &rarr; **Link a Device**.
6. Once connected, your status will turn green (`CONNECTED`) and you can broadcast campaigns!
