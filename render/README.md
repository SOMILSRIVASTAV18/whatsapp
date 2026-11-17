# Render Deployment Server (`/render`)

Single standalone folder for deploying the WhatsApp Broadcast backend on [Render](https://render.com) (using a single `server.js` file — no Chromium, no Puppeteer, and no Docker required).

## Deploy on Render

1. Push this repository to GitHub (or copy the contents of `/render` into its own repository).
2. Open [dashboard.render.com](https://dashboard.render.com) → **New +** → **Web Service**.
3. Configure:
   - **Root Directory:** `render` *(leave blank if `/render` is pushed as its own repo)*
   - **Language / Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Health Check Path:** `/api/health`
4. Deploy and copy your live HTTPS URL (for example `https://whatsapp-broadcast-server.onrender.com`, **without** any port number).
5. Open your Cloudflare Pages / Netlify dashboard (`broadcast.tsdc.in`), click the backend status badge in the header, paste your Render URL, and click **Test Connection** → **Save & Apply**.
