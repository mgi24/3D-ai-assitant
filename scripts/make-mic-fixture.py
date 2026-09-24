"""Synthetic audio fixture, never a recording of the user's microphone."""
import asyncio
import io
import wave
from pathlib import Path
import edge_tts
import numpy as np
from faster_whisper.audio import decode_audio
ROOT = Path(__file__).resolve().parents[1]

async def main():
    audio = bytearray()
    async for chunk in edge_tts.Communicate('Halo, siapa namamu? Jawab singkat ya.', 'id-ID-GadisNeural').stream():
        if chunk['type'] == 'audio':
            audio.extend(chunk['data'])
    samples = decode_audio(io.BytesIO(audio), sampling_rate=16000)
    samples = np.concatenate([np.zeros(8000, dtype=np.float32), samples, np.zeros(32000, dtype=np.float32)])
    with wave.open(str(ROOT / 'test-results' / 'microphone-fixture.wav'), 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes((samples * 32767).astype(np.int16).tobytes())
    print('Synthetic microphone fixture ready:', round(len(samples) / 16000, 2), 'seconds')

asyncio.run(main())
