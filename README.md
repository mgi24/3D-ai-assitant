# 3D AI Assistant · VRoid Virtual Companion

Aplikasi desktop Windows untuk berinteraksi dan berbicara secara real-time dengan karakter avatar 3D VRM (**VRoid Studio**). Dilengkapi dengan Speech-to-Text (Faster-Whisper) lokal, Text-to-Speech natural (Edge-TTS), LLM chat responsif (Gemini / OpenAI compatible), serta **3D Pose & Keyframe Editor** lengkap dengan kurva interpolasi (*easing*).

---

## Fitur Utama

### 1. Avatar 3D VRM & Ekspresi Real-time
* **Kompatibilitas Penuh VRoid Studio:** Mendukung model VRM 1.0 standar melalui `@pixiv/three-vrm`. Seluruh pose dan armature langsung cocok dengan avatar VRoid apapun tanpa perlu re-rigging.
* **Lip-Sync & Ekspresi:** Mulut sinkron otomatis saat berbicara menggunakan *blend shapes* viseme (`aa`, `ih`, `ou`).
* **Micro-Animations Prosedural:** Kedipan mata alami (*auto-blink*), gerakan bernapas (*breathing*), dan penelusuran kepala (*head tracking*).

### 2. Pose & Keyframe Editor Bawaan (Mixamo & Blender Style)
* **Koleksi Pose Library:** Kartu pose dengan preview animasi interaktif (*idle*, *wave*, *speaking*, *thinking*, *nod*, dll.).
* **Armature Gizmo 3D:** Klik tulang pada avatar 3D untuk memutar sendi secara presisi dengan gizmo rotasi.
* **Dope-sheet Timeline Scrubber:** Navigasi waktu animasi, pengaturan durasi, dan transisi loop.
* **Interpolasi Keyframe (*Easing Curves*):**
  * `Linear` *(default)*: Pergerakan konstan antar keyframe.
  * `Ease In-Out`: Gerakan mulus dengan akselerasi dan deselerasi halus di awal dan akhir.
  * `Ease In`: Mulai perlahan lalu berakselerasi menuju keyframe berikutnya.
  * `Ease Out`: Mulai cepat lalu melambat lembut saat mendekati keyframe berikutnya.
  * `Step`: Menahan pose statis sampai keyframe berikutnya tiba (*hold pose*).
* **Fitur Timeline Lengkap:**
  * Multi-selection keyframe (seleksi kotak marquee atau `Shift + Klik`).
  * Copy & Paste keyframe (`Ctrl + C` / `Ctrl + V`) dengan auto-extend durasi timeline jika ditempel melampaui batas akhir.
  * Undo & Redo bertingkat (`Ctrl + Z` / `Ctrl + Y`).
  * *Apply All* untuk menyalin rotasi tulang aktif ke seluruh keyframe setelahnya dalam satu klik.
  * Ekspor & impor pose kustom sebagai file `.json`.

### 3. Voice AI & Percakapan Cerdas
* **STT Multilingual Lokal:** Menggunakan **Faster-Whisper** (`base` / `small`), mendukung akselerasi CPU (int8) maupun GPU NVIDIA CUDA (float16) dengan indikator pemakaian VRAM.
* **TTS Natural:** Didukung **Edge-TTS** dengan opsi suara bahasa Indonesia (seperti `id-ID-GadisNeural` dan `id-ID-ArdiNeural`) serta berbagai suara internasional lainnya.
* **Mode Percakapan Berlanjut:** Otomatis mendengarkan kembali setelah AI selesai menjawab menggunakan Voice Activity Detection (VAD).
* **Sela & Bicara:** Tombol interupsi instan untuk memotong ucapan AI dan memulai giliran bicara baru.

### 4. Integrasi Desktop Transparan
* Tampilan transparan tanpa bingkai (*frameless transparent window*) yang melayang di layar Windows.
* Backend FastAPI berjalan aman di loopback lokal (`127.0.0.1`) dengan token otentikasi sesi terbatas.

---

## Kebutuhan Sistem

* **Sistem Operasi:** Windows 10 atau Windows 11 (64-bit)
* **Python:** Versi 3.10 – 3.12
* **Node.js:** Versi 18+ (disarankan Node.js 20 atau 24 LTS)
* **Hardware:** Minimal RAM 8 GB. GPU NVIDIA (VRAM minimal 4 GB) disarankan untuk inferensi STT berbasis CUDA.

---

## Panduan Instalasi & Menjalankan

### 1. Clone Repository
```powershell
git clone https://github.com/mgi24/3D-ai-assitant.git
cd 3D-ai-assitant
```

### 2. Siapkan Lingkungan Python
```powershell
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

### 3. Install Dependensi Node & Build Frontend
```powershell
npm install
npm run build
```

### 4. Konfigurasi Avatar & Environment
1. Letakkan avatar VRoid Anda berformat `.vrm` di folder:
   ```
   public/avatar/character.vrm
   ```
2. Salin template `.env.example` menjadi `.env`:
   ```powershell
   copy .env.example .env
   ```
3. Buka `.env` dan masukkan API Key Anda (misal Gemini API atau OpenAI compatible):
   ```dotenv
   AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
   AI_API_KEY=masukkan-api-key-anda-disini
   AI_MODEL=gemini-2.5-flash
   TTS_VOICE=id-ID-GadisNeural
   STT_MODEL=base
   STT_DEVICE=cpu
   ```

### 5. Jalankan Aplikasi
Cukup klik dua kali berkas **`start.bat`** atau jalankan perintah:
```powershell
.\start.bat
```
*(Atau gunakan perintah `npm run desktop` jika ingin menjalankan runner Electron secara langsung).*

---

## Pintasan Keyboard (Shortcuts)

| Shortcut | Aksi |
| --- | --- |
| `Space` | Jeda (Pause) atau Lanjutkan (Resume) playback preview pose |
| `Ctrl + Z` | Undo perubahan pose / pergeseran keyframe |
| `Ctrl + Y` | Redo perubahan pose |
| `Ctrl + C` | Salin (*Copy*) keyframe terpilih ke clipboard |
| `Ctrl + V` | Tempel (*Paste*) keyframe pada posisi waktu scrubber timeline |
| `Ctrl + A` | Pilih semua keyframe pada timeline pose |
| `Shift + Klik` | Multi-pilih keyframe marker pada timeline |
| `Alt + F4` | Menutup aplikasi dan mematikan backend secara bersih |

---

## Struktur Direktori

```
├── .env.example            # Template konfigurasi environment
├── .gitignore              # Konfigurasi filter berkas Git
├── desktop-main.cjs        # Main process Electron untuk desktop transparan
├── desktop-preload.cjs     # Preload bridge aman ke antarmuka web
├── server.py               # Backend FastAPI (STT, TTS, Chat API, resource limit)
├── start.bat               # Skrip peluncur satu klik untuk Windows
├── package.json            # Dependensi frontend & script NPM
├── requirements.txt        # Dependensi Python
├── index.html              # Struktur UI aplikasi desktop & Pose Editor
├── src/
│   ├── avatar.js           # Three.js & VRM loader, kontrol ekspresi, eye tracking
│   ├── pose-controller.js  # Engine animasi pose, evaluasi easing & interpolasi
│   ├── main.js             # State manager percakapan, audio stream, Pose Browser logic
│   └── style.css           # Styling bertema modern glassmorphism
├── public/
│   ├── avatar/             # Tempat berkas avatar VRM (character.vrm)
│   └── poses/              # Berkas pose bawaan (.json)
├── scripts/                # Skrip helper & automated test (Playwright & Python)
├── tests/                  # Backend unit tests
└── docs/                   # Dokumentasi teknis & verifikasi
```

---

## Pengujian & Verifikasi

Proyek ini telah dilengkapi serangkaian pengujian terotomatisasi menggunakan Playwright dan pytest:

```powershell
# Jalankan pengujian animasi & pose capture avatar
npm run test:poses

# Jalankan pengujian fitur multi-select & copy-paste keyframe
node scripts/test_copy_paste_keyframes.mjs

# Jalankan pengujian fitur interpolasi keyframe (easing)
node scripts/test_keyframe_interpolation.mjs

# Jalankan pengujian unit server backend
.venv\Scripts\pytest tests/test_server.py -q
```

---

## Lisensi & Referensi Pihak Ketiga

* [pixiv/three-vrm](https://github.com/pixiv/three-vrm) - Parser dan runtime 3D Humanoid VRM untuk Three.js.
* [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper) - Speech-to-Text inference berbasis CTranslate2.
* [rany2/edge-tts](https://github.com/rany2/edge-tts) - Layanan Microsoft Edge Text-to-Speech tanpa API key berbayar.
* [pixiv/ChatVRM](https://github.com/pixiv/ChatVRM) - Referensi pola arsitektur interaksi VRM.
