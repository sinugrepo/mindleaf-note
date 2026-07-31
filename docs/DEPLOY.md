# 🚀 Mindleaf Production Deploy Guide

End-to-end walkthrough dari VPS baru sampai Mindleaf production-ready. Terdiri dari
dua fase besar: **(A) one-time VPS provisioning** (jalan sekali per VPS) dan
**(B) per-release deploys** (ulang tiap kali merge ke `main`).

> Mindleaf production stack = Hono backend di `systemd` + Postgres apt-installed
> di-host + Caddy (reverse-proxy + TLS auto) + daily pg_dump → R2 via rclone.

```
┌──────────────────────────────────────────────────────────────────────┐
│                Cloudflare CDN (your-domain.com)                       │
│                DNS A-record → 198.51.100.42                          │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ HTTPS (Let's Encrypt via Caddy)
                           ▼
 ┌────────────────────────────────────────────────────────────────────┐
 │  VPS  (Ubuntu 24.04 LTS, 1 vCPU / 1 GB RAM minimum)                │
 │  ┌──────────────┐    ┌──────────────┐    ┌───────────────────┐   │
 │  │   Caddy      │    │  Hono (Node) │    │   postgresql-16   │   │
 │  │   :443/80    │───►│   :8787      │───►│   :5432           │   │
 │  │   reverse-   │    │   systemd    │    │   apt-installed   │   │
 │  │   proxy+SPA  │    │   mindleaf   │    │   (NOT dockerized) │   │
 │  └──────────────┘    └──────────────┘    └───────────────────┘   │
 │                                                                    │
 │  Cron: 03:00 UTC daily ──► pg_dump -Fc ──► rclone ──► R2 bucket   │
 └────────────────────────────────────────────────────────────────────┘
```

---

## 0. Pre-requisites

Sebelum menjalankan apapun, sediakan dahulu:

| # | Item | Catatan |
|---|---|---|
| 1 | **VPS** dengan Ubuntu 24.04 LTS, ≥ 1 vCPU / ≥ 1 GB RAM | Hetzner / DigitalOcean / Vultr, dll |
| 2 | **Domain** yang dibeli (Cloudflare Registrar / Namecheap / dll) | Target FQDN: mis. `mindleaf.example.com` |
| 3 | **DNS A-record** untuk domain → IP publik VPS | **Cloudflare orange-cloud proxy HARUS OFF** untuk first-time cert issue + renewal. Caddy pakai ACME HTTP-01 challenge — Cloudflare HTTP proxy bisa intermittent-fail forward challenge ke origin (mysterious cert-renewal errors di journal). Kalau tetap mau orange-cloud ON: pakai **DNS-only record untuk `_acme-challenge.mindleaf.example.com`** (allow Caddy resolve path langsung) **ATAU** pakai Cloudflare Full SSL mode + tunggu propagasi DNS untuk renewal. |
| 4 | **Cloudflare R2 bucket** (pisah: `mindleaf-prod` untuk attachments, `mindleaf-prod-backups` untuk db dumps) | Account ID + Access Key + Secret Key siap |
| 5 | **SSH key pair** untuk akses `mindleaf@<vps>` tanpa password | Opsional tapi recommended |
| 6 | **Laptop lokal** dengan repo Mindleaf ter-clone + Node 22 + ssh + rsync | Untuk menjalankan `scripts/deploy.sh` |

> 🚨 **Untuk first-time**: butuh akses root ke VPS selama ~5 menit via SSH. Setelah
> `bootstrap.sh` selesai, login sebagai `root` tidak lagi diperlukan (cukup
> `mindleaf` user).
>
> ⚠️ **ALLOWED_ORIGIN coupling**: variabel `ALLOWED_ORIGIN` di `/opt/mindleaf/.env`
> HARUS **exact match** dengan domain yang di-serve Caddy (`scheme://host[:port]`,
> no trailing slash). Jika `.env` punya `https://mindleaf.example.com` tapi Caddy
> serve `https://www.mindleaf.example.com` (atau `http://` vs `https://` mismatch),
> CORS preflight akan reject login fetch dari browser — operator melihat SPA load
> tapi POST `/api/auth/login` 403. Selalu re-check kedua sisi setelah perubahan
> domain atau TLS config.
>
> 🚨 **MASTER_ENCRYPTION_KEY adalah single point of failure untuk seluruh data**:
> server-side encryption berarti tanpa key ini, semua ciphertext di database
> (`content_ct` + `content_nonce`) tidak bisa di-decrypt — **termasuk oleh
> R2 backup dumps** yang dibuat oleh pg_dump (dump-nya berisi encrypted bytes,
> butuh key untuk di-decrypt). Backup tanpa key = tidak berguna. Simpan `.env`
> di password manager yang aman (1Password / Bitwarden), BUKAN hanya di VPS.
> Rotation butuh re-encrypt SEMUA notes (custom script, belum built-in).

---

## 1. (Fase A) One-time VPS Provisioning

Jalan sekali setiap VPS baru. Idempotent — aman re-run kapan saja.

### 1.1 Login sebagai root ke VPS baru

```bash
ssh root@<vps-ip>
# Update + install ssh keys mindleaf
```

### 1.2 Copy repo ke `/opt/mindleaf` (root temporary ownership)

```bash
# Di laptop lokal:
rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'apps/server/dist' \
  --exclude 'apps/web/dist' \
  ./ mindleaf-tmp/

# Upload ke VPS:
scp -r mindleaf-tmp/ root@<vps-ip>:/opt/mindleaf/
```

> 🟡 **Penting**: `/opt/mindleaf/apps/server/.env.production.example` HARUS sampai ke
> VPS sebelum `bootstrap.sh` berjalan (script butuh template untuk generate `.env`).

### 1.3 Generate rclone config (di laptop lokal)

rclone config berisi secret Access Key — masukkan lewat env var supaya tidak pernah
muncul di process list atau git history.

```bash
# Di laptop lokal — pakai rclone interaktif satu kali:
rclone config
# Pilih: New remote → nama `r2` → type `cloudflare` → masukkan Account ID +
# Access Key + Secret Key. Optional: scope ke bucket mindleaf-prod-backups.

# Export ke env var (base64):
export RCLONE_CONF_B64="$(cat ~/.config/rclone/rclone.conf | base64 -w0)"
```

### 1.4 `export ALLOWED_ORIGIN` di shell root

Domain ini akan di-substitute ke `.env` setelah template di-copy.

```bash
ssh root@<vps-ip>
export ALLOWED_ORIGIN="https://mindleaf.example.com"   # ganti dengan domain anda
```

### 1.5 Run `bootstrap.sh`

```bash
sudo bash /opt/mindleaf/deploy/scripts/bootstrap.sh
```

Apa yang terjadi:

| Step | Apa yang dilakukan |
|---|---|
| 1 | `apt-get install postgresql-16 caddy rclone ca-certificates curl gnupg` |
| 2 | Buat user `mindleaf` (no password login, group `www-data` + `ssl-cert`) |
| 3 | `mkdir /opt/mindleaf`, owner `mindleaf:mindleaf` |
| 4 | Generate `/opt/mindleaf/.env` (mode `0600`, owner `mindleaf`) dari template: `SESSION_SECRET`, `MASTER_ENCRYPTION_KEY`, db password di-generate via `openssl rand -base64 32` |
| 5 | Provision Postgres: create role + db `mindleaf`, write `/opt/mindleaf/.pgpass` (mode `0600`) untuk cron access passwordless |
| 6 | Write `/opt/mindleaf/.config/rclone/rclone.conf` dari `$RCLONE_CONF_B64` (mode `0600`) |
| 7 | `npm run db:push --workspace=@mindleaf/server` — apply Drizzle schema |

**Output sukses ditunjukkan oleh**:
- `[ok] /opt/mindleaf/.env — chmod 600` (di log script)
- `db:push complete`
- `next steps: ...`

### 1.6 Verifikasi pasca-bootstrap

```bash
# 1. Cek .env ada + permission 600
ls -la /opt/mindleaf/.env
# expect: -rw------- 1 mindleaf mindleaf <date> /opt/mindleaf/.env

# 2. Cek Postgres up + db ada
sudo -u postgres psql -c "\l" | grep mindleaf
sudo systemctl status postgresql

# 3. Cek Caddy up + listening
sudo systemctl status caddy
ss -tlnp | grep :443 || ss -tlnp | grep caddy

# 4. Cek rclone config valid
sudo -u mindleaf RCLONE_CONFIG=/opt/mindleaf/.config/rclone/rclone.conf \
  rclone lsd r2:
# expect: list buckets (mindleaf-prod-backups, dll)
```

---

## 2. (Fase B) First-time Deploy

Sekarang VPS punya semua paket + secrets, tapi `mindleaf-backend` belum ter-install
di systemd. Kita jalankan `scripts/deploy.sh` dari laptop lokal — script ini
meng-handle full deploy: git pull → build → systemd unit → Caddy reload →
restart + healthcheck (+ auto-rollback kalau gagal).

### 2.1 Test `--dry-run` dulu

```bash
# Di laptop lokal:
scripts/deploy.sh --vps mindleaf@<vps-ip-or-domain> --dry-run
```

Output dry-run **akan list semua command** yang akan dijalankan tanpa benar-benar
jalan. Periksa:

- Apakah ada typo di host / path
- Apakah build langkahnya masuk akal
- Apakah tidak ada step yang mengagetkan

### 2.2 Run deploy untuk pertama kali

```bash
scripts/deploy.sh --vps mindleaf@<vps-ip>
```

Step internal (untuk referensi audit saja — anda tidak perlu interaksi):
nomor step berikut = numbering yang dipakai oleh `scripts/deploy.sh`.

| Step | Apa yang dilakukan |
|---|---|
| 1 | Verify prereqs (`/healthz` check terbalik, postgres up, node ada, dll) — fail-fast jika passwordless sudo belum di-setup |
| 2 | `git pull --ff-only` di VPS (membutuhkan SSH deploy key di `/home/mindleaf/.ssh/` yang punya akses ke git remote — **bukan** `/root/.ssh/`; jika git auth break, deploy hang di SSH prompt) |
| 3 | `npm ci` (full workspace) + `npm install --omit=dev` di apps/server |
| 4 | `npm run lint --workspace=@mindleaf/server` (typecheck) + snapshot `apps/server/dist` ke `dist.bak.<timestamp>` (untuk rollback) + `npm run build --workspace=@mindleaf/server` (tsc → `dist/index.js`) |
| 5 | `npm run build --workspace=@mindleaf/web` (Vite → `apps/web/dist`) |
| 6 | `rsync apps/web/dist/ → /var/www/mindleaf/dist/` di VPS — ada 2 paths: jika `apps/web/dist/` ada **di laptop lokal** yang menjalankan deploy, rsync dari lokal; kalau tidak, rsync dari VPS setelah build di sana. Keduanya menghasilkan hasil identik; jalur lokal sedikit lebih cepat. |
| 7 | Install `systemd/mindleaf.service`, `Caddyfile`, `cron.d/mindleaf-backup` di `/etc/`. Validasi `caddy validate` dulu, lalu `systemctl reload caddy` (zero-downtime, bukan restart). |
| 8 | `npm run db:push` (unless `--no-migrate`) — Drizzle schema apply. **WARNING**: `db:push` adalah stateful — kalau menulis schema yang salah, recovery adalah pg_restore dari R2 dump (§4.1) atau surgical rollback via `drizzle-kit drop` + manual ALTER. Untuk experimental columns, simulasikan dulu di local docker compose. |
| 9 | `systemctl restart mindleaf` + healthcheck loop: poll `http://localhost:8787/healthz` tiap 2 detik, max 60 detik. Auto-rollback ke `dist.bak.*` snapshot kalau healthcheck gagal |

Sukses = output akhir `=== Deploy complete ===` dengan `pre:` / `post:` rev tags.

### 2.3 Browser-side verification

```bash
# 1. Caddy sudah serve HTTPS?
curl -fsS -I https://mindleaf.example.com | head -3
# expect: HTTP/2 200, Strict-Transport-Security header ada

# 2. Backend health reachable via Caddy
curl -fsS https://mindleaf.example.com/healthz
# expect: {"ok":true}

# 3. Buka di browser:
https://mindleaf.example.com
# expect: SPA login page muncul
```

### 2.4 First-time setup: bikin master password

> Ini adalah flow **Onboarding Wizard** (Phase 8) — bukan dari VPS CLI.

1. Login pertama ke SPA → masukkan master password baru (min 8 char)
2. Backend automatically creates user row via `POST /api/auth/setup` (rate-limited)
3. Cookie HttpOnly di-set (SameSite=Strict, 30-day rolling expiry)
4. IndexedDB kosong (browser baru / private mode) → full upload available

---

## 3. Ongoing Operations

Setelah first deploy sukses, ada beberapa operation flow untuk minggu/bulan berikutnya.

### 3.1 Deploy perubahan baru (tiap release)

```bash
# Standar: setiap merge ke main → deploy ulang
scripts/deploy.sh --vps mindleaf@<vps-ip>
```

Build সময় ~2-3 menit (npm ci + tsc + Vite build + rsync). Backend downtime ~5-10
detik selama restart (roll-window). Tidak zero-downtime — itu acceptable karena
single-user app; user tinggal refresh browser kalau barusan logout.

### 3.2 Skip DB migration (kalau yakini schema tidak berubah)

```bash
scripts/deploy.sh --vps mindleaf@<vps-ip> --no-migrate
```

Hemat ~30 detik dan menghindari false-positive error kalau db:push menolak perubahan
trivial (e.g. existing table).

### 3.3 Rollback ke versi sebelumnya

```bash
# Restore dist.bak.<timestamp> paling baru:
scripts/deploy.sh --vps mindleaf@<vps-ip> --rollback
```

Snapshot mekanisme:
- Setiap deploy sukses sebelumnya menyimpan snapshot: `/opt/mindleaf/apps/server/dist.bak.<unix-timestamp>`
- Yang paling baru dipakai oleh `--rollback`
- Snapshot terakhir dipertahankan; yang lebih lama di-prune otomatis (keep last 2)

### 3.4 Logs (pino JSON → journald)

```bash
# Realtime follow mindleaf backend logs:
journalctl -u mindleaf -f

# Pretty-print JSON per baris:
journalctl -u mindleaf -o cat | jq .

# Filter by request-id tertentu (debugging single request):
journalctl -u mindleaf -o cat | jq 'select(.requestId == "<uuid>")'

# Logs error-level only (last 100):
journalctl -u mindleaf -p err -n 100

# Caddy logs (HTTPS access, upstream, dll):
journalctl -u caddy -f

# Backup logs:
journalctl -t mindleaf-backup -n 100
# atau via stdout log file:
tail -f /var/log/mindleaf-backup.log
```

### 3.5 Restart / stop service manual

```bash
# Restart:
sudo systemctl restart mindleaf

# Stop:
sudo systemctl stop mindleaf

# Status:
sudo systemctl status mindleaf

# Disable auto-restart temporarily:
sudo systemctl mask mindleaf
```

### 3.6 Daily backups — verify cron+output

```bash
# 1. Cek cron aktif:
sudo systemctl status cron && systemctl list-timers | grep mindleaf

# 2. Manual trigger (test backup flow end-to-end):
sudo -u mindleaf /opt/mindleaf/scripts/backup.sh
# expect: "acquired lock" → "pg_dump ok (size=...)" → "rclone ok" → "retention sweep ok"

# 3. List backup di R2:
sudo -u mindleaf RCLONE_CONFIG=/opt/mindleaf/.config/rclone/rclone.conf \
  rclone lsjson r2:mindleaf-prod-backups/db/

# 4. Inspect specific dump:
sudo -u mindleaf RCLONE_CONFIG=/opt/mindleaf/.config/rclone/rclone.conf \
  rclone lsjson r2:mindleaf-prod-backups/db/<date>-mindleaf-<timestamp>.dump
```

Cadence: **03:00 UTC** daily (`/etc/cron.d/mindleaf-backup`). Retention: 30 hari.

---

## 4. Disaster Recovery

### 4.1 Restore database dari R2 backup

```bash
# 1. List dumps:
sudo -u mindleaf RCLONE_CONFIG=/opt/mindleaf/.config/rclone/rclone.conf \
  rclone lsf r2:mindleaf-prod-backups/db/

# 2. Download yang ingin di-restore:
sudo -u mindleaf RCLONE_CONFIG=/opt/mindleaf/.config/rclone/rclone.conf \
  rclone copy r2:mindleaf-prod-backups/db/<date>-mindleaf-<stamp>.dump /tmp/

# 3. Stop backend selama restore:
sudo systemctl stop mindleaf

# 4. Restore — replaces existing data (--clean):
sudo -u postgres pg_restore \
  --dbname=mindleaf \
  --clean \
  --no-owner \
  --no-acl \
  /tmp/<date>-mindleaf-<stamp>.dump

# 5. Restart backend:
sudo systemctl start mindleaf

# 6. Browser-verified login:
https://mindleaf.example.com → login → notes kembali
```

### 4.2 VPS rebuild total

Jika VPS rusak total (disk corruption / provider migration), restore order:

1. Provision VPS baru (Ubuntu 24.04 LTS), install SSH key mindleaf
2. Setup DNS A-record ke IP baru (kalau IP berubah)
3. `rsync` repo ke `/opt/mindleaf` (lihat §1.2)
4. `scp` `.env` lama (DIREKOMENDASIKAN) **ATAU** jalankan `bootstrap.sh` untuk regenerate
5. Download Postgres dump latest dari R2
6. `pg_restore` ke db baru (lihat §4.1.4-5)
7. Update rclone config (kalau bucket berbeda atau `RCLONE_CONF_B64` di-regenerate)
8. `scripts/deploy.sh --vps mindleaf@<new-ip>` (first-deploy path lagi)
9. Login ke Mindleaf, verify Sync layer menarik semua dari server

### 4.3 VPS compromise (root stolen)

> Threat model Mindleaf dengan server-side encryption: VPS root compromise = data
> bocor (encryption key di `.env`). Mitigasi pasca-incident:

1. Provision VPS baru (lihat §4.2)
2. **ROTATE secrets** sebelum backup-restore:
   - Generate `SESSION_SECRET` baru (`openssl rand -base64 32`)
   - Generate `MASTER_ENCRYPTION_KEY` baru
   - ⚠️ **NAMUN**: data yang sudah terenkripsi dengan key lama **TIDAK BISA** di-decrypt
     dengan key baru. Migrasi butuh re-encrypt (di luar scope dokumentasi ini —
     butuh custom script baca → decrypt dengan key lama → encrypt dengan key baru
     → update_db).
3. Rotate semua R2 access keys
4. Force logout user lama via cookie invalidation (rotate `SESSION_SECRET` = semua
   session invalidated otomatis karena HMAC gagal)

---

## 5. Operational Reference

### 5.1 Path cheatsheet

| Path | Owner | Mode | Isi |
|---|---|---|---|
| `/opt/mindleaf/` | `mindleaf:mindleaf` | `755` | Repo root |
| `/opt/mindleaf/.env` | `mindleaf:mindleaf` | `600` | **Production secrets** — jangan pernah commit |
| `/opt/mindleaf/.pgpass` | `mindleaf:mindleaf` | `600` | Postgres password untuk cron |
| `/opt/mindleaf/.config/rclone/rclone.conf` | `mindleaf:mindleaf` | `600` | rclone config (R2 credentials) |
| `/opt/mindleaf/apps/server/dist/` | `mindleaf:mindleaf` | `755` | Backend tsc output (current build) |
| `/opt/mindleaf/apps/server/dist.bak.<ts>/` | `mindleaf:mindleaf` | `755` | Snapshots untuk rollback |
| `/var/www/mindleaf/dist/` | `mindleaf:mindleaf` | `755` | Frontend Vite output (rsynced) |
| `/etc/caddy/Caddyfile` | `root:root` | `644` | Caddy reverse-proxy + SPA fallback |
| `/etc/systemd/system/mindleaf.service` | `root:root` | `644` | Hardened systemd unit |
| `/etc/cron.d/mindleaf-backup` | `root:root` | `644` | Daily 03:00 UTC backup trigger |
| `/var/log/mindleaf-backup.log` | `syslog:adm` | `640` | Backup stdout/stderr (syslog-rotated) |
| `/var/lock/mindleaf-backup.lock` | — | — | `flock` lock file untuk mencegah concurrent backups |

### 5.2 Service quick-reference

```bash
# Service name
systemctl status mindleaf           # backend
systemctl status caddy              # reverse proxy
systemctl status postgresql         # database
systemctl status cron               # cron daemon

# Restart cycle (kalau ada perubahan non-deploy):
sudo systemctl restart mindleaf caddy postgresql

# Tail logs dari semua sekaligus:
journalctl -u mindleaf -u caddy -u postgresql -f
```

### 5.3 SSL certificate (Let's Encrypt via Caddy)

Caddy handle ACME HTTP-01 challenge otomatis — cert + auto-renewal tanpa interaksi.

```bash
# List active certs:
sudo caddy list-certificates

# Cek expiry:
journalctl -u caddy | grep -i certificate | tail -5

# Force-renew (kalau ada komplain):
sudo systemctl restart caddy   # Caddy re-resolves + renews during handshake
```

> HTTPS pakai Cloudflare orange-cloud proxy ON OK juga — tapi DNS A-record
> harus tetap point ke origin IP untuk ACME challenge.

---

## 6. Troubleshooting

### 6.1 `deploy.sh` fail di "Verifying VPS prerequisites"

- **`/opt/mindleaf/.env not found`** → `bootstrap.sh` belum jalan; jalankan §1.5.
- **`permission denied (systemctl)`** → sudoers drop-in belum di-setup; pass //
  shell `# mindleaf ALL=(ALL) NOPASSWD: /bin/systemctl * mindleaf, /usr/bin/rsync`
  ke VPS via `sudo tee /etc/sudoers.d/mindleaf-deploy` (lihat pesan error
  `deploy.sh` — ia akan print recipe lengkap).
- **`node --version` fails** → bootstrap belum install; re-run §1.5.

### 6.2 `caddy validate` rejects Caddyfile

```bash
# Edit di VPS:
sudo nano /etc/caddy/Caddyfile
# Ganti YOUR_DOMAIN dengan FQDN anda.
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### 6.3 Hanya `/healthz` reachable, SPA belum

Cek Caddyfile `@hashed_assets` + SPA fallback handle. Biasanya karena:

- `/var/www/mindleaf/dist/index.html` belum ada → `rsync apps/web/dist` belum jalan.
  Cek via `ls -la /var/www/mindleaf/dist/`.
- Permission `index.html` readable — `sudo chmod -R a+rX /var/www/mindleaf/dist`.

### 6.4 Browser login gagal (401)

```bash
# Cek cookie ada:
curl -sI https://mindleaf.example.com/healthz  | grep -i set-cookie

# Cek Postgres reachable backend:
sudo -u mindleaf psql -c "SELECT id, created_at FROM users LIMIT 1"

# Cek Hono logs:
journalctl -u mindleaf -p err -n 50
```

### 6.5 Backup cron tidak jalan

```bash
# Cek cron daemon up:
sudo systemctl status cron

# Test manual:
sudo -u mindleaf /opt/mindleaf/scripts/backup.sh

# Cek last run stderr:
journalctl -t mindleaf-backup -n 20
# atau
tail -50 /var/log/mindleaf-backup.log
```

### 6.6 `permission denied` pada rclone ke R2

```bash
# Cek credential masih valid:
sudo -u mindleaf RCLONE_CONFIG=/opt/mindleaf/.config/rclone/rclone.conf \
  rclone lsd r2:
# Kalau empty/GCS error → regenerate credentials:
rclone config    # interactive
# Re-export base64 + re-run bootstrap.sh (akan skip .env regenerate, cuma update rclone.conf)
```

### 6.7 `pg_dump: could not connect to server ... permission denied for .pgpass`

Postgres menolak load `.pgpass` jika mode file terlalu permissive. `bootstrap.sh`
meng-chmod `0600`; tapi operator yang manual edit kadang naik ke `0644` untuk
debug, lalu lupa kembalikan.

**Fix**:

```bash
ls -la /opt/mindleaf/.pgpass
# expect: -rw------- 1 mindleaf mindleaf <date> ...
sudo chmod 600 /opt/mindleaf/.pgpass
sudo chown mindleaf:mindleaf /opt/mindleaf/.pgpass
```

Atau lihat log Postgres di `/var/log/postgresql/postgresql-16-main.log` untuk
detail permission yang Postgres lihat.

### 6.8 Drizzle schema-rollback

Jika `npm run db:push` (step 8 di deploy.sh) menulis column/constraint yang
salah, recovery:

- **Surgical rollback**: edit schema di `apps/server/src/db/schema.ts`, lalu
  `npx drizzle-kit drop` untuk undo column yang baru di-push. Atau manual:
  ```sql
  psql -U mindleaf mindleaf -c "ALTER TABLE notes DROP COLUMN bad_column;"
  ```
- **Full DB restore**: lihat §4.1 (pg_restore dari R2 dump).

Untuk experimental columns, simulasikan di local docker compose dulu sebelum
`db:push` ke production.

### 6.9 OOM kills

Systemd unit sudah cap `MemoryMax=768M` + `OOMPolicy=stop` (kill sebelum jadi
SIGKILL). Cek:

```bash
# Past OOMs:
journalctl -u mindleaf | grep -i 'out of memory\|killed process'

# Live memory:
systemctl status mindleaf | grep Memory
```

Kalau sering OOM, biasanya karena:

- Postgres RAM-bound state (caching tables besar) → cek `MemoryHigh=` mungkin di-bump.
- Backup concurrent `pg_dump` aktif saat backend lagi encode banyak images → spread
  ke window cron setelah 03:00 UTC jika traffic peaks di morning.

---

## 7. Production Stack Summary

| Layer | Process / File | Owner |
|---|---|---|
| **Frontend (SPA)** | Vite build di `/var/www/mindleaf/dist/` (static assets served by Caddy) | `mindleaf:mindleaf` |
| **Reverse proxy + TLS** | Caddy systemd unit, Caddyfile `/etc/caddy/Caddyfile` (Let's Encrypt ACME) | `root:root` |
| **Backend** | Node 22 + Hono di `:8787`, systemd `mindleaf.service` | `mindleaf:mindleaf` |
| **Database** | PostgreSQL 16 apt-installed, db `mindleaf`, role `mindleaf` | Debian default |
| **Object storage** | Cloudflare R2 buckets `mindleaf-prod` (attachments) + `mindleaf-prod-backups` (db dumps) | Cloudflare account |
| **Backup** | Cron daily 03:00 → `pg_dump -Fc` → `rclone copyto` → R2 dengan retention sweep 30 hari | `mindleaf:mindleaf` |
| **Logs** | Pino JSON → journald → `journalctl -u mindleaf` | `journal` |
| **Observability** | Zero 3rd-party. journald only. | — |
| **Security headers** | Caddy site-level `header {}` block (CSP + HSTS + nosniff + XFO + etc) | `root:root` |

Mindleaf production = single-user, local-first IndexedDB cache + Postgres canonical
store + Cloudflare R2 attachments + Argon2id auth + AES-256-GCM encryption. 🎉

---

## Catatan

- Backup secrets di **password manager**, **BUKAN** di repo `.env.example`.
- DNS A-record **WAJIB** point ke origin VPS IP sebelum Caddy pertama kali start (kalau
  di-Cloudflare orange-cloud, matikan proxy atau pakai Full mode — lihat §0 caveat).
- Untuk deploy ulang setelah secret rotation, jalankan `bootstrap.sh` sekali (akan
  skip existing `.env`), lalu `scripts/deploy.sh` seperti biasa.
- File `deploy/scripts/bootstrap.sh` + `scripts/deploy.sh` + `deploy/Caddyfile` +
  `deploy/systemd/mindleaf.service` adalah authoritative sources — dok ini cuma
  walk-through, semua behavior definitive ada di file-file itu.

## 8. Alternative Deploy Paths (Future)

### 8.1 Container-based (Dockerfile ada tapi belum production-used)

`apps/server/Dockerfile` adalah multi-stage Node 22 bookworm-slim build yang
siap pakai kalau nanti ingin switch ke container runtime (Kubernetes, Nomad,
Fly.io, dll). Untuk V1 tetap pakai systemd-native (yang didokumentasikan di
§1–§7) karena:

- single-user app → container overhead tidak worth it
- systemd restart-on-failure + journald integration sudah cukup
- Postgres di-host (bukan container) → docker-compose di-host bisa lose access
  ke `/var/run/postgresql`

Migration ke Docker dilakukan kapan saja nanti:

1. `docker build -t mindleaf-server:latest apps/server/`
2. Run sebagai `docker run --env-file /opt/mindleaf/.env -p 127.0.0.1:8787:8787 mindleaf-server`
3. Disable systemd `mindleaf.service`, configure reverse-proxy + healthcheck
   pointing ke container port

Tidak ada perubahan kode aplikasi yang dibutuhkan — `dist/index.js` adalah
entry point yang sama.

### 8.2 Hosting alternatif (managed Postgres + Dokku / Railway / Render)

Untuk skip sysadmin overhead, Mindleaf app code bisa di-deploy ke PaaS yang
support Node 22 + persistent Postgres + object storage. Modifikasi yang
diperlukan:

- Pakai managed Postgres (Neon / Supabase / RDS) → update `DATABASE_URL`
- Pakai managed R2-compatible (B2 / DO Spaces) → update `R2_*` env vars
- Skip systemd + Caddy + rclone cron → PaaS handle semuanya

Tidak ada perubahan kode aplikasi.
