# NusaCode

Coding agent CLI untuk NusaGate, dibangun di atas `pi`
(`@earendil-works/pi-coding-agent`, MIT) dengan ekstensi meter biaya, penghemat token,
dan subagent. Lisensi MIT.

## Instalasi

Butuh Node.js >= 22.19.0 (lihat `engines` di `package.json`).

```sh
npm install
export NUSAGATE_API_KEY=...        # ambil dari dashboard NusaGate
npx nusacode
```

Dari checkout repo, launcher bisa dijalankan langsung:

```sh
node bin/nusacode.js
```

## Konfigurasi

Saat pertama dijalankan, launcher menyalin konfigurasi default ke direktori home:
`NUSACODE_HOME`, atau `~/.nusacode` bila variabel itu tidak diset.

```text
~/.nusacode/
  settings.json          # dari config/settings.default.json
  models.json            # dari config/models.json
  agents/*.md            # dari config/agents/
  sessions/              # riwayat sesi
```

Penyalinan memakai `COPYFILE_EXCL`: file yang sudah ada tidak pernah ditimpa, jadi
salinan Anda tetap utuh saat versi baru dijalankan. Direktori home tersebut
dipakai sebagai `PI_CODING_AGENT_DIR`, dan sesi disimpan lewat `--session-dir`.

Provider dan model default dari `config/models.json` + `config/settings.default.json`:
provider `nusagate`, `"baseUrl": "https://api.nusagate.com/v1"`, `"api": "openai-completions"`,
`"apiKey": "$NUSAGATE_API_KEY"`, model `deepseek-v4.1-flash` (contextWindow 1048576, maxTokens 16384).

URL katalog harga bisa diganti lewat `NUSAGATE_MODELS_URL`; meter membacanya saat
`session_start` dan memakai `https://api.nusagate.com/api/public/models` bila tidak diset.

## Perintah

| Perintah | Deskripsi |
| --- | --- |
| `/nusa` | Tampilkan meter biaya sesi (rupiah, token, penghematan) |
| `/topup` | Tampilkan link top up saldo NusaGate |

## Subagent `task`

Tool `task` mendelegasikan satu tugas mandiri ke proses `pi` terpisah dengan context
window sendiri, dijalankan di cwd yang sama. Anak tidak melihat percakapan induk, jadi
seluruh fakta yang dibutuhkan harus ada di dalam prompt.

Agent yang tersedia, masing-masing dengan model dan daftar tool di frontmatter-nya:
`explorer` (default), `researcher`, `reviewer`, `test-runner`, `writer`.

Anak dijalankan dengan `--no-session` dan `--tools` berisi allowlist dari definisi
agent, jadi rekursi tertutup secara struktural: allowlist tidak pernah memuat `task`,
paket ekstensi tidak dimuat (`--no-extensions`), dan environment anak membawa
`NUSACODE_SUBAGENT=1`. Paling banyak empat anak berjalan bersamaan; sisanya menunggu.
Batas waktu per anak `600_000` ms, bisa diubah lewat `NUSACODE_SUBAGENT_TIMEOUT_MS`.

## Meter biaya

Token diambil dari `usage` pada respons provider; harga rupiah diambil sekali per sesi
dari katalog publik NusaGate. Tiap respons dihitung dengan rumus penagihan gateway:
tarif input + tarif output + cache-hit (persentase dari tarif input), dijumlahkan lalu
dibulatkan ke atas per request (`Math.ceil`). Tidak ada harga yang di-hardcode.

Saldo tidak ditampilkan: NusaGate belum punya endpoint saldo berautentikasi API key,
sehingga meter hanya melaporkan biaya, token, dan perbandingan dengan harga resmi vendor.

## Token saver

Tiga tuas, dari yang termurah:

1. **Penjaga cache prefix** — sidik jari system prompt + daftar tool dihitung pada
   setiap request. Perubahan di tengah sesi membatalkan cache prefix provider; meter
   memberi peringatan sekali, tanpa memblokir dan tanpa mengubah payload.
2. **Pemotongan output tool** — hasil `read` dan `bash` dibatasi 200 baris; pi sendiri
   sudah membatasi 2000 baris / 50KB, jadi ini memperketat batas yang ada. `read`
   melanjutkan lewat `offset`, `bash` menyimpan ekor (ringkasan + pointer output).
3. **Routing thinking** — level diambil dari settings (`modelThinkingLevels` per model,
   lalu `defaultThinkingLevel`) dan turun ke `minimal` untuk prompt mekanis singkat
   selama sesi belum punya tool yang gagal. Pilihan `/think` eksplisit menang.

`NUSACODE_NO_TOKEN_SAVER=1` mematikan ketiganya (dipakai sebagai saklar A/B).
`NUSACODE_TRUNCATE_LINES=0` mematikan pemotongan; nilai lain mengganti batas baris.

Angka terukur pada `nusagate/deepseek-v4.1-flash` (M3, 2026-10-26) seperti tercatat di
header `token-saver.ts`: batas 200 baris menghasilkan 100.5k vs 97.9k token pada sesi
yang sama (+2.7%), biaya tetap Rp 22; batas 50 baris menghemat 15.4% token tetapi
menyembunyikan output yang seharusnya terlihat.

## Struktur repo

```text
bin/nusacode.js              launcher: seed konfigurasi, lalu jalankan pi
config/settings.default.json provider dan model default
config/models.json           definisi provider nusagate
config/agents/*.md           lima definisi agent untuk tool task
pack/extensions/meter.ts     meter biaya rupiah + perintah /nusa dan /topup
pack/extensions/token-saver.ts  cache guard, pemotongan output, routing thinking
pack/extensions/subagents.ts tool task dan protokol usage anak
```

`pack/` adalah workspace npm (`@nusacode/pack`), diekspos sebagai pi-package lewat `pi.extensions: ["./extensions"]`.

## Lisensi

MIT. Lihat `LICENSE`. NusaCode memakai `pi` (MIT, earendil-works) sebagai dependensi
runtime tanpa modifikasi; atribusinya ada di `NOTICE`, dan proyek ini bukan produk
yang disponsori atau didukung oleh maintainer pi.
