"""Download faster-whisper-small model into models/faster-whisper-small."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ['HF_HOME'] = str(ROOT / 'models' / 'huggingface')
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'

from huggingface_hub import snapshot_download

target_dir = ROOT / 'models' / 'faster-whisper-small'
print(f'Downloading Systran/faster-whisper-small to {target_dir}...')
snapshot_download(
    repo_id='Systran/faster-whisper-small',
    local_dir=target_dir,
    allow_patterns=['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.*'],
    max_workers=2
)
print('Model faster-whisper-small successfully downloaded and ready.')
