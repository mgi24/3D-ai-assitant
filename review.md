# Review & Rencana Pengembangan Lanjutan

> Dokumen ini disiapkan untuk mencatat ide, perubahan, atau fitur baru yang akan didiskusikan dan diimplementasikan berikutnya.

---

## Temuan arsitektur desktop dan pose

- [x] **UI Windows saja.** `start.bat` telah dijalankan di Windows. Capture [`test-results/start-bat-native-final.png`](test-results/start-bat-native-final.png) menunjukkan avatar tampil tanpa title bar, dan konten desktop terlihat di area transparan di sekelilingnya. Server hanya memberi pesan singkat di `/`; bundle `/app/` dan API memerlukan sesi desktop per-run.
- [x] **Window dan backend satu siklus hidup.** Electron membuat token acak, memulai FastAPI tanpa console, dan menghentikan backend saat window ditutup. `desktop-preload.cjs` menyediakan token sesi, tutup avatar, serta buka/tutup child Pose Browser.
- [x] **Klip pose terpisah.** Definisi animasi disimpan di `public/poses/*.json`; `PoseController` memadukan pose state dan gesture dengan interpolasi halus. Arah telapak pose wave dikoreksi menghadap kamera lalu gerak diperiksa dengan capture tiap 0,5 detik; artefak ada di `test-results/pose-wave-*.png`.
- [x] **Mulut pada pose talk.** `talk.json` dan `speaking.json` sekarang memiliki `expressionTracks` untuk ekspresi VRM `aa`, `ih`, dan `ou`. Preview `talk` tidak lagi menunggu audio TTS; renderer menerapkan track itu ke expression manager, sementara playback TTS tetap dapat menaikkan nilainya berdasarkan amplitudo audio. Loader menambahkan cache-busting agar klip baru tidak tertahan cache Electron lama.
- [x] **Pose Browser window terpisah.** Tombol 🎭 di dock membuka child `BrowserWindow` Electron bergaya browser library: kartu preview pose, avatar preview khusus, preview otomatis saat kartu diklik, timeline durasi, satu tombol Pause/Resume yang berganti sesuai status, pan kamera lewat drag kanan, dan editor keyframe armature. Add pose, simpan override ke localStorage, reset pose bawaan, dan export JSON tersedia di window ini; Settings tidak lagi memuat editor pose. Pose custom tetap tersedia setelah aplikasi dibuka ulang pada perangkat yang sama. Capture native ada di [`test-results/pose-window-native-fullscreen.png`](test-results/pose-window-native-fullscreen.png).
- [x] **Editor armature bergaya Blender.** Preview menampilkan armature humanoid yang dapat diedit berwarna kuning (bone rambut/aksesori disembunyikan), tulang dapat dipilih dari viewport, gizmo `Rotate` tersedia, dan satu timeline gabungan preview/dope-sheet menampilkan marker keyframe kuning. Insert keyframe mengambil pose armature pada waktu aktif; klik marker memilih waktu yang diedit.
- [x] **Kontrol preview editor.** Tombol Pause/Resume dan tombol Space saat fokus di area editor menjeda atau melanjutkan sample pose dan animasi idle di bawahnya sehingga rotasi bone tetap pada waktu yang dipilih. Timeline playback dan keyframe berada dalam satu panel; tinggi preview dapat diubah lewat handle resize vertikal.
- [x] **Reset dan hapus langsung dari preview.** Tombol `Reset bone` di pojok kanan atas menulis ulang hanya bone terpilih ke rotasi rest pose pada waktu aktif. Setelah marker keyframe dipilih, `Delete keyframe` di preview menghapus semua track pada waktu itu dan marker langsung hilang.
- [x] **Riwayat dan propagasi keyframe.** `Undo`/`Redo` tersedia lewat tombol preview dan Ctrl+Z/Ctrl+Y; satu drag gizmo menjadi satu langkah riwayat. Tombol sekali-klik `Apply all` menyalin rotasi bone terpilih dari keyframe aktif ke semua keyframe setelahnya; pengeditan biasa tetap hanya mengubah keyframe aktif.
- [ ] **Distribusi.** Launcher saat ini membutuhkan Node.js, dependency npm termasuk binary Electron, serta `.venv` Python yang sudah ada. Belum tersedia installer Windows mandiri.
- [ ] **Izin mikrofon.** Electron meminta izin mikrofon melalui dialog Windows saat pertama kali dipakai. Perlu dicoba pada perangkat mic fisik pengguna dan kebijakan privasi Windows yang dipakai.

## Verifikasi STT dan percakapan berlanjut

- [x] **Audio uji.** `short_audio.wav` berdurasi 64,15 detik berhasil diproses langsung oleh `server.transcribe_audio`: `faster-whisper-base` pada CPU selesai sekitar 5,5 detik dan `faster-whisper-small` pada `cuda:0` sekitar 5 detik.
- [x] **Jalur API.** Setelah Apply `small/cuda:0`, respons `/api/settings` mengembalikan `loaded: true`, `compute: float16`, dan `/api/stt` mengembalikan HTTP 200 dengan 13 segmen serta 909 karakter transkrip.
- [x] **Persistensi Apply.** `STT_MODEL`, `STT_DEVICE`, diarization, wake word, dan silent transcribe sekarang ditulis ke `.env`; model yang dipilih dimuat penuh sebelum Apply dianggap selesai.
- [x] **System Prompt.** Field `Nama Asisten` pada Pengaturan diganti menjadi textarea `System Prompt`. Default menyebut Mamad, dapat dipersonalisasi, bisa dikembalikan lewat tombol **Reset default**, disimpan sebagai `SYSTEM_PROMPT` di `.env`, dan dipakai server sebagai pesan sistem untuk setiap chat.
- [x] **Preload saat startup.** Backend sekarang memuat model/device terakhir ketika aplikasi mulai. Health melaporkan `loading: true` lalu `loaded: true`; tombol mic tetap nonaktif selama fase loading.
- [x] **Bug macet di “Memahami suaramu”.** Callback `MediaRecorder.onstop` sebelumnya tidak mengirim blob karena state sudah berubah ke `transcribing`; kondisi callback sudah diperbaiki dan request STT memiliki batas waktu 3 menit.
- [x] **Percakapan berlanjut.** Saat checkbox aktif, aplikasi memulai giliran berikutnya setelah jawaban selesai. Rekaman otomatis dikirim setelah suara berhenti sekitar 1,2 detik; tombol **Stop percakapan** membatalkan rekaman, STT, jawaban, suara, dan siklus otomatis.
- [x] **Start Windows.** Log startup mencatat fase preload lalu `STT startup model ready: small on cuda:0`; capture [`test-results/start-bat-native-final.png`](test-results/start-bat-native-final.png) menunjukkan status **AICHAT** setelah model siap, tanpa title bar dengan area transparan di sekelilingnya.

### Concern yang masih perlu diuji di perangkat pengguna

- Ambang VAD memakai RMS tetap (`0,02`); mikrofon yang sangat pelan atau lingkungan bising mungkin memerlukan penyesuaian.
- Model dilepas setelah sekitar 120 detik tidak dipakai. Giliran pertama setelah itu akan memuat ulang model dan UI menampilkan status memuat STT sampai request selesai.
- System Prompt sekarang dapat diubah bebas. Jika instruksinya meminta format selain JSON respons, parser masih mengembalikan teks, tetapi emotion/gesture akan kembali ke nilai aman; prompt default sebaiknya dipertahankan sebagai titik awal.
- Editor saat ini memfokuskan rotasi pada normalized humanoid bones. Bone rambut/aksesori sengaja tidak ditampilkan karena merupakan spring/physics bone VRM dan tidak punya kontrol pose stabil. Tool Move ditahan dulu sampai constraint dan retargeting posisi tersedia; drag kanan tetap untuk menggeser kamera preview.
- Editor pose belum menyediakan field visual khusus untuk mengedit `expressionTracks`; nilai mulut dapat diperiksa atau disesuaikan langsung pada JSON pose sampai editor ekspresi ditambahkan. Gizmo saat ini bekerja pada tulang humanoid yang dinormalisasi oleh VRM.
- Saat Pose Browser terbuka, child window menampilkan avatar preview pose. Pengguna tetap dapat menutupnya tanpa menghentikan backend atau avatar utama.

## 1. Item Tertunda / Opsional untuk Diskusi Berikutnya

- [ ] **Deteksi Kata Jeda (*Verbatim Disfluency*)**:
  - Menambahkan `initial_prompt="Ee, umm, anu..."` pada Whisper di [server.py](file:///e:/CODING/aichat/server.py) agar kata-kata jeda/ragu seperti *"ee..."* atau *"umm..."* tidak dibersihkan otomatis oleh model, melainkan tetap tertulis di transkrip.
- [ ] **Pyannote Neural Diarization Checkpoint**:
  - Saat ini pemisahan pembicara menggunakan clustering fitur akustik (timbre, frekuensi nada, energi).
  - Jika ingin upgrade ke neural network model `pyannote/speaker-diarization-3.1`, memerlukan HuggingFace User Access Token.

---

*(Area di bawah ini kosong untuk mencatat kebutuhan baru setelah diskusi berikutnya)*
