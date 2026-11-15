# WhatsApp Broadcast Standalone Render Server

This folder is a **completely self-contained Node.js + Chromium backend server** for WhatsApp Web automation (`whatsapp-web.js`), designed to be deployed independently on [Render](https://render.com) and connected to your Cloudflare Pages dashboard (`broadcast.tsdc.in`).

---

## Step 1: Deploy to Render

### Option A: Deploy directly from this repository (Using Root Directory)
1. Push your repository to GitHub/GitLab.
2. Open [dashboard.render.com](https://dashboard.render.com) → **New +** → **Web Service**.
3. Connect your repository and configure:
   - **Name**: `whatsapp-broadcast-backend`
   - **Root Directory**: `render-server`
   - **Runtime / Language**: **Docker**
   - **Instance Type**: **Free** (or Starter for always-on WhatsApp sessions)
4. Click **Create Web Service**.

### Option B: Push `/render-server` as its own standalone GitHub repository
1. Copy the contents of the `/render-server` folder into a new repository.
2. On Render, create a **New Web Service**, connect that repository, choose **Docker**, and deploy.

---

## Step 2: Copy Your Render Server URL

Once Render finishes deploying, it gives you a live HTTPS URL such as:
`https://whatsapp-broadcast-backend.onrender.com`

Verify it works by opening `https://whatsapp-broadcast-backend.onrender.com/api/health` in your browser — you should see:
`{"status":"ok","server":"WhatsApp Broadcast Render Server",...}`

---

## Step 3: Insert the Link in Your Broadcast Desk

1. Open your Cloudflare Pages dashboard (`https://broadcast.tsdc.in` or `*.pages.dev`).
2. Click the **"BACKEND: OFFLINE"** pill in the top header (or click **Connect Server** on the WhatsApp Connect page).
3. Paste your Render URL (`https://whatsapp-broadcast-backend.onrender.com`) into **Node.js Backend Server URL**.
4. Click **Test Connection** → **Save & Apply**.
5. Go to **WhatsApp Connect** → **Start Pairing / Generate QR** and scan the QR code with your phone.
