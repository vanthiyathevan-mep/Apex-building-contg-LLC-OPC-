# Hosting the ERP

The app is a single Node.js process that stores everything in one SQLite file. Hosting it needs three things:

1. **A server that stays on**, so staff can reach it from phones and office PCs.
2. **Persistent storage** for the database file. Without it, all data is lost on every restart or update.
3. **HTTPS**, so passwords and business data are encrypted in transit.

Choose **one** of the options below. Option A is easiest. Option B gives the most control.

---

## Option A: Render (easiest, no server to manage)

Render builds the app from this GitHub repository and redeploys automatically when `main` changes. The included `render.yaml` sets everything up: a Docker web service, a health check and a 1 GB persistent disk.

1. Sign up at https://render.com with your GitHub account.
2. Click **New + → Blueprint** and choose the `Apex-building-contg-LLC-OPC-` repository. Render reads `render.yaml`.
3. When it asks for **ERP_ADMIN_PASSWORD**, enter a long password. This is the `admin` login.
4. Click **Apply**. The first build takes a few minutes. You then get an address like `https://apex-erp.onrender.com`.
5. Optional: under **Settings → Custom Domains**, add your own domain, for example `erp.yourcompany.ae`. Render provides HTTPS for it automatically.

Notes:
- A persistent disk needs a paid instance type. The blueprint uses `starter`. Check current pricing on Render before applying.
- Render's free tier has no persistent disk, so data would be lost. Don't use it for real data.
- **Backups:** Render takes daily disk snapshots. For an extra copy, open the service's **Shell** tab and run `npm run backup`. Snapshots go to `/data/backups/`.

---

## Option B: Your own server (VPS) with Docker

This works on any Linux VPS (DigitalOcean, Hetzner, AWS Lightsail, a UAE cloud provider, or an office machine) with 1 GB RAM or more. Caddy handles HTTPS with free, auto-renewing certificates.

**Before you start:** create a DNS **A record** for your chosen domain (for example `erp.yourcompany.ae`) pointing at the server's public IP. Open ports **80** and **443** in the firewall.

```bash
# 1. Install Docker (Ubuntu/Debian)
curl -fsSL https://get.docker.com | sh

# 2. Get the code
git clone https://github.com/vanthiyathevan-mep/Apex-building-contg-LLC-OPC-.git
cd Apex-building-contg-LLC-OPC-

# 3. Configure
cp deploy/.env.example .env
nano .env        # set ERP_DOMAIN and ERP_ADMIN_PASSWORD

# 4. Start (restarts automatically after reboots)
docker compose up -d --build
```

Then open `https://erp.yourcompany.ae` and sign in as `admin`.

**Update to the latest version:**
```bash
git pull && docker compose up -d --build
```

**Daily backups:** add this to the server's crontab (`crontab -e`). It runs at 2am and keeps the last 30 snapshots:
```
0 2 * * * cd /root/Apex-building-contg-LLC-OPC- && docker compose exec -T app npm run -s backup
```
Snapshots are stored inside the data volume at `/data/backups/`. To copy the newest one off the server:
```bash
docker compose cp app:/data/backups ./backups
```
Keep copies somewhere other than the server too, such as a cloud drive.

**Restore a backup:** stop the app with `docker compose stop app`. Copy the snapshot over the live database with `docker compose cp ./erp-YYYYMMDD-HHMMSS.db app:/data/erp.db`. Then run `docker compose start app`.

---

## After the first sign-in (both options)

1. **My Account:** confirm you can sign in, and change the password if others saw it.
2. **Company Settings:** enter the address, TRN, phone, email, bank details and invoice terms. These appear on printed invoices and POs.
3. **Users:** create one account per person with the right role (manager, accountant, site_engineer, viewer). Don't share the admin login.
4. Start entering clients, employees, projects, and so on.

Don't set `ERP_DEMO=1` on a live server. It's only for trying the app with sample data.

## Configuration reference

| Variable | Set by | Purpose |
|---|---|---|
| `ERP_ADMIN_PASSWORD` | you | Password for the first `admin` user. Only used when the database is empty |
| `ERP_DOMAIN` | you (VPS) | Domain Caddy requests a certificate for |
| `ERP_DB_FILE` | preset `/data/erp.db` | Database location (on the persistent volume) |
| `ERP_SECURE_COOKIES` | preset `1` | Session cookies are only sent over HTTPS |
| `ERP_TRUST_PROXY` | preset `1` | Uses the real client IP from the proxy for login throttling |
| `ERP_BACKUP_KEEP` | optional | How many backup snapshots to keep (default 30) |
| `PORT` | preset `3000` | Internal port |
