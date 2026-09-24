"""Loopback-only avatar assistant for the Windows desktop shell."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.environ.setdefault('OMP_NUM_THREADS', '2')
os.environ.setdefault('OPENBLAS_NUM_THREADS', '2')
os.environ.setdefault('MKL_NUM_THREADS', '2')
os.environ.setdefault('HF_HOME', str(ROOT / 'models' / 'huggingface'))
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')

import asyncio
import gc
import hmac
import io
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Literal
from urllib.parse import urlparse

import edge_tts
import httpx
import psutil
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

load_dotenv(ROOT / '.env', encoding='utf-8-sig')
BASE_URL = os.getenv('AI_BASE_URL', '').rstrip('/')
API_KEY = os.getenv('AI_API_KEY', '')
AI_MODEL = os.getenv('AI_MODEL', 'oc/big-pickle')
STT_MODEL = os.getenv('STT_MODEL', 'base')
STT_DEVICE = os.getenv('STT_DEVICE', 'cpu')
# This is intentionally kept server-side so chat clients cannot override the
# assistant's instruction through the chat request body. Newlines
# are escaped when persisted to `.env` and restored when the process starts.
DEFAULT_SYSTEM_PROMPT = (
    'You are Mamad, a friendly virtual avatar assistant speaking naturally in Indonesian. '
    'Use the language requested by the user. Reply briefly in 1-3 conversational sentences unless '
    'more detail is requested. You can speak, blink and gesture through a VRoid avatar. '
    'Be honest: you cannot see, control the PC, open files, or use tools. '
    'Return ONLY a JSON object with keys text (your spoken answer, no markdown), '
    'emotion (neutral, happy, sad, relaxed, surprised, angry), '
    'gesture (talk, wave, nod, think, none). Never include internal reasoning.'
)


def normalize_system_prompt(value: str | None) -> str:
    """Trim a user-edited prompt while retaining intentional line breaks."""
    prompt = (value or '').replace('\r\n', '\n').replace('\r', '\n').strip()
    return prompt[:6000] or DEFAULT_SYSTEM_PROMPT


_stored_system_prompt = os.getenv('SYSTEM_PROMPT', '')
SYSTEM_PROMPT = normalize_system_prompt(_stored_system_prompt.replace('\\n', '\n'))
DIARIZATION_ENABLED = os.getenv('DIARIZATION_ENABLED', 'false').lower() in ('true', '1', 'yes')
WAKE_WORD = os.getenv('WAKE_WORD', 'Hai Anna')
SILENT_TRANSCRIBE = os.getenv('SILENT_TRANSCRIBE', 'false').lower() in ('true', '1', 'yes')
DESKTOP_TOKEN = os.getenv('AICHAT_DESKTOP_TOKEN', '')
DESKTOP_SESSION_COOKIE = 'aichat_desktop_session'
STT_THREADS = max(1, min(2, int(os.getenv('STT_THREADS', '2'))))
VOICES = ['id-ID-GadisNeural', 'id-ID-ArdiNeural', 'en-US-AriaNeural', 'en-US-GuyNeural', 'ja-JP-NanamiNeural']
pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='stt-cpu')
stt_lock = asyncio.Lock()
tts_lock = asyncio.Semaphore(1)
chat_lock = asyncio.Semaphore(1)
stt_model = None
stt_loaded_model = None
stt_loaded_device = None
stt_loaded_compute = None
# The lifespan task clears this after warming the persisted model. Keeping the
# initial value true prevents the first desktop health check from enabling mic
# controls during the tiny gap before that task is scheduled.
stt_loading = True
stt_load_error = ''
last_stt = 0.0
process = psutil.Process()
try:
    if os.name == 'nt':
        process.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
except psutil.Error:
    pass

from scripts.diarizer import diarize_segments, append_to_transcribe_file
from scripts.memory_manager import compact_transcripts


async def release_idle_model():
    global stt_model, stt_loaded_model, stt_loaded_device, stt_loaded_compute
    while True:
        await asyncio.sleep(30)
        if stt_model is not None and not stt_lock.locked() and time.monotonic() - last_stt > 120:
            async with stt_lock:
                stt_model = None
                stt_loaded_model = None
                stt_loaded_device = None
                stt_loaded_compute = None
                gc.collect()


@asynccontextmanager
async def lifespan(app):
    global pool
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='stt-cpu')
    async with httpx.AsyncClient(timeout=httpx.Timeout(90, connect=15), follow_redirects=False) as client:
        app.state.http = client
        idle_task = asyncio.create_task(release_idle_model())
        startup_task = asyncio.create_task(preload_startup_model())
        try:
            yield
        finally:
            idle_task.cancel()
            startup_task.cancel()
            await asyncio.gather(idle_task, startup_task, return_exceptions=True)
    pool.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title='AICHAT · VRoid companion', lifespan=lifespan,
              docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware('http')
async def local_only(request: Request, call_next):
    host = request.headers.get('host', '').split(':')[0]
    origin = request.headers.get('origin')
    if host not in ('127.0.0.1', 'localhost', 'testserver'):
        return JSONResponse({'detail': 'Hanya akses localhost yang diizinkan.'}, status_code=403)
    if origin and urlparse(origin).hostname not in ('127.0.0.1', 'localhost'):
        return JSONResponse({'detail': 'Origin tidak diizinkan.'}, status_code=403)

    supplied_token = request.headers.get('X-AICHAT-Desktop-Token', '')
    token_matches = bool(DESKTOP_TOKEN) and hmac.compare_digest(supplied_token, DESKTOP_TOKEN)
    if request.url.path == '/api/desktop-ready':
        if token_matches:
            return JSONResponse({'ok': True, 'desktopUiEnabled': True})
        return PlainTextResponse('Not found.', status_code=404)
    if request.url.path == '/api/desktop-session':
        if request.method != 'POST' or not token_matches:
            return PlainTextResponse('Not found.', status_code=404)
        response = JSONResponse({'ok': True})
        response.set_cookie(DESKTOP_SESSION_COOKIE, DESKTOP_TOKEN, httponly=True,
                            secure=False, samesite='strict', max_age=8 * 60 * 60, path='/')
        response.headers['Cache-Control'] = 'no-store'
        return response

    if request.url.path != '/' and not hmac.compare_digest(
        request.cookies.get(DESKTOP_SESSION_COOKIE, ''), DESKTOP_TOKEN or '\0'
    ):
        return PlainTextResponse('Aplikasi hanya tersedia melalui jendela desktop.', status_code=404)

    response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    if request.url.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store'
    return response


@app.get('/')
async def desktop_bootstrap():
    """Minimal bridge page; ordinary browsers never receive the application UI."""
    return HTMLResponse('''<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AICHAT Desktop</title><style>
html,body{margin:0;min-height:100%;background:transparent;color:transparent;font:14px sans-serif}
#desktop-only{display:none;margin:24px;color:#183f36;background:#f1f5eb;padding:16px;border-radius:10px}
</style></head><body><p id="desktop-only">AICHAT hanya tersedia di aplikasi Windows. Jalankan start.bat.</p>
<script>
const notice=()=>{document.getElementById('desktop-only').style.display='block';document.body.style.background='#f1f5eb'};
const desktopBridge=()=>window.aichatDesktop;
async function openDesktopApp(){
  const bridge=desktopBridge();
  if(!bridge){notice();return}
  try{
    const token=await bridge.getSessionToken();
    if(!token){notice();return}
    const result=await fetch('/api/desktop-session',{method:'POST',headers:{'X-AICHAT-Desktop-Token':token}});
    if(result.ok){location.replace('/app/'+location.search+location.hash);return}
  }catch{}
  notice();
}
if(desktopBridge())openDesktopApp();
else notice();
</script></body></html>''')


class Message(BaseModel):
    role: Literal['user', 'assistant']
    content: str = Field(min_length=1, max_length=4000)


class ChatInput(BaseModel):
    messages: list[Message] = Field(min_length=1, max_length=16)


class SpeechInput(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    voice: str = 'id-ID-GadisNeural'
    rate: int = Field(default=0, ge=-30, le=30)


def parse_reply(content: str) -> dict:
    """Never surface reasoning blocks; tolerate providers that don't obey JSON mode."""
    text = re.sub(r'<think>.*?(?:</think>|$)', '', content, flags=re.S | re.I).strip()
    text = re.sub(r'^```(?:json)?\s*|\s*```$', '', text).strip()
    obj = None
    try:
        obj = json.loads(text)
    except (ValueError, TypeError):
        start, end = text.find('{'), text.rfind('}')
        if start >= 0 and end > start:
            try:
                obj = json.loads(text[start:end + 1])
            except ValueError:
                pass
    if isinstance(obj, dict) and isinstance(obj.get('text'), str):
        text = obj['text'].strip()
    else:
        obj = {}
    if not text:
        raise HTTPException(502, 'Model belum mengirim jawaban akhir. Silakan coba lagi.')
    emotion = obj.get('emotion', 'neutral')
    gesture = obj.get('gesture', 'talk')
    return {
        'text': text[:2000],
        'emotion': emotion if emotion in ('neutral', 'happy', 'sad', 'relaxed', 'surprised', 'angry') else 'neutral',
        'gesture': gesture if gesture in ('talk', 'wave', 'nod', 'think', 'none') else 'talk',
    }


@app.get('/api/health')
async def health():
    memory = psutil.virtual_memory()
    model_path = ROOT / 'models' / f'faster-whisper-{STT_MODEL}'
    if STT_DEVICE == 'cpu':
        stt_compute = 'int8'
    else:
        stt_compute = 'float16'
    return {
        'ok': True, 'desktopUiEnabled': bool(DESKTOP_TOKEN),
        'model': AI_MODEL, 'configured': bool(API_KEY and BASE_URL),
        'avatarReady': (ROOT / 'public/avatar/character.vrm').exists(),
        'stt': {'model': STT_MODEL, 'device': STT_DEVICE, 'compute': stt_compute, 'threads': STT_THREADS,
                'downloaded': (model_path / 'model.bin').exists(), 'loaded': stt_model is not None,
                'loading': stt_loading, 'loadError': stt_load_error},
        'tts': {'provider': 'edge-tts', 'voices': VOICES, 'defaultVoice': os.getenv('TTS_VOICE', VOICES[0])},
        'resources': {'serverMB': round(process.memory_info().rss / 1048576),
                      'freeRAMGB': round(memory.available / 1073741824, 2), 'fpsLimit': 30},
    }


@app.post('/api/chat')
async def chat(data: ChatInput, request: Request):
    if not API_KEY or not BASE_URL:
        raise HTTPException(503, 'Isi AI_BASE_URL dan AI_API_KEY pada file .env, lalu restart aplikasi.')
    if data.messages[-1].role != 'user':
        raise HTTPException(422, 'Pesan terakhir harus berasal dari pengguna.')
    # The prompt is edited in Settings and stored by the backend. Keep it out
    # of the request body so the caller cannot replace the system instruction.
    system = SYSTEM_PROMPT
    payload = {'model': AI_MODEL, 'messages': [{'role': 'system', 'content': system}] +
               [m.model_dump() for m in data.messages[-12:]], 'max_tokens': 1800, 'stream': False}
    started = time.monotonic()
    async with chat_lock:
        try:
            result = await request.app.state.http.post(BASE_URL + '/chat/completions',
                headers={'Authorization': f'Bearer {API_KEY}'}, json=payload)
        except httpx.TimeoutException:
            raise HTTPException(504, 'Model AI terlalu lama merespons. Coba sekali lagi.')
        except httpx.HTTPError:
            raise HTTPException(502, 'Endpoint AI tidak dapat dihubungi.')
    if result.status_code != 200:
        raise HTTPException(502, f'Endpoint AI mengembalikan HTTP {result.status_code}. Periksa key/model di .env.')
    try:
        result_json = result.json()
        content = result_json['choices'][0]['message'].get('content')
    except (ValueError, KeyError, IndexError, TypeError):
        raise HTTPException(502, 'Format respons endpoint AI tidak sesuai.')
    if not isinstance(content, str) or not content.strip():
        raise HTTPException(502, 'Model hanya mengirim reasoning tanpa jawaban akhir. Coba lagi.')
    reply = parse_reply(content)
    reply['latencyMs'] = round((time.monotonic() - started) * 1000)
    return reply


@app.post('/api/tts')
async def tts(data: SpeechInput):
    if data.voice not in VOICES:
        raise HTTPException(422, 'Pilih suara yang tersedia.')
    async with tts_lock:
        try:
            async with asyncio.timeout(35):
                audio = bytearray()
                communicate = edge_tts.Communicate(data.text, data.voice, rate=f'{data.rate:+d}%')
                async for chunk in communicate.stream():
                    if chunk['type'] == 'audio':
                        audio.extend(chunk['data'])
                if not audio:
                    raise ValueError('Empty audio')
        except (Exception, TimeoutError):
            raise HTTPException(502, 'Suara online belum tersedia. Gunakan suara bawaan sistem atau coba lagi.')
    return Response(bytes(audio), media_type='audio/mpeg')


def resolve_stt_model_path(model_name: str) -> Path:
    model_path = ROOT / 'models' / f'faster-whisper-{model_name}'
    if not (model_path / 'model.bin').exists():
        raise FileNotFoundError(
            f'Model faster-whisper-{model_name} belum diunduh. Pilih model yang tersedia terlebih dahulu.'
        )
    return model_path


def build_stt_model(model_name: str, device_name: str):
    """Load one Whisper model synchronously in the STT executor thread."""
    from faster_whisper import WhisperModel

    model_path = resolve_stt_model_path(model_name)
    device = 'cpu'
    device_index = 0
    compute_type = 'int8'
    if device_name.startswith('cuda'):
        device = 'cuda'
        compute_type = 'float16'
        if ':' in device_name:
            device_index = int(device_name.split(':', 1)[1])
    return WhisperModel(
        str(model_path),
        device=device,
        device_index=device_index,
        compute_type=compute_type,
        cpu_threads=STT_THREADS if device == 'cpu' else 4,
        num_workers=1
    ), compute_type


async def preload_stt_model(model_name: str, device_name: str) -> dict:
    """Load the selected STT model before microphone requests need it."""
    global stt_model, stt_loaded_model, stt_loaded_device, stt_loaded_compute
    global stt_loading, stt_load_error, last_stt

    if (
        stt_model is not None and
        stt_loaded_model == model_name and
        stt_loaded_device == device_name
    ):
        return {
            'model': model_name,
            'device': device_name,
            'compute': stt_loaded_compute,
            'loaded': True,
            'loadMs': 0,
        }

    started = time.monotonic()
    stt_loading = True
    stt_load_error = ''
    try:
        async with stt_lock:
            # A concurrent Apply/startup request may have loaded this exact
            # configuration while this request was waiting for the lock.
            if (
                stt_model is not None and
                stt_loaded_model == model_name and
                stt_loaded_device == device_name
            ):
                return {
                    'model': model_name,
                    'device': device_name,
                    'compute': stt_loaded_compute,
                    'loaded': True,
                    'loadMs': round((time.monotonic() - started) * 1000),
                }

            # Release the old model before constructing a model on another
            # device. The caller remains in a loading state until construction
            # completes, so the UI never reports a false ready state.
            stt_model = None
            stt_loaded_model = None
            stt_loaded_device = None
            stt_loaded_compute = None
            gc.collect()
            loaded_model, loaded_compute = await asyncio.get_running_loop().run_in_executor(
                pool, build_stt_model, model_name, device_name
            )
            stt_model = loaded_model
            stt_loaded_model = model_name
            stt_loaded_device = device_name
            stt_loaded_compute = loaded_compute
            last_stt = time.monotonic()
            return {
                'model': model_name,
                'device': device_name,
                'compute': loaded_compute,
                'loaded': True,
                'loadMs': round((time.monotonic() - started) * 1000),
            }
    except Exception as exc:
        stt_load_error = str(exc)
        raise
    finally:
        stt_loading = False


async def preload_startup_model():
    """Warm the persisted model while the desktop window is starting."""
    try:
        result = await preload_stt_model(STT_MODEL, STT_DEVICE)
        print(
            f'STT startup model ready: {result["model"]} on {result["device"]} '
            f'({result["loadMs"]} ms)',
            flush=True
        )
    except Exception as exc:
        # Keep the API alive so the UI can show a useful error and the user can
        # choose another model/device in Settings.
        print(f'STT startup preload failed: {exc}', flush=True)


def transcribe_audio(raw: bytes) -> dict:
    global stt_model, stt_loaded_model, stt_loaded_device, stt_loaded_compute, stt_load_error, last_stt
    if STT_DEVICE == 'cpu' and psutil.virtual_memory().available < 2 * 1073741824:
        raise HTTPException(503, 'RAM tersisa kurang dari 2 GB. Gunakan input teks dahulu.')
    from faster_whisper.audio import decode_audio

    # Limit decoded duration before running inference, including compressed uploads.
    audio = decode_audio(io.BytesIO(raw), sampling_rate=16000)
    if len(audio) > 16000 * 65:
        raise HTTPException(413, 'Rekaman maksimal 60 detik.')
    if len(audio) < 1600:
        return {'text': '', 'labeled': []}
    if stt_model is None or stt_loaded_model != STT_MODEL or stt_loaded_device != STT_DEVICE:
        try:
            stt_model, stt_loaded_compute = build_stt_model(STT_MODEL, STT_DEVICE)
            stt_loaded_model = STT_MODEL
            stt_loaded_device = STT_DEVICE
            stt_load_error = ''
        except Exception as exc:
            stt_load_error = str(exc)
            raise HTTPException(503, f'Model STT {STT_MODEL} gagal dimuat pada {STT_DEVICE}: {exc}') from exc
    last_stt = time.monotonic()
    segments, _ = stt_model.transcribe(audio, language='id', beam_size=1, best_of=1,
                                      condition_on_previous_text=False, vad_filter=True)
    segments_list = list(segments)
    labeled = diarize_segments(audio, segments_list, enable_diarization=DIARIZATION_ENABLED)
    result = ' '.join(s['text'] for s in labeled).strip()
    last_stt = time.monotonic()
    return {'text': result, 'labeled': labeled}


@app.post('/api/stt')
async def stt(request: Request, audio: UploadFile = File(...)):
    raw = await audio.read(8 * 1024 * 1024 + 1)
    await audio.close()
    if len(raw) > 8 * 1024 * 1024:
        raise HTTPException(413, 'Rekaman terlalu besar (maksimal 8 MB).')
    if not raw:
        raise HTTPException(422, 'Rekaman kosong.')
    started = time.monotonic()
    async with stt_lock:
        try:
            res = await asyncio.get_running_loop().run_in_executor(pool, transcribe_audio, raw)
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(422, f'Audio tidak bisa dibaca ({e}). Coba rekam ulang dengan mic yang aktif.')
    
    text = res.get('text', '') if isinstance(res, dict) else str(res)
    labeled = res.get('labeled', []) if isinstance(res, dict) else []
    latency_ms = round((time.monotonic() - started) * 1000)

    # 1. Check if user instructed memory compaction
    lower_text = text.lower()
    if re.search(r'(transcribe.*masuk.*memory|proses.*memory|masuk.*ke.*memory|simpan.*transcribe.*ke.*memory)', lower_text):
        compact_res = await compact_transcripts(ROOT, request.app.state.http, BASE_URL, API_KEY, AI_MODEL)
        reply_msg = compact_res.get('message', 'Pemrosesan memori selesai.')
        return {
            'text': text,
            'action': 'memory_compact',
            'reply': reply_msg,
            'silent': False,
            'latencyMs': latency_ms
        }

    # 2. Check wake word & silent transcribe
    silent = False
    wake_detected = True
    if SILENT_TRANSCRIBE:
        clean_wake = WAKE_WORD.strip().lower()
        if clean_wake and clean_wake in lower_text:
            silent = False
            wake_detected = True
        else:
            silent = True
            wake_detected = False
            if labeled and text:
                append_to_transcribe_file(ROOT, labeled)

    return {
        'text': text,
        'labeled': labeled,
        'silent': silent,
        'wakeWordDetected': wake_detected,
        'latencyMs': latency_ms
    }


def update_env(updates: dict[str, str]):
    env_path = ROOT / '.env'
    lines = []
    if env_path.exists():
        lines = env_path.read_text(encoding='utf-8-sig').splitlines()
    existing_keys = set()
    new_lines = []
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith('#') and '=' in stripped:
            key, _ = stripped.split('=', 1)
            key = key.strip()
            if key in updates:
                new_lines.append(f"{key}={updates[key]}")
                existing_keys.add(key)
                continue
        new_lines.append(line)
    for key, val in updates.items():
        if key not in existing_keys:
            new_lines.append(f"{key}={val}")
    env_path.write_text('\n'.join(new_lines) + '\n', encoding='utf-8')


class LLMTestInput(BaseModel):
    baseUrl: str = Field(min_length=1)
    apiKey: str = Field(min_length=1)


@app.post('/api/llm/test')
async def test_llm(data: LLMTestInput, request: Request):
    url = data.baseUrl.rstrip('/') + '/models'
    key = data.apiKey.strip()
    if key.startswith('***') or '...' in key:
        key = API_KEY
    if not key:
        raise HTTPException(400, 'API Key tidak boleh kosong.')

    try:
        res = await request.app.state.http.get(
            url,
            headers={'Authorization': f'Bearer {key}'},
            timeout=15.0
        )
    except httpx.TimeoutException:
        raise HTTPException(504, 'Koneksi ke endpoint AI timeout (lebih dari 15 detik).')
    except httpx.HTTPError as e:
        raise HTTPException(502, f'Gagal menghubungi endpoint AI: {e}')

    if res.status_code != 200:
        raise HTTPException(res.status_code, f'Endpoint AI mengembalikan status HTTP {res.status_code}: {res.text[:200]}')

    try:
        body = res.json()
    except Exception:
        raise HTTPException(502, 'Format balasan dari endpoint /models bukan JSON yang valid.')

    models: list[str] = []
    if 'data' in body and isinstance(body['data'], list):
        for item in body['data']:
            if isinstance(item, dict) and 'id' in item:
                models.append(str(item['id']))
    elif 'models' in body and isinstance(body['models'], list):
        for item in body['models']:
            if isinstance(item, dict):
                m_id = item.get('id') or item.get('name')
                if m_id:
                    models.append(str(m_id))

    cleaned_models = []
    for m in models:
        cleaned = m.removeprefix('models/')
        if cleaned not in cleaned_models:
            cleaned_models.append(cleaned)

    # If gemini-3.1-flash-lite is available, prioritize it near the top
    target = 'gemini-3.1-flash-lite'
    if target in cleaned_models:
        cleaned_models.remove(target)
        cleaned_models.insert(0, target)

    return {
        'ok': True,
        'count': len(cleaned_models),
        'models': cleaned_models,
        'recommended': target if target in cleaned_models else (cleaned_models[0] if cleaned_models else '')
    }


class SettingsInput(BaseModel):
    sttModel: Literal['base', 'small'] = 'base'
    device: Literal['cpu', 'cuda:0', 'cuda:1'] = 'cpu'
    diarization: bool = False
    wakeWord: str = 'Hai Anna'
    silentTranscribe: bool = False
    systemPrompt: str | None = Field(default=None, max_length=6000)
    aiBaseUrl: str | None = None
    aiApiKey: str | None = None
    aiModel: str | None = None


@app.get('/api/settings')
async def get_settings():
    return {
        'aiBaseUrl': BASE_URL,
        'aiApiKeyMasked': (API_KEY[:6] + '...' + API_KEY[-4:]) if len(API_KEY) > 10 else ('***' if API_KEY else ''),
        'aiModel': AI_MODEL,
        'sttModel': STT_MODEL,
        'device': STT_DEVICE,
        'diarization': DIARIZATION_ENABLED,
        'wakeWord': WAKE_WORD,
        'silentTranscribe': SILENT_TRANSCRIBE,
        'systemPrompt': SYSTEM_PROMPT,
        'modelsAvailable': [
            {'id': 'base', 'label': 'faster-whisper-base (~74M params, Cepat)', 'downloaded': (ROOT / 'models/faster-whisper-base/model.bin').exists()},
            {'id': 'small', 'label': 'faster-whisper-small (~244M params, Lebih Akurat)', 'downloaded': (ROOT / 'models/faster-whisper-small/model.bin').exists()}
        ],
        'hardwareOptions': [
            {'id': 'cpu', 'label': 'CPU (Hemat Daya / RAM int8)'},
            {'id': 'cuda:0', 'label': 'GPU 0: NVIDIA RTX 3060 (Layar / LLM Utama)'},
            {'id': 'cuda:1', 'label': 'GPU 1: NVIDIA RTX 3060 (Sekunder / Khusus Audio)'}
        ]
    }


@app.post('/api/settings')
async def update_settings(data: SettingsInput):
    global STT_MODEL, STT_DEVICE, DIARIZATION_ENABLED, WAKE_WORD, SILENT_TRANSCRIBE, SYSTEM_PROMPT
    global stt_model, stt_loaded_model, stt_loaded_device, stt_loaded_compute
    global BASE_URL, API_KEY, AI_MODEL

    # Validate the selected model before changing or persisting any setting. This
    # prevents a missing model from silently falling back to the base model.
    try:
        resolve_stt_model_path(data.sttModel)
    except FileNotFoundError as exc:
        raise HTTPException(422, str(exc)) from exc

    requested_model = data.sttModel
    requested_device = data.device
    needs_reload = (
        stt_model is None or
        stt_loaded_model != requested_model or
        stt_loaded_device != requested_device
    )
    load_started = time.monotonic()

    if needs_reload:
        try:
            await preload_stt_model(requested_model, requested_device)
        except Exception as exc:
            raise HTTPException(
                503,
                f'Model STT {requested_model} gagal dimuat pada {requested_device}: {exc}'
            ) from exc

    STT_MODEL = requested_model
    STT_DEVICE = requested_device
    DIARIZATION_ENABLED = data.diarization
    WAKE_WORD = data.wakeWord.strip() or 'Hai Anna'
    SILENT_TRANSCRIBE = data.silentTranscribe
    # An omitted value means an older client is applying only its existing
    # settings. In that case preserve the current prompt instead of resetting it.
    if data.systemPrompt is not None:
        SYSTEM_PROMPT = normalize_system_prompt(data.systemPrompt)

    env_updates = {}
    if data.aiBaseUrl:
        BASE_URL = data.aiBaseUrl.rstrip('/')
        env_updates['AI_BASE_URL'] = BASE_URL
    if data.aiApiKey and not data.aiApiKey.startswith('***') and '...' not in data.aiApiKey:
        API_KEY = data.aiApiKey.strip()
        env_updates['AI_API_KEY'] = API_KEY
    if data.aiModel:
        AI_MODEL = data.aiModel.strip()
        env_updates['AI_MODEL'] = AI_MODEL
    env_updates.update({
        'STT_MODEL': STT_MODEL,
        'STT_DEVICE': STT_DEVICE,
        'DIARIZATION_ENABLED': 'true' if DIARIZATION_ENABLED else 'false',
        'WAKE_WORD': WAKE_WORD,
        'SILENT_TRANSCRIBE': 'true' if SILENT_TRANSCRIBE else 'false',
        # `.env` is line-oriented. JSON quoting preserves line breaks, quotes,
        # and prompt punctuation without turning any of them into new keys.
        'SYSTEM_PROMPT': json.dumps(SYSTEM_PROMPT, ensure_ascii=False),
    })
    update_env(env_updates)

    return {
        'ok': True,
        'message': 'Pengaturan berhasil diperbarui; System Prompt tersimpan dan model STT sudah siap digunakan.',
        'stt': {
            'model': STT_MODEL,
            'device': STT_DEVICE,
            'compute': stt_loaded_compute,
            'loaded': stt_model is not None,
            'loadMs': round((time.monotonic() - load_started) * 1000),
        },
        'systemPrompt': SYSTEM_PROMPT,
    }


@app.post('/api/memory/compact')
async def memory_compact(request: Request):
    return await compact_transcripts(ROOT, request.app.state.http, BASE_URL, API_KEY, AI_MODEL)


if (ROOT / 'dist').exists():
    app.mount('/app', StaticFiles(directory=ROOT / 'dist', html=True), name='ui')
else:
    @app.get('/app')
    async def missing_build():
        return JSONResponse({'detail': 'Jalankan npm run build terlebih dahulu.'}, status_code=503)


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=int(os.getenv('PORT', '4317')), workers=1, access_log=False)
