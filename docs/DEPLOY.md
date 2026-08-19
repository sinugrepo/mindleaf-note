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
 │  Cron: 07:00 WIB daily ──► pg_dump -Fc ──► rclone ──► R2 bucket   │
 └────────────────────────────────────────────────────────────────────┘
```

---

## 0. Pre-requisites

Sebelum menjalankan apapun, sediakan dahulu:

| # | Item | Catatan |
|---|---|---|
| 1 | **VPS** dengan Ubuntu 24.04 LTS, ≥ 1 vCPU / ≥ 1 GB RAM | Hetzner / DigitalOcean / Vultr, dll |
| 2 | **Domain** yang dibeli (Cloudflare Registrar / Namecheap / dll) | Target FQDN: `notes.sinug.my.id` |
| 3 | **DNS A-record** untuk domain → IP publik VPS | **Cloudflare orange-cloud proxy HARUS OFF** untuk first-time cert issue + renewal. Caddy pakai ACME HTTP-01 challenge — Cloudflare HTTP proxy bisa intermittent-fail forward challenge ke origin (mysterious cert-renewal errors di journal). Kalau tetap mau orange-cloud ON: pakai **DNS-only record untuk `_acme-challenge.mindleaf.example.com`** (allow Caddy resolve path langsung) **ATAU** pakai Cloudflare Full SSL mode + tunggu propagasi DNS untuk renewal. |
| 4 | **Cloudflare R2 bucket** (pisah: `mindleaf-prod` untuk attachments, `mindleaf-prod-backups` untuk db dumps) | Account ID + Access Key + Secret Key siap |
| 5 | **SSH key pair** untuk akses `mindleaf@<vps>` tanpa password | Opsional tapi recommended |
| 6 | **VPS baru** untuk migrasi: cukup Ubuntu 24.04, akses root/sudo, internet keluar, dan port 80/443 terbuka; `migrate-vps.sh` memasang repo, Node 22, npm, Caddy, PostgreSQL, dan rclone. Untuk deploy harian, edit checkout repo mana pun di VPS lalu jalankan `scripts/deploy.sh`; script menyalin release ke `/opt/mindleaf`. | Semua script berjalan lokal di VPS; tidak memakai SSH/remote deploy. |

> 🚨 **Untuk first-time**: butuh akses root ke VPS selama ~5 menit via SSH. Setelah
> `bootstrap.sh` selesai, login sebagai `root` tidak lagi diperlukan (cukup
> `mindleaf` user).
>
> ⚠️ **ALLOWED_ORIGIN coupling**: variabel `ALLOWED_ORIGIN` di `/opt/mindleaf/.env`
> HARUS **exact match** dengan domain yang di-serve Caddy (`scheme://host[:port]`,
> no trailing slash). Jika `.env` punya `https://notes.sinug.my.id` tapi Caddy
> serve `https://www.example.com` (atau `http://` vs `https://` mismatch),
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

## 1. (Fase A) One-command migration ke VPS baru

Untuk pindah ke VPS baru dengan data cloud tetap utuh, gunakan entrypoint berikut.
Website source tidak perlu diubah. Untuk menjaga agar write terakhir tidak hilang,
ikuti maintenance window dan backup final di `docs/MIGRASI-VPS.md`; jangan biarkan
VPS lama menerima write setelah snapshot final dibuat.

### 1.0 Input wajib dan command tunggal

Siapkan file secret production lama di VPS baru, misalnya `/root/mindleaf.env`.
File ini harus berisi nilai lama untuk `MASTER_ENCRYPTION_KEY`, `SESSION_SECRET`,
`DATABASE_URL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY`, `R2_SECRET_KEY`, dan
`ALLOWED_ORIGIN`. **Jangan generate `MASTER_ENCRYPTION_KEY` baru** jika ingin
membaca data terenkripsi lama.

Setelah repository tersedia atau `scripts/migrate-vps.sh` diunduh ke VPS baru,
jalankan satu command sebagai root:

```bash
sudo bash scripts/setup.sh --mode migrate --env-file /root/mindleaf.env
```

Command tersebut menjalankan otomatis: install prerequisite, clone repository
`main`, bootstrap user/PostgreSQL/Caddy/rclone, validasi R2, memilih dump database
terbaru dari `r2:mindleaf-prod-backups/db`, restore database, build/deploy lokal,
install service+cron, migration non-interaktif, restart, local healthcheck, dan
public HTTPS healthcheck.

Jika DNS belum diarahkan saat provisioning:

```bash
sudo bash scripts/setup.sh --mode migrate --env-file /root/mindleaf.env --skip-public-check
```

Untuk private repository, gunakan source checkout/tarball yang sudah tersedia:

```bash
sudo bash scripts/setup.sh --mode migrate \\
  --source-dir /root/mindleaf-note \\
  --env-file /root/mindleaf.env
```

**Catatan penting:** command ini memulihkan database PostgreSQL dari dump R2
terbaru. Ia tidak memindahkan blob gambar secara manual karena gambar sudah berada
di R2; metadata attachment ikut berada di dump database. Setelah DNS A-record
mengarah ke VPS baru, Caddy menerbitkan/menyegarkan TLS otomatis.

### 1.1 One-time VPS Provisioning

Untuk VPS baru, gunakan command tunggal di §1.0. Bagian berikut adalah fallback
manual/diagnostik saja; jangan jalankan `bootstrap.sh` terpisah jika wrapper
migration sudah dipakai karena wrapper sudah mengatur secret lama, restore R2,
build, service, dan healthcheck secara berurutan.

Jalan sekali setiap VPS baru. Idempotent — aman re-run kapan saja, tetapi jika
`/opt/mindleaf/.env` sudah ada maka `--env-file` yang diberikan harus identik;
script akan berhenti bila secret bundle berbeda.

### 1.1 Login sebagai root ke VPS baru (manual fallback)

Bagian ini hanya diperlukan jika one-command migration tidak dipakai.

```bash
ssh root@<vps-ip>
# Update + install ssh keys mindleaf
```

### 1.2 Siapkan checkout source untuk bootstrap (fallback manual)

Bagian ini hanya untuk provisioning VPS baru secara manual. Untuk workflow harian,
edit checkout yang sudah ada di VPS lalu jalankan `scripts/deploy.sh`; release akan
otomatis disalin ke `/opt/mindleaf`.

```bash
# Di laptop/local source, upload checkout ke lokasi kerja operator di VPS:
rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'apps/server/dist' \
  --exclude 'apps/web/dist' \
  ./ root@<vps-ip>:/home/<operator>/mindleaf-note/

# Di VPS:
cd /home/<operator>/mindleaf-note
```

`bootstrap.sh` membaca `apps/server/.env.production.example` dari checkout aktif
ini. Ia tidak lagi membutuhkan template atau full source sudah berada di `/opt`
terlebih dahulu. Jalankan bootstrap melalui `sudo` agar user operator (misalnya
`sinug`) mendapat sudoers deploy yang sesuai.

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
export ALLOWED_ORIGIN="https://notes.sinug.my.id"
```

### 1.5 Run `bootstrap.sh` (instalasi baru saja; bukan migrasi data existing)

```bash
sudo bash /opt/mindleaf/deploy/scripts/bootstrap.sh
```

> Jalur ini hanya untuk instalasi baru yang memang boleh membuat
> `MASTER_ENCRYPTION_KEY` dan secret database baru. Jangan gunakan alur ini untuk
> memulihkan data existing dari R2. Untuk pindah VPS dengan data lama, selalu
> gunakan `scripts/migrate-vps.sh` di §1.0 dan pertahankan `.env` production lama.

Apa yang terjadi:

| Step | Apa yang dilakukan |
|---|---|
| 1 | `apt-get install postgresql-16 caddy rclone ca-certificates curl gnupg` |
| 2 | Buat user `mindleaf` (no password login, group `www-data` + `ssl-cert`) |
| 3 | `mkdir /opt/mindleaf`, owner `mindleaf:mindleaf` |
| 4 | **Instalasi baru saja:** generate `/opt/mindleaf/.env` (mode `0600`, owner `mindleaf`) dari template dengan `SESSION_SECRET`, `MASTER_ENCRYPTION_KEY`, dan password database baru |
| 5 | Provision Postgres: create role + db `mindleaf`, write `/opt/mindleaf/.pgpass` (mode `0600`) untuk cron access passwordless |
| 6 | Write `/opt/mindleaf/.config/rclone/rclone.conf` dari `$RCLONE_CONF_B64` (mode `0600`) |
| 7 | `npm run db:push --workspace=@mindleaf/server -- --force` — apply Drizzle schema secara non-interaktif |

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

Sekarang VPS punya semua paket + secrets. Untuk deploy, jalankan `scripts/deploy.sh`
dari checkout repo yang sedang Anda edit di VPS (contoh `/home/sinug/mindleaf-note`).
Script ini membangun checkout tersebut, lalu menyalin release secara lokal ke
`/opt/mindleaf` sebagai runtime canonical, men-stage frontend ke
`/var/www/mindleaf/dist`, memasang systemd/Caddy/cron, migration, restart, dan
healthcheck. Tidak ada SSH atau rsync remote. `.env`, `.pgpass`, dan `.config/`
production di `/opt/mindleaf` dipertahankan dan tidak diambil dari checkout edit.
Gunakan `--pull` hanya jika ingin checkout aktif mengambil release dari git remote.

### 2.1 Test `--dry-run` dulu

```bash
# Di VPS, dari checkout yang sedang diedit:
cd /home/sinug/mindleaf-note
scripts/deploy.sh --dry-run
```

Output dry-run **akan list semua command** yang akan dijalankan tanpa benar-benar
jalan. Periksa:

- Apakah ada typo di host / path
- Apakah build langkahnya masuk akal
- Apakah tidak ada step yang mengagetkan

### 2.2 Run deploy untuk pertama kali

```bash
# Di VPS, dari checkout yang sedang diedit:
cd /home/sinug/mindleaf-note
scripts/deploy.sh
```

Step internal (untuk referensi audit saja — anda tidak perlu interaksi):
nomor step berikut = numbering yang dipakai oleh `scripts/deploy.sh`.

| Step | Apa yang dilakukan |
|---|---|
| 1 | Verifikasi checkout lokal, target `/opt/mindleaf`, Node/npm, rsync, dan sudo |
| 2 | Default memakai working tree yang sudah ada; `--pull` opsional untuk `git fetch` + `git pull --ff-only` |
| 3 | Conditional `npm ci --include=dev` di checkout edit berdasarkan hash manifest workspace |
| 4 | Typecheck + clean backend build di checkout edit (`apps/server/dist`) |
| 5 | Typecheck + frontend build (`apps/web/dist`) |
| 6 | Staging atomik frontend ke `/var/www/mindleaf/dist/` dengan backup lokal |
| 7 | Snapshot + aktivasi release ke `/opt/mindleaf`, lalu install/validasi systemd, Caddy, dan cron |
| 8 | `npm run db:push` (kecuali `--no-migrate`) — stateful; backup database tetap disarankan |
| 9 | Restart `mindleaf`, healthcheck `localhost:8787`, dan rollback otomatis jika gagal |

Sukses = output akhir `deployment complete on this VPS` dan healthcheck lokal berhasil.

### 2.3 Browser-side verification

```bash
# 1. Caddy sudah serve HTTPS?
curl -fsS -I https://notes.sinug.my.id | head -3
# expect: HTTP/2 200, Strict-Transport-Security header ada

# 2. Backend health reachable via Caddy
curl -fsS https://notes.sinug.my.id/healthz
# expect: {"ok":true}

# 3. Buka di browser:
https://notes.sinug.my.id
# expect: SPA login page muncul
```

### 2.4 First-time account: master password

> Account creation is server-side by design. The browser only performs login.

1. Fresh setup runs `npm run seed --workspace=@mindleaf/server` on the VPS.
2. The administrator enters the master password in the server terminal.
3. Open the SPA and log in with that password.
4. The backend sets an HttpOnly cookie (SameSite=Strict, 30-day rolling expiry).
5. IndexedDB remains available locally even when the backend is temporarily offline.

---

## 3. Ongoing Operations

Setelah first deploy sukses, ada beberapa operation flow untuk minggu/bulan berikutnya.

### 3.1 Deploy perubahan baru (tiap release)

```bash
# Jalankan dari checkout yang sedang diedit setelah perubahan siap
echo "checkout aktif: /home/sinug/mindleaf-note"
cd /home/sinug/mindleaf-note
scripts/deploy.sh
```

Build pertama sekitar 2–3 menit (termasuk `npm ci`); deploy berikutnya biasanya jauh lebih cepat karena install dilewati bila manifest tidak berubah. Backend downtime ~5–10 detik selama restart (roll-window). Tidak zero-downtime — itu acceptable karena single-user app; user tinggal refresh browser kalau barusan logout.

### 3.2 Wrapper restart manual dengan logging

Untuk perubahan aplikasi biasa yang tidak menyentuh schema database, gunakan
wrapper ini:

```bash
cd /home/sinug/mindleaf-note
sudo bash scripts/restart.sh
```

Wrapper menjalankan `scripts/deploy.sh --no-migrate`, menampilkan seluruh output
di terminal, dan menyimpan log bertimestamp di `/var/log/mindleaf/restart-*.log`.
Jika direktori tersebut tidak dapat ditulis, log fallback disimpan di
`.restart-logs/` pada checkout. Override lokasi log dengan:

```bash
sudo MINDLEAF_RESTART_LOG_DIR=/var/log/mindleaf bash scripts/restart.sh
```

### 3.3 Skip DB migration (kalau yakini schema tidak berubah)

Perintah langsung yang dipanggil wrapper:

```bash
cd /home/sinug/mindleaf-note
scripts/deploy.sh --no-migrate
```

Hemat ~30 detik dan menghindari false-positive error kalau db:push menolak perubahan
trivial (e.g. existing table).

### 3.4 Rollback ke versi sebelumnya

```bash
# Restore release runtime paling baru:
cd /home/sinug/mindleaf-note
scripts/deploy.sh --rollback
```

Snapshot mekanisme:
- Setiap deploy sukses sebelumnya menyimpan snapshot penuh: `/opt/mindleaf.bak.<timestamp>`
- Yang paling baru dipakai oleh `--rollback` (script dapat dijalankan dari checkout aktif mana pun)
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
sudo -u mindleaf /opt/mindleaf/deploy/scripts/backup.sh
# expect: "acquired lock" → "pg_dump ok (size=...)" → "rclone ok" → "retention sweep ok"
# Telegram is alert-only; it sends a message only if a backup/retention anomaly occurs.

# 3. List backup di R2:
sudo -u mindleaf RCLONE_CONFIG=/opt/mindleaf/.config/rclone/rclone.conf \
  rclone lsjson r2:mindleaf-prod-backups/db/

# 4. Inspect specific dump:
sudo -u mindleaf RCLONE_CONFIG=/opt/mindleaf/.config/rclone/rclone.conf \
  rclone lsjson r2:mindleaf-prod-backups/db/<date>-mindleaf-<timestamp>.dump
```

Cadence: **07:00 WIB (`Asia/Jakarta`)** daily (`/etc/cron.d/mindleaf-backup`). Retention: 30 hari. R2 remains the primary backup; Telegram is alert-only and requires `TELEGRAM_BOT_TOKEN` plus `TELEGRAM_CHAT_ID` in `/opt/mindleaf/.env`.

### 3.7 Konfigurasi Telegram alert

Buat bot privat melalui `@BotFather`, kirim `/start` dari chat tujuan, lalu
simpan credential hanya di `/opt/mindleaf/.env` dengan permission `0600`:

```env
TELEGRAM_BOT_TOKEN=<token dari BotFather>
TELEGRAM_CHAT_ID=<id chat privat>
```

Backup tidak mengirim dump database ke Telegram. Saat `pg_dump`, upload/verifikasi
R2, atau retention mengalami anomali, script mengirim alert singkat melalui
Telegram Bot API. Pengiriman memiliki retry dan timeout; kegagalan Telegram
sendiri tetap dicatat ke journald dan `/var/log/mindleaf-backup.log`.

Setelah env diisi, verifikasi konfigurasi tanpa mencetak token:

```bash
sudo stat -c '%a %U:%G %n' /opt/mindleaf/.env
# expect: 600 mindleaf:mindleaf /opt/mindleaf/.env
sudo -u mindleaf /opt/mindleaf/deploy/scripts/backup.sh
```

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
https://notes.sinug.my.id → login → notes kembali
```

### 4.2 VPS rebuild total

Jika VPS rusak total, disk corruption, atau pindah provider, gunakan runbook
resmi `docs/MIGRASI-VPS.md`. Jangan memakai alur manual lama di bagian ini untuk
migrasi data existing karena dapat melewatkan restore R2 atau membuat secret baru.

```bash
# Di VPS baru, setelah repository dan .env production lama tersedia:
cd /root/mindleaf-note
sudo bash scripts/setup.sh --mode migrate --env-file /root/mindleaf.env
```

Runbook tersebut mengatur urutan clone/source → bootstrap → validasi R2 → restore
dump final → build/deploy → service → healthcheck. Pertahankan
`MASTER_ENCRYPTION_KEY` lama dan gunakan maintenance window agar write baru tidak
hilang setelah snapshot backup dibuat.

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
| `/var/www/mindleaf/dist/` | `mindleaf:mindleaf` | `755` | Frontend Vite output (staged locally) |
| `/etc/caddy/Caddyfile` | `root:root` | `644` | Caddy reverse-proxy + SPA fallback |
| `/etc/systemd/system/mindleaf.service` | `root:root` | `644` | Hardened systemd unit |
| `/etc/cron.d/mindleaf-backup` | `root:root` | `644` | Daily 07:00 WIB backup trigger + Telegram anomaly alerts |
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
- **`permission denied (systemctl)`** → jalankan ulang `bootstrap.sh`; script itu memasang sudoers rule terbatas untuk `mindleaf` (systemctl, caddy, install, file staging, dan validasi), tanpa akses shell/SSH/rsync.
- **`node --version` fails** → bootstrap belum install; re-run §1.5.

### 6.2 `caddy validate` rejects Caddyfile

```bash
# Edit di VPS:
sudo nano /etc/caddy/Caddyfile
# Caddyfile production menggunakan `notes.sinug.my.id`; ubah source Caddyfile jika domain diganti.
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### 6.3 Hanya `/healthz` reachable, SPA belum

Cek Caddyfile `@hashed_assets` + SPA fallback handle. Biasanya karena:

- `/var/www/mindleaf/dist/index.html` belum ada → deploy lokal belum selesai.
  Cek via `ls -la /var/www/mindleaf/dist/`.
- Permission `index.html` readable — `sudo chmod -R a+rX /var/www/mindleaf/dist`.

### 6.4 Browser login gagal (401)

```bash
# Cek cookie ada:
curl -sI https://notes.sinug.my.id/healthz  | grep -i set-cookie

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
sudo -u mindleaf /opt/mindleaf/deploy/scripts/backup.sh

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
# Re-export base64 + re-run bootstrap.sh hanya untuk memperbarui rclone.conf;
# untuk migrasi/recovery data existing, gunakan docs/MIGRASI-VPS.md dan jangan
# regenerate MASTER_ENCRYPTION_KEY.
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
  ke window cron setelah 07:00 WIB jika traffic peaks di morning.

---

## 7. Production Stack Summary

| Layer | Process / File | Owner |
|---|---|---|
| **Frontend (SPA)** | Vite build di `/var/www/mindleaf/dist/` (static assets served by Caddy) | `mindleaf:mindleaf` |
| **Reverse proxy + TLS** | Caddy systemd unit, Caddyfile `/etc/caddy/Caddyfile` (Let's Encrypt ACME) | `root:root` |
| **Backend** | Node 22 + Hono di `:8787`, systemd `mindleaf.service` | `mindleaf:mindleaf` |
| **Database** | PostgreSQL 16 apt-installed, db `mindleaf`, role `mindleaf` | Debian default |
| **Object storage** | Cloudflare R2 buckets `mindleaf-prod` (attachments) + `mindleaf-prod-backups` (db dumps) | Cloudflare account |
| **Backup** | Cron daily 07:00 WIB (`Asia/Jakarta`) → `pg_dump -Fc` → `rclone copyto` → R2 dengan retention sweep 30 hari; Telegram hanya untuk alert anomali | `mindleaf:mindleaf` |
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
- Untuk deploy ulang setelah secret rotation, lakukan prosedur rotasi secara
  terencana. Jangan mengganti `MASTER_ENCRYPTION_KEY` jika database existing belum
  di-re-encrypt. Setelah `.env` valid, jalankan `scripts/deploy.sh` seperti biasa.
- Untuk rebuild/migrasi VPS dengan data existing, gunakan `docs/MIGRASI-VPS.md`,
  bukan flow generate secret pada `bootstrap.sh`.
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
