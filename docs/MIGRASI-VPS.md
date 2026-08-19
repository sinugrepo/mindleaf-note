# Migrasi Mindleaf ke VPS Baru

Panduan ini adalah runbook resmi untuk memindahkan Mindleaf ke VPS baru tanpa
mengubah source website dan tanpa memindahkan file gambar secara manual. Untuk
prosedur migrasi VPS, dokumen ini menjadi runbook utama; `docs/DEPLOY.md` tetap
menjadi referensi deploy harian dan operasi umum.

Arsitektur production Mindleaf:

- **Frontend**: build Vite dilayani Caddy.
- **Backend**: Node.js/Hono pada systemd service `mindleaf`.
- **Database**: PostgreSQL 16 di VPS.
- **Gambar**: Cloudflare R2 bucket aplikasi.
- **Backup database**: `pg_dump` → Cloudflare R2 bucket backup.

Gunakan panduan ini jika VPS lama akan diganti karena pindah provider, rebuild,
atau recovery dari VPS yang rusak.

> **Prinsip penting:** database dapat dipulihkan dari backup R2, tetapi data
> terenkripsi hanya dapat dibaca jika `MASTER_ENCRYPTION_KEY` lama ikut dibawa.
> Jangan membuat key baru untuk migrasi data lama.

---

## 1. Hasil akhir yang diharapkan

Setelah prosedur selesai, VPS baru akan memiliki:

- repository Mindleaf di `/opt/mindleaf`;
- user system `mindleaf` tanpa login password;
- Node.js 22, PostgreSQL 16, Caddy, rclone, cron, dan dependency sistem;
- database `mindleaf` yang dipulihkan dari dump R2;
- konfigurasi R2 untuk attachment dan backup;
- backend aktif pada `127.0.0.1:8787`;
- frontend aktif melalui Caddy;
- HTTPS otomatis dari Caddy;
- backup harian pukul 07:00 WIB (Asia/Jakarta);
- service `mindleaf`, `caddy`, PostgreSQL, dan cron aktif saat reboot.

Script migrasi menjalankan semua tahap tersebut secara lokal di VPS target. Script
**tidak menggunakan SSH ke VPS lain** dan tidak melakukan remote deploy.

---

## 2. Yang harus disiapkan sebelum migrasi

### 2.1 VPS baru

Gunakan VPS baru dengan:

- Ubuntu 24.04 LTS;
- minimal 1 vCPU dan 1 GB RAM;
- akses root atau user dengan `sudo`;
- koneksi internet keluar untuk apt, GitHub, npm, dan Cloudflare R2;
- port TCP `80` dan `443` terbuka dari internet;
- port PostgreSQL `5432` **tidak** perlu dibuka ke internet.

Untuk HTTPS, DNS domain harus dapat diarahkan ke IP VPS baru.

### 2.2 Domain dan Cloudflare DNS

Siapkan IP publik VPS baru, lalu ubah DNS:

```text
notes.sinug.my.id  A  <IP-VPS-BARU>
```

Untuk penerbitan sertifikat pertama, gunakan mode **DNS only** terlebih dahulu
(awan Cloudflare abu-abu). Setelah HTTPS berhasil dan terverifikasi, proxy
Cloudflare dapat diaktifkan kembali jika diperlukan.

Nilai `ALLOWED_ORIGIN` harus sama persis dengan domain aplikasi:

```env
ALLOWED_ORIGIN=https://notes.sinug.my.id
```

Jangan memakai trailing slash atau mengganti `https` menjadi `http`.

Source `deploy/Caddyfile` saat ini juga menggunakan `notes.sinug.my.id`. Jika
pindah sekaligus ke domain berbeda, ubah domain tersebut di `deploy/Caddyfile`
sebelum menjalankan migrasi dan sesuaikan `ALLOWED_ORIGIN` dengan nilai yang
sama. Untuk pindah VPS dengan domain yang sama, tidak ada perubahan Caddyfile
yang diperlukan. Jika domain berbeda, jangan hanya mengedit file setelah clone
sementara lalu menjalankan command standar: proses sinkronisasi source dapat
menimpa edit tersebut. Gunakan checkout yang sudah berisi perubahan dengan
`--source-dir`, atau commit/tag perubahan Caddyfile terlebih dahulu dan jalankan
migrasi dengan `--ref` yang sesuai.

### 2.3 Secret production lama

Siapkan file secret, misalnya `/root/mindleaf.env`, dari VPS lama atau password
manager. File ini harus memuat nilai production lama, minimal:

```env
DATABASE_URL=postgresql://mindleaf:<password>@localhost:5432/mindleaf
MASTER_ENCRYPTION_KEY=<key-lama>
SESSION_SECRET=<session-secret-lama>
R2_ACCOUNT_ID=<cloudflare-account-id>
R2_ACCESS_KEY=<r2-access-key>
R2_SECRET_KEY=<r2-secret-key>
ALLOWED_ORIGIN=https://notes.sinug.my.id
```

Catatan:

- Pertahankan `MASTER_ENCRYPTION_KEY` lama.
- Pertahankan `SESSION_SECRET` lama agar session lama tetap konsisten sampai
  migrasi selesai.
- Jangan commit file ini ke Git.
- Jangan menempelkan isi file `.env` ke chat, issue tracker, atau log.
- Permission file harus `600`.

Siapkan file di VPS baru:

```bash
chmod 600 /root/mindleaf.env
ls -l /root/mindleaf.env
```

Output permission yang diharapkan adalah `-rw-------`.

### 2.4 Akses R2

Pastikan credential R2 dapat mengakses dua kebutuhan berikut:

1. bucket attachment aplikasi;
2. bucket backup database, default:

```text
r2:mindleaf-prod-backups/db
```

Di bucket backup harus tersedia setidaknya satu file dengan akhiran `.dump`.
Alur one-click menggunakan remote standar `r2:mindleaf-prod-backups/db` dan akan
memilih file `.dump` terbaru secara leksikografis jika `--backup-object` tidak
diberikan. Jika backup harian memakai remote custom, verifikasi dan sesuaikan
script migrasi terlebih dahulu; jangan menganggap override backup harian otomatis
mengubah lokasi yang dipakai migrasi.

Jika sudah memiliki `rclone.conf`, simpan di VPS baru dengan permission `600`.
Script juga dapat membuat konfigurasi rclone dari nilai `R2_*` dalam `.env`.

---

## 3. Backup dan pemeriksaan sebelum mematikan VPS lama

Jangan langsung mematikan VPS lama, tetapi jangan pula membiarkannya menerima
write selama proses cutover. Migrasi mengambil snapshot database dari R2; write
baru setelah snapshot dibuat tidak ikut masuk ke VPS baru.

Pilih maintenance window dan ikuti urutan aman berikut:

1. Beri tahu pengguna atau hentikan akses write sementara.
2. Hentikan backend VPS lama agar tidak ada perubahan database baru:

   ```bash
   sudo systemctl stop mindleaf
   ```

3. Jalankan backup final dari VPS lama.
4. Catat nama dump final dan gunakan `--backup-object` saat migrasi.
5. Jalankan migrasi di VPS baru.
6. Buka kembali akses setelah verifikasi VPS baru berhasil.

Jika aplikasi harus tetap online selama persiapan, lakukan backup persiapan
terlebih dahulu, tetapi tetap ulangi backup final setelah backend lama dihentikan
sebelum DNS dipindahkan.

### 3.1 Jalankan backup manual di VPS lama

Jalankan perintah ini setelah `mindleaf` lama dihentikan sesuai urutan cutover di
atas:

```bash
sudo -u mindleaf /opt/mindleaf/deploy/scripts/backup.sh
```

Output normal berisi tahap seperti:

```text
acquired lock
pg_dump ok
rclone ok
backup run complete
```

Jika backup gagal, jangan lanjutkan migrasi sebelum penyebabnya diperbaiki.

### 3.2 Verifikasi object backup di R2

Catatan: nama file hasil backup adalah nama object yang harus dipakai untuk
restore. Selalu pilih dump final setelah maintenance window dimulai, bukan dump
persiapan yang dibuat ketika aplikasi masih menerima write.

```bash
sudo -u mindleaf \
  RCLONE_CONFIG=/opt/mindleaf/.config/rclone/rclone.conf \
  rclone lsf --files-only r2:mindleaf-prod-backups/db/
```

Catat nama file dump terakhir. Contoh:

```text
2026-08-01-mindleaf-20260801T030000Z.dump
```

Jika ingin migrasi memakai file tertentu, gunakan nama tersebut dengan opsi
`--backup-object` pada langkah migrasi.

### 3.3 Simpan secret secara terpisah

Pastikan dua hal berikut tersedia di luar VPS lama:

- salinan `.env` production lama;
- salinan atau akses ke R2 credential.

Backup database tanpa `MASTER_ENCRYPTION_KEY` tidak cukup untuk membaca isi note
yang terenkripsi.

---

## 4. Ambil script migrasi di VPS baru

Login ke VPS baru sebagai root atau user sudo:

```bash
ssh root@<IP-VPS-BARU>
```

Ambil repository dan masuk ke foldernya:

```bash
git clone --depth 1 --branch main \
  https://github.com/sinugrepo/mindleaf-note.git \
  /root/mindleaf-note
cd /root/mindleaf-note
```

Jika repository private, jangan menaruh token di URL Git. Gunakan salah satu cara
berikut:

- clone menggunakan credential helper yang sudah disiapkan;
- gunakan checkout/tarball lokal dan opsi `--source-dir`;
- gunakan deploy key yang hanya memiliki akses read ke repository.

Pastikan script tersedia:

```bash
test -x scripts/migrate-vps.sh || chmod 755 scripts/migrate-vps.sh
scripts/migrate-vps.sh --help
```

---

## 5. Jalankan migrasi satu command

### 5.1 Migrasi standar dengan dump R2 terbaru

Dari folder repository di VPS baru:

```bash
sudo bash scripts/migrate-vps.sh \
  --env-file /root/mindleaf.env
```

Script akan menjalankan urutan berikut:

1. validasi `.env` dan secret wajib;
2. install package host;
3. clone atau gunakan source repository;
4. sinkronisasi source ke `/opt/mindleaf`;
5. mempertahankan `.env`, `.pgpass`, rclone config, dependency, dan backup;
6. menjalankan bootstrap OS/PostgreSQL/Caddy/rclone;
7. menguji koneksi PostgreSQL dan R2;
8. memilih serta mengunduh dump database dari R2;
9. menghentikan backend jika perlu dan melakukan `pg_restore`;
10. build backend dan frontend;
11. memasang systemd, Caddy, dan cron;
12. menjalankan schema push non-interaktif;
13. mengaktifkan dan me-restart service;
14. menjalankan healthcheck lokal dan HTTPS publik.

Output progress ditampilkan ke terminal dan disimpan di:

```text
/var/log/mindleaf-migrate-<timestamp>.log
```

### 5.2 Memakai dump tertentu

Jika ingin memastikan file backup yang dipakai:

```bash
sudo bash scripts/migrate-vps.sh \
  --env-file /root/mindleaf.env \
  --backup-object 2026-08-01-mindleaf-20260801T030000Z.dump
```

Nama harus relatif terhadap remote:

```text
r2:mindleaf-prod-backups/db/<nama-file.dump>
```

### 5.3 Instalasi kosong tanpa restore (bukan migrasi data)

Opsi `--no-restore` hanya boleh digunakan untuk instalasi baru yang memang tidak
memiliki data lama:

```bash
sudo bash scripts/migrate-vps.sh \
  --env-file /root/mindleaf.env \
  --no-restore
```

Jangan gunakan `--no-restore` ketika mengganti VPS existing. Opsi tersebut akan
meninggalkan database kosong dan tidak memulihkan notes, user, session, atau
metadata attachment dari R2.

### 5.4 DNS belum siap

Jika DNS belum diarahkan atau sertifikat belum dapat diterbitkan, jalankan:

```bash
sudo bash scripts/migrate-vps.sh \
  --env-file /root/mindleaf.env \
  --skip-public-check
```

Dengan opsi ini, script tetap wajib melewati healthcheck lokal. Hanya pengecekan
HTTPS publik yang dilewati. Setelah DNS mengarah ke VPS baru, verifikasi manual:

```bash
curl -fsS https://notes.sinug.my.id/healthz
```

Output yang diharapkan:

```json
{"ok":true}
```

### 5.5 Repository private atau source sudah tersedia

Jika source sudah ada di VPS baru:

```bash
sudo bash scripts/migrate-vps.sh \
  --source-dir /root/mindleaf-note \
  --env-file /root/mindleaf.env
```

### 5.6 Timeout dan proses yang stuck

Default timeout tiap fase adalah 1200 detik. Untuk VPS lambat, naikkan seperlunya:

```bash
sudo bash scripts/migrate-vps.sh \
  --env-file /root/mindleaf.env \
  --timeout 1800
```

Jika fase tidak selesai dalam timeout, script mengirim `TERM`, menunggu 30 detik,
lalu mematikan proses anak. Jangan menjalankan migrasi kedua secara bersamaan.
Lock migrasi berada di:

```text
/var/lock/mindleaf-migrate.lock
```

---

## 6. Verifikasi setelah migrasi

Jalankan seluruh checklist berikut di VPS baru.

### 6.1 Service

```bash
systemctl is-enabled mindleaf
systemctl is-enabled caddy
systemctl is-enabled postgresql
systemctl is-enabled cron

systemctl --no-pager --full status mindleaf caddy postgresql cron
```

Semua service utama harus berstatus aktif/enabled.

### 6.2 Backend lokal

```bash
curl --fail --silent --show-error http://localhost:8787/healthz
printf '\n'
```

Expected:

```json
{"ok":true}
```

### 6.3 HTTPS publik

```bash
curl --fail --silent --show-error https://notes.sinug.my.id/healthz
printf '\n'
curl --fail --silent --head https://notes.sinug.my.id/
```

Pastikan website dapat dibuka dari browser.

### 6.4 Frontend

```bash
test -f /var/www/mindleaf/dist/index.html
ls -lah /var/www/mindleaf/dist/
```

### 6.5 Secret dan permission

Jangan mencetak isi file. Hanya periksa metadata:

```bash
stat -c '%A %U:%G %n' \
  /opt/mindleaf/.env \
  /opt/mindleaf/.pgpass \
  /opt/mindleaf/.config/rclone/rclone.conf
```

Expected mode untuk ketiga file adalah `-rw-------` (`600`).

### 6.6 Database

```bash
sudo -u postgres psql -tAc \
  "SELECT datname FROM pg_database WHERE datname='mindleaf';"

sudo -u postgres psql -d mindleaf -tAc \
  "SELECT count(*) FROM notes;"
```

Jangan menganggap `count(*) = 0` sebagai sukses untuk migrasi data lama. Jika
jumlah note nol padahal VPS lama memiliki note, hentikan verifikasi aplikasi dan
periksa dump/restore sebelum login atau menulis data baru.

### 6.7 R2 dan backup cron

```bash
sudo -u mindleaf \
  RCLONE_CONFIG=/opt/mindleaf/.config/rclone/rclone.conf \
  rclone lsf --files-only r2:mindleaf-prod-backups/db/

sudo -u mindleaf /opt/mindleaf/deploy/scripts/backup.sh
```

Backup manual harus berhasil sebelum VPS lama dimatikan permanen.

### 6.8 Verifikasi aplikasi

Di browser:

1. buka `https://notes.sinug.my.id`;
2. login dengan akun yang sudah ada;
3. pastikan daftar note muncul;
4. buka note yang memiliki gambar;
5. pastikan gambar tampil dari R2;
6. buat atau ubah satu note uji;
7. refresh browser dan pastikan perubahan tersimpan;
8. periksa log backend jika ada error.

```bash
journalctl -u mindleaf -n 100 --no-pager
```

---

## 7. Pengalihan traffic dan shutdown VPS lama

Urutan aman:

1. Hentikan write dan buat backup final di VPS lama (§3).
2. Jalankan migrasi di VPS baru menggunakan dump final tersebut.
3. Verifikasi database, note, attachment, login, dan sync di VPS baru.
4. Pastikan DNS `notes.sinug.my.id` mengarah ke IP VPS baru.
5. Tunggu propagasi DNS.
6. Jalankan healthcheck HTTPS dari jaringan luar.
7. Buka kembali akses aplikasi hanya melalui VPS baru.
8. Biarkan VPS lama tetap mati selama masa observasi agar tidak ada dua instance
   yang menerima write.
9. Jangan langsung menghapus disk VPS lama. Simpan selama periode retensi
   internal yang disepakati.

Jika sebelumnya VPS lama masih hidup untuk persiapan, pastikan service-nya tetap
berhenti sebelum DNS dipindahkan:

```bash
sudo systemctl stop mindleaf
sudo systemctl stop caddy
```

> Jika dua VPS aktif bersamaan, hindari menulis data dari keduanya. Gunakan VPS
> baru sebagai satu-satunya instance aktif setelah DNS dipindahkan.

---

## 8. Jika migrasi gagal

Jika `pg_restore` gagal, anggap database target belum valid. Jangan menyalakan
traffic atau melakukan login/write ke VPS baru sampai restore berhasil. Restore
custom PostgreSQL dapat meninggalkan objek/data parsial walaupun command berhenti
dengan error.

Recovery aman:

1. hentikan backend: `sudo systemctl stop mindleaf`;
2. pastikan dump final yang benar sudah dipilih;
3. jalankan ulang migrasi dari VPS baru, atau ulangi restore dengan dump final;
4. jalankan healthcheck dan verifikasi jumlah note sebelum cutover.

### 8.1 Lihat log migrasi

```bash
ls -lt /var/log/mindleaf-migrate-*.log | head
sudo tail -n 100 /var/log/mindleaf-migrate-<timestamp>.log
```

Jangan membagikan log yang berisi secret. Script dirancang tidak mencetak isi
`.env`, tetapi tetap periksa sebelum mengirim log ke pihak lain.

### 8.2 Gagal karena `.env` berbeda

Pesan:

```text
/opt/mindleaf/.env already exists and differs from --env-file
```

Ini adalah pengaman. Periksa apakah kedua file memang secret bundle yang sama.
Jangan menimpa `.env` secara membabi buta. Jika VPS baru belum berisi data valid,
backup file target lalu gunakan file production lama yang benar:

```bash
sudo cp -a /opt/mindleaf/.env /root/mindleaf.env.target-backup
sudo install -m 600 /root/mindleaf.env /opt/mindleaf/.env
```

Kemudian jalankan ulang migrasi.

### 8.3 R2 tidak dapat diakses

```bash
sudo -u mindleaf \
  RCLONE_CONFIG=/opt/mindleaf/.config/rclone/rclone.conf \
  rclone lsd r2:
```

Periksa:

- `R2_ACCOUNT_ID` benar;
- access key belum dicabut/expired;
- endpoint dan bucket benar;
- VPS dapat mengakses internet;
- policy R2 mengizinkan list/read object backup.

Jika memakai konfigurasi khusus:

```bash
sudo bash scripts/migrate-vps.sh \
  --env-file /root/mindleaf.env \
  --rclone-conf /root/rclone.conf
```

### 8.4 Tidak ada file `.dump`

Periksa remote backup:

```bash
sudo -u mindleaf \
  RCLONE_CONFIG=/opt/mindleaf/.config/rclone/rclone.conf \
  rclone lsf --files-only r2:mindleaf-prod-backups/db/
```

Jika bucket kosong, jangan gunakan `--no-restore` untuk migrasi data lama. Itu
akan membuat database kosong dan bukan memulihkan instance lama.

### 8.5 Caddy atau HTTPS gagal

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl status caddy --no-pager
journalctl -u caddy -n 100 --no-pager
```

Periksa:

- DNS A-record mengarah ke IP VPS baru;
- port 80/443 terbuka;
- domain pada Caddyfile benar;
- Cloudflare tidak menghalangi challenge ACME;
- `ALLOWED_ORIGIN` memakai domain dan scheme yang tepat.

### 8.6 Backend gagal start

```bash
systemctl status mindleaf --no-pager
journalctl -u mindleaf -n 100 --no-pager
```

Periksa metadata dan keberadaan artifact:

```bash
stat /opt/mindleaf/.env
stat /opt/mindleaf/apps/server/dist/index.js
```

Jika build gagal karena RAM, gunakan VPS dengan RAM lebih besar atau ulangi setelah
membersihkan proses lain. Jangan menghapus `.env`, `.pgpass`, atau rclone config.

### 8.7 Backup gagal autentikasi PostgreSQL

```bash
stat -c '%A %U:%G %n' /opt/mindleaf/.pgpass
sudo chmod 600 /opt/mindleaf/.pgpass
sudo chown mindleaf:mindleaf /opt/mindleaf/.pgpass
sudo -u mindleaf /opt/mindleaf/deploy/scripts/backup.sh
```

Script backup menggunakan `PGPASSFILE=/opt/mindleaf/.pgpass` secara eksplisit.

### 8.8 Migrasi terhenti karena timeout

Jangan langsung menjalankan proses kedua. Periksa proses yang tersisa:

```bash
ps aux | grep -E 'migrate-vps|bootstrap|deploy|npm|drizzle|pg_restore' | grep -v grep
```

Periksa log terakhir:

```bash
sudo tail -n 100 /var/log/mindleaf-migrate-*.log
```

Jika tidak ada proses migrasi yang aktif, jalankan ulang dengan timeout lebih besar:

```bash
sudo bash scripts/migrate-vps.sh \
  --env-file /root/mindleaf.env \
  --timeout 1800
```

---

## 9. Rollback dan recovery

### 9.1 Rollback build aplikasi

Jika deployment selesai tetapi backend/frontend release baru bermasalah, jalankan
rollback dari checkout yang sedang Anda edit. Script akan mencari snapshot runtime
terbaru di `/opt/mindleaf.bak.*`:

```bash
cd /home/sinug/mindleaf-note
./scripts/deploy.sh --rollback
```

Rollback ini mengembalikan release runtime dan konfigurasi service. Rollback ini
**tidak membatalkan perubahan database** yang sudah diterapkan oleh Drizzle.

### 9.2 Restore dump database tertentu

Untuk restore manual, hentikan backend terlebih dahulu. Gunakan script migrasi jika
ingin mengulang seluruh provisioning. Untuk restore database existing, ikuti
prosedur disaster recovery di `docs/DEPLOY.md` dan pastikan file dump sudah
terverifikasi.

Restore database dapat menghapus data yang dibuat setelah waktu dump. Selalu catat
waktu backup yang dipilih sebelum menjalankan `pg_restore`.

### 9.3 Jika VPS lama masih sehat

Jangan hapus VPS lama sampai:

- login pada VPS baru berhasil;
- note dan attachment tampil;
- satu perubahan note berhasil sync;
- backup manual dari VPS baru berhasil;
- HTTPS dan DNS stabil;
- tidak ada error kritis pada journal selama masa observasi.

---

## 10. Command ringkas

### Migrasi normal

```bash
cd /root/mindleaf-note
sudo chmod 600 /root/mindleaf.env
sudo bash scripts/migrate-vps.sh --env-file /root/mindleaf.env
```

### Migrasi dengan dump tertentu

```bash
sudo bash scripts/migrate-vps.sh \
  --env-file /root/mindleaf.env \
  --backup-object <nama-file.dump>
```

### DNS belum siap

```bash
sudo bash scripts/migrate-vps.sh \
  --env-file /root/mindleaf.env \
  --skip-public-check
```

### Migrasi ulang setelah timeout

```bash
sudo bash scripts/migrate-vps.sh \
  --env-file /root/mindleaf.env \
  --timeout 1800
```

---

## 11. Checklist operator

### Sebelum migrasi

- [ ] VPS baru Ubuntu 24.04 siap.
- [ ] Port 80 dan 443 terbuka.
- [ ] R2 bucket attachment tetap tersedia.
- [ ] R2 bucket backup dapat dibaca.
- [ ] Backup database terakhir berhasil.
- [ ] File `.env` production lama tersedia.
- [ ] `MASTER_ENCRYPTION_KEY` lama sudah diverifikasi.
- [ ] DNS dan IP VPS baru sudah diketahui.

### Saat migrasi

- [ ] Script dijalankan sebagai root/sudo.
- [ ] Tidak ada migrasi lain yang berjalan.
- [ ] Dump yang dipilih tercatat.
- [ ] Tidak ada error pada log migrasi.
- [ ] `db:push`, `pg_restore`, dan build selesai.

### Setelah migrasi

- [ ] `mindleaf`, Caddy, PostgreSQL, dan cron enabled.
- [ ] `http://localhost:8787/healthz` mengembalikan `{"ok":true}`.
- [ ] HTTPS publik berhasil.
- [ ] Login berhasil.
- [ ] Note lama terlihat.
- [ ] Gambar lama tampil dari R2.
- [ ] Note uji berhasil dibuat/diubah dan tetap ada setelah refresh.
- [ ] Backup manual dari VPS baru berhasil.
- [ ] VPS lama belum dihapus sebelum masa observasi selesai.

---

## Referensi authoritative

- Entrypoint migrasi: `scripts/migrate-vps.sh`
- Provisioning VPS: `deploy/scripts/bootstrap.sh`
- Deploy release: `scripts/deploy.sh`
- Backup database: `deploy/scripts/backup.sh`
- Cron backup: `deploy/cron.d/mindleaf-backup`
- Service backend: `deploy/systemd/mindleaf.service`
- Reverse proxy/TLS: `deploy/Caddyfile`
- Panduan deploy umum dan disaster recovery: `docs/DEPLOY.md`
