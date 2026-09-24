"""Diarization and SRT formatter for AICHAT.
Follows rules in transcribe/rules.md:
  File name: tanggal_bulan_tahun_jam.srt
  Format:
  00:00:00,000 --> 00:00:01,000
  SPEAKER 0: [text]

  00:00:01,000 --> 00:00:02,000
  SPEAKER 1: [text]
"""
from __future__ import annotations

import datetime
from pathlib import Path
from typing import Any
import numpy as np

def format_timestamp(seconds: float) -> str:
    """Format float seconds to SRT timestamp: 00:00:00,000"""
    millis = int(round(seconds * 1000))
    hours = millis // 3600000
    millis %= 3600000
    mins = millis // 60000
    millis %= 60000
    secs = millis // 1000
    millis %= 1000
    return f"{hours:02d}:{mins:02d}:{secs:02d},{millis:03d}"


def extract_features(audio_segment: np.ndarray, sr: int = 16000) -> np.ndarray:
    """Extract fast acoustic feature vector (energy, zero-crossing, spectral centroid/rolloff)."""
    if len(audio_segment) < 256:
        return np.zeros(8, dtype=np.float32)
    
    # Normalize
    audio = audio_segment.astype(np.float32)
    max_val = np.max(np.abs(audio)) + 1e-8
    audio = audio / max_val

    # 1. Zero crossing rate
    zcr = np.mean(np.abs(np.diff(np.sign(audio))))

    # 2. RMS Energy
    rms = np.sqrt(np.mean(audio ** 2))

    # 3. FFT Spectrum features
    fft = np.abs(np.fft.rfft(audio[:min(len(audio), 4096)]))
    freqs = np.fft.rfftfreq(min(len(audio), 4096), d=1.0/sr)
    sum_fft = np.sum(fft) + 1e-8

    # Spectral Centroid
    centroid = np.sum(freqs * fft) / sum_fft

    # Spectral Spread
    spread = np.sqrt(np.sum(((freqs - centroid) ** 2) * fft) / sum_fft)

    # 4 band energies (pitch & timbre discrimination)
    bands = np.array_split(fft, 4)
    band_energies = [np.mean(b) / sum_fft for b in bands]

    return np.array([zcr, rms, centroid / sr, spread / sr, *band_energies], dtype=np.float32)


def diarize_segments(audio: np.ndarray, segments: list[Any], enable_diarization: bool = False, sr: int = 16000) -> list[dict]:
    """Assign speaker labels (SPEAKER 0, SPEAKER 1, etc.) to faster-whisper segments."""
    if not segments:
        return []

    labeled = []
    if not enable_diarization or len(segments) == 1:
        for s in segments:
            text = s.text.strip() if hasattr(s, 'text') else str(s.get('text', '')).strip()
            start = s.start if hasattr(s, 'start') else float(s.get('start', 0.0))
            end = s.end if hasattr(s, 'end') else float(s.get('end', 0.0))
            labeled.append({'start': start, 'end': end, 'speaker': 'SPEAKER 0', 'text': text})
        return labeled

    # Extract features for each segment
    features = []
    valid_indices = []
    for idx, s in enumerate(segments):
        start = s.start if hasattr(s, 'start') else float(s.get('start', 0.0))
        end = s.end if hasattr(s, 'end') else float(s.get('end', 0.0))
        start_samp = int(max(0, start * sr))
        end_samp = int(min(len(audio), end * sr))
        chunk = audio[start_samp:end_samp]
        feat = extract_features(chunk, sr=sr)
        features.append(feat)
        valid_indices.append(idx)

    # Cluster speakers if multiple segments
    try:
        from sklearn.cluster import AgglomerativeClustering
        X = np.array(features)
        # Normalize features
        norm = np.linalg.norm(X, axis=1, keepdims=True) + 1e-8
        X_norm = X / norm
        
        # Max 2 speakers for podcast/dialogue or distance clustering
        n_clusters = min(2, len(segments))
        clustering = AgglomerativeClustering(n_clusters=n_clusters, metric='cosine', linkage='average')
        labels = clustering.fit_predict(X_norm)
    except Exception:
        labels = [0] * len(segments)

    for idx, s in enumerate(segments):
        text = s.text.strip() if hasattr(s, 'text') else str(s.get('text', '')).strip()
        start = s.start if hasattr(s, 'start') else float(s.get('start', 0.0))
        end = s.end if hasattr(s, 'end') else float(s.get('end', 0.0))
        spk_id = labels[idx] if idx < len(labels) else 0
        labeled.append({
            'start': start,
            'end': end,
            'speaker': f"SPEAKER {spk_id}",
            'text': text
        })

    return labeled


def format_srt_block(start_sec: float, end_sec: float, speaker: str, text: str) -> str:
    """Format single entry according to transcribe/rules.md"""
    t_start = format_timestamp(start_sec)
    t_end = format_timestamp(end_sec)
    return f"{t_start} --> {t_end}\n{speaker}: {text}\n\n"


def get_current_date_hour_slug() -> str:
    """Format: tanggal_bulan_tahun_jam (e.g. 21_09_2026_17)"""
    now = datetime.datetime.now()
    return f"{now.day:02d}_{now.month:02d}_{now.year}_{now.hour:02d}"


def append_to_transcribe_file(root_dir: Path, labeled_segments: list[dict], time_offset: float = 0.0) -> Path:
    """Append labeled segments to transcribe/tanggal_bulan_tahun_jam.srt"""
    transcribe_dir = root_dir / 'transcribe'
    transcribe_dir.mkdir(parents=True, exist_ok=True)
    slug = get_current_date_hour_slug()
    srt_path = transcribe_dir / f"{slug}.srt"

    content = ""
    for seg in labeled_segments:
        if not seg['text']:
            continue
        content += format_srt_block(
            seg['start'] + time_offset,
            seg['end'] + time_offset,
            seg['speaker'],
            seg['text']
        )

    with open(srt_path, 'a', encoding='utf-8') as f:
        f.write(content)

    return srt_path
