"""Download only the selected multilingual CPU model; do not load it into RAM."""
import os
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
os.environ['HF_HOME'] = str(ROOT / 'models' / 'huggingface')
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
from dotenv import load_dotenv
from huggingface_hub import snapshot_download
load_dotenv(ROOT / '.env', encoding='utf-8-sig')
name = os.getenv('STT_MODEL', 'base')
if name not in ('tiny', 'base', 'small'):
    raise SystemExit('STT_MODEL must be tiny, base, or small for this resource-limited setup.')
snapshot_download(repo_id=f'Systran/faster-whisper-{name}',
    local_dir=ROOT / 'models' / f'faster-whisper-{name}',
    allow_patterns=['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.*'], max_workers=2)
print(f'Model {name} ready (CPU int8; loads only when transcribing).')
