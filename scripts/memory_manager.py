"""Memory compactor matching memory/Rules.md and transcribe/rules.md.
Compacts all .srt files in transcribe/ into memory/tanggal_bulan_tahun_jam.txt,
then removes processed .srt files.
"""
from __future__ import annotations

import datetime
from pathlib import Path
import httpx

def get_current_date_hour_slug() -> str:
    """Format: tanggal_bulan_tahun_jam (e.g. 21_09_2026_17)"""
    now = datetime.datetime.now()
    return f"{now.day:02d}_{now.month:02d}_{now.year}_{now.hour:02d}"


async def compact_transcripts(
    root_dir: Path,
    http_client: httpx.AsyncClient,
    base_url: str,
    api_key: str,
    ai_model: str
) -> dict:
    transcribe_dir = root_dir / 'transcribe'
    memory_dir = root_dir / 'memory'
    memory_dir.mkdir(parents=True, exist_ok=True)

    if not transcribe_dir.exists():
        return {'ok': False, 'message': 'Folder transcribe belum ada.'}

    # Find all .srt files
    srt_files = sorted(transcribe_dir.glob('*.srt'))
    if not srt_files:
        return {'ok': False, 'message': 'Tidak ada file transkrip (.srt) yang belum diproses di folder transcribe/.'}

    combined_text = []
    for srt in srt_files:
        try:
            content = srt.read_text(encoding='utf-8').strip()
            if content:
                combined_text.append(f"--- File: {srt.name} ---\n{content}")
        except Exception:
            pass

    if not combined_text:
        return {'ok': False, 'message': 'File transkrip kosong.'}

    full_transcript = "\n\n".join(combined_text)

    # Call LLM to compact memories
    system_prompt = (
        "Kamu adalah asisten perangkum memori pintar. Tugasmu adalah meringkas transkrip percakapan/podcast "
        "menjadi catatan memori terstruktur (bullet points) dalam Bahasa Indonesia. "
        "Catat poin penting, topik bahasan, komitmen/keputusan jika ada, dan konteks siapa yang berbicara (SPEAKER 0 / SPEAKER 1). "
        "Gunakan format ringkas, padat, dan informatif."
    )

    summary = ""
    try:
        payload = {
            'model': ai_model,
            'messages': [
                {'role': 'system', 'content': system_prompt},
                {'role': 'user', 'content': f"Rangkum transkrip berikut menjadi memori permanen:\n\n{full_transcript[:8000]}"}
            ],
            'max_tokens': 1200,
            'temperature': 0.3
        }
        res = await http_client.post(
            base_url + '/chat/completions',
            headers={'Authorization': f'Bearer {api_key}'},
            json=payload,
            timeout=60.0
        )
        if res.status_code == 200:
            data = res.json()
            summary = data['choices'][0]['message'].get('content', '').strip()
    except Exception as e:
        return {'ok': False, 'message': f'Gagal merangkum dengan AI: {e}'}

    if not summary:
        return {'ok': False, 'message': 'AI tidak menghasilkan ringkasan memori.'}

    # Write to memory/tanggal_bulan_tahun_jam.txt
    slug = get_current_date_hour_slug()
    mem_file = memory_dir / f"{slug}.txt"
    timestamp_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    entry = f"\n=== MEMORY LOG [{timestamp_str}] ===\nSumber: {len(srt_files)} file transkrip ({', '.join(f.name for f in srt_files)})\n\n{summary}\n"

    mode = 'a' if mem_file.exists() else 'w'
    with open(mem_file, mode, encoding='utf-8') as f:
        f.write(entry)

    # Delete processed .srt files
    deleted_count = 0
    for srt in srt_files:
        try:
            srt.unlink()
            deleted_count += 1
        except Exception:
            pass

    return {
        'ok': True,
        'message': f'Berhasil merangkum {len(srt_files)} file transkrip ke memory/{mem_file.name}, dan menghapus file sumber.',
        'targetFile': str(mem_file.name),
        'deletedCount': deleted_count,
        'summary': summary
    }
