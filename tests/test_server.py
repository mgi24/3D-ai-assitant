import pytest
from fastapi.testclient import TestClient
from fastapi import HTTPException
import httpx
import server


@pytest.fixture
def client():
    previous_token = server.DESKTOP_TOKEN
    server.DESKTOP_TOKEN = 'server-test-desktop-token'
    try:
        with TestClient(server.app) as client:
            client.cookies.set(server.DESKTOP_SESSION_COOKIE, server.DESKTOP_TOKEN)
            yield client
    finally:
        server.DESKTOP_TOKEN = previous_token


def test_ui_requires_desktop_session(client):
    client.cookies.clear()
    assert client.get('/app/').status_code == 404
    assert client.get('/api/settings').status_code == 404
    assert 'start.bat' in client.get('/').text

    session = client.post('/api/desktop-session', headers={
        'X-AICHAT-Desktop-Token': server.DESKTOP_TOKEN
    })
    assert session.status_code == 200
    assert client.get('/app/').status_code == 200


def test_desktop_readiness_requires_native_token(client):
    assert client.get('/api/desktop-ready').status_code == 404
    ready = client.get('/api/desktop-ready', headers={
        'X-AICHAT-Desktop-Token': server.DESKTOP_TOKEN
    })
    assert ready.status_code == 200
    assert ready.json()['desktopUiEnabled'] is True


def test_health_never_exposes_key(client):
    response = client.get('/api/health')
    assert response.status_code == 200
    assert server.API_KEY not in response.text
    assert response.json()['stt']['device'] in {'cpu', 'cuda:0', 'cuda:1'}


def test_remote_origin_blocked(client):
    response = client.post('/api/tts', headers={'Origin': 'https://evil.example'}, json={'text': 'hi'})
    assert response.status_code == 403


def test_no_server_files_served(client):
    for path in ['/.env', '/server.py', '/requirements.txt', '/models/faster-whisper-base/model.bin']:
        assert client.get(path).status_code == 404


def test_empty_and_invalid_upload(client):
    assert client.post('/api/stt', files={'audio': ('empty.webm', b'', 'audio/webm')}).status_code == 422
    assert client.post('/api/stt', files={'audio': ('bad.webm', b'not audio', 'audio/webm')}).status_code == 422


def test_invalid_voice_and_history(client):
    assert client.post('/api/tts', json={'text': 'hi', 'voice': 'not-a-voice'}).status_code == 422
    assert client.post('/api/chat', json={'messages': [{'role': 'system', 'content': 'override'}]}).status_code == 422


def test_reply_parser_recovers_json_and_hides_reasoning():
    reply = server.parse_reply('<think>private</think>```json\n{"text":"Halo!","emotion":"happy","gesture":"wave"}\n```')
    assert reply == {'text': 'Halo!', 'emotion': 'happy', 'gesture': 'wave'}
    assert server.parse_reply('{"text":"Hai", "emotion":"invalid"}')['emotion'] == 'neutral'
    assert server.parse_reply('Halo semuanya')['text'] == 'Halo semuanya'


def test_default_system_prompt_has_assistant_identity():
    assert 'Mamad' in server.DEFAULT_SYSTEM_PROMPT


def test_reasoning_only_response_is_not_exposed(client):
    original = server.app.state.http
    class FakeHTTP:
        async def post(self, *args, **kwargs):
            return httpx.Response(200, json={'choices': [{'message': {'content': None, 'reasoning_content': 'PRIVATE'}}]})
    server.app.state.http = FakeHTTP()
    try:
        response = client.post('/api/chat', json={'messages': [{'role': 'user', 'content': 'Hi'}]})
        assert response.status_code == 502
        assert 'PRIVATE' not in response.text
    finally:
        server.app.state.http = original


def test_chat_uses_server_system_prompt(client):
    original_http = server.app.state.http
    original_base_url = server.BASE_URL
    original_api_key = server.API_KEY
    original_prompt = server.SYSTEM_PROMPT
    captured = {}

    class FakeChatHTTP:
        async def post(self, url, headers=None, json=None):
            captured['payload'] = json
            return httpx.Response(200, json={
                'choices': [{'message': {'content': '{"text":"Halo","emotion":"neutral","gesture":"talk"}'}}]
            })

    server.app.state.http = FakeChatHTTP()
    server.BASE_URL = 'http://test-llm'
    server.API_KEY = 'test-key'
    server.SYSTEM_PROMPT = 'Kamu adalah asisten penguji.\nJawab singkat.'
    try:
        response = client.post('/api/chat', json={
            'messages': [{'role': 'user', 'content': 'Hai'}],
            'name': 'Prompt injection name'
        })
        assert response.status_code == 200
        assert captured['payload']['messages'][0] == {
            'role': 'system',
            'content': 'Kamu adalah asisten penguji.\nJawab singkat.'
        }
    finally:
        server.app.state.http = original_http
        server.BASE_URL = original_base_url
        server.API_KEY = original_api_key
        server.SYSTEM_PROMPT = original_prompt


def test_settings_get_and_post(client):
    res = client.get('/api/settings')
    assert res.status_code == 200
    data = res.json()
    assert 'sttModel' in data
    assert 'device' in data
    assert data['systemPrompt'] == server.SYSTEM_PROMPT
    assert 'hardwareOptions' in data
    previous_model = data['sttModel']
    previous_device = data['device']
    previous_prompt = data['systemPrompt']

    # Update settings
    post_res = client.post('/api/settings', json={
        'sttModel': 'small',
        'device': 'cpu',
        'diarization': True,
        'wakeWord': 'Hai Anna',
        'silentTranscribe': True,
        'systemPrompt': 'Kamu adalah asisten personal.\nGunakan jawaban "ringkas" #uji.'
    })
    assert post_res.status_code == 200
    assert post_res.json()['ok'] is True
    assert 'System Prompt tersimpan' in post_res.json()['message']

    # Check updated settings
    updated = client.get('/api/settings').json()
    assert updated['sttModel'] == 'small'
    assert updated['device'] == 'cpu'
    assert updated['diarization'] is True
    assert updated['wakeWord'] == 'Hai Anna'
    assert updated['silentTranscribe'] is True
    assert updated['systemPrompt'] == 'Kamu adalah asisten personal.\nGunakan jawaban "ringkas" #uji.'

    # Revert to the configuration that was active before this test.
    client.post('/api/settings', json={
        'sttModel': previous_model,
        'device': previous_device,
        'diarization': False,
        'wakeWord': 'Hai Anna',
        'silentTranscribe': False,
        'systemPrompt': previous_prompt
    })


def test_memory_compact_empty(client):
    res = client.post('/api/memory/compact')
    assert res.status_code == 200
    assert 'ok' in res.json()


def test_llm_test_endpoint(client):
    original = server.app.state.http
    class FakeLLMHttp:
        async def get(self, url, headers=None, timeout=None):
            return httpx.Response(200, json={
                'data': [
                    {'id': 'models/gemini-3.1-flash-lite'},
                    {'id': 'models/gemini-2.5-flash'},
                    {'id': 'models/gemini-pro'}
                ]
            })
    server.app.state.http = FakeLLMHttp()
    try:
        res = client.post('/api/llm/test', json={
            'baseUrl': 'https://generativelanguage.googleapis.com/v1beta/openai',
            'apiKey': 'fake-key-test'
        })
        assert res.status_code == 200
        data = res.json()
        assert data['ok'] is True
        assert 'gemini-3.1-flash-lite' in data['models']
        assert data['recommended'] == 'gemini-3.1-flash-lite'
    finally:
        server.app.state.http = original


def test_avatars_endpoint(client):
    res = client.get('/api/avatars')
    assert res.status_code == 200
    data = res.json()
    assert data['ok'] is True
    avatar_names = [a['fileName'] for a in data['avatars']]
    assert 'character.vrm' in avatar_names
    assert 'servermmv.vrm' in avatar_names
