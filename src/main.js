import './style.css';
import { AvatarStage } from './avatar.js';

const $ = id => document.getElementById(id);
const isPoseWindow = new URLSearchParams(location.search).get('poseBrowser') === '1';
if (isPoseWindow) document.body.classList.add('pose-window');
const DEFAULT_SYSTEM_PROMPT = 'You are Mamad, a friendly virtual avatar assistant speaking naturally in Indonesian. Use the language requested by the user. Reply briefly in 1-3 conversational sentences unless more detail is requested. You can speak, blink and gesture through a VRoid avatar. Be honest: you cannot see, control the PC, open files, or use tools. Return ONLY a JSON object with keys text (your spoken answer, no markdown), emotion (neutral, happy, sad, relaxed, surprised, angry), gesture (talk, wave, nod, think, none). Never include internal reasoning.';
const defaults = { name: 'Mamad', systemPrompt: DEFAULT_SYSTEM_PROMPT, voice: 'id-ID-GadisNeural', rate: 0, fps: 30, device: '', avatarModel: 'avatar/character.vrm' };
let settings;
try {
  settings = { ...defaults, ...JSON.parse(localStorage.getItem('aichat-settings') || '{}') };
  if (!String(settings.systemPrompt || '').trim()) settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
}
catch { settings = { ...defaults }; }

let state = 'idle', health, avatar, posePreviewAvatar, context, analyser, source, finishAudio;
let sttStartupChecked = false, startupNoticeActive = false, settingsApplying = false;
let recorder, micStream, micSource, micAnalyser, micTimer, micVADFrame, recordingStarted;
let voiceDetected = false, lastVoiceAt = 0;
let runId = 0, controller, audioFrame, autoTimer;
let history = [];
const labels = {
  idle: 'Siap mendengarkanmu',
  listening: 'Mendengarkan…',
  transcribing: 'Memuat STT & memahami suara…',
  thinking: 'Sedang memikirkan jawaban…',
  preparing: 'Menyiapkan suara…',
  speaking: 'Sedang berbicara…'
};

function notice(text = '') {
  const el = $('notice');
  if (el) {
    el.textContent = text;
    el.hidden = !text;
  }
}

function sttStartupBlocked() {
  const stt = health?.stt;
  return settingsApplying || !sttStartupChecked || !!stt?.loading || !!stt?.loadError;
}

function setState(next) {
  state = next;
  document.body.dataset.state = state;
  if ($('state-label')) $('state-label').textContent = labels[state];
  const busy = ['transcribing', 'thinking', 'preparing'].includes(state);
  const sttBlocked = sttStartupBlocked();
  if ($('mic-button')) $('mic-button').disabled = busy || sttBlocked;
  if ($('desktop-mic-btn')) {
    $('desktop-mic-btn').disabled = busy || sttBlocked;
    $('desktop-mic-btn').classList.toggle('active', state === 'listening');
  }
  if ($('send-button')) $('send-button').disabled = busy || state === 'listening';
  if ($('mic-label')) {
    $('mic-label').textContent = state === 'listening' ? 'Selesai bicara' : state === 'speaking' ? 'Sela & bicara' : busy ? labels[state] : 'Klik untuk bicara';
  }
  if ($('stop-button')) $('stop-button').disabled = state === 'idle';
  if ($('recording-preview')) $('recording-preview').hidden = state !== 'listening';
  if ($('desktop-status-text')) {
    if (state !== 'idle') {
      $('desktop-status-text').textContent = labels[state];
    } else if (settingsApplying || !sttStartupChecked || health?.stt?.loading) {
      $('desktop-status-text').textContent = 'Memuat model STT…';
    } else if (health?.stt?.loadError) {
      $('desktop-status-text').textContent = 'STT gagal dimuat';
    } else {
      $('desktop-status-text').textContent = 'AICHAT';
    }
  }
  avatar?.setState(state);
}

async function api(path, options = {}) {
  const response = await fetch('/api/' + path, options);
  if (!response.ok) {
    let detail;
    try { detail = (await response.json()).detail; } catch { }
    throw Error(typeof detail === 'string' ? detail : `Permintaan gagal (${response.status}).`);
  }
  return response;
}

function appendMessage(role, text, meta = '') {
  const messagesEl = $('messages');
  if (!messagesEl) return null;
  const article = document.createElement('article');
  article.className = `message ${role}`;
  const by = document.createElement('span');
  by.className = 'message-by';
  by.textContent = role === 'user' ? 'KAMU' : settings.name.toUpperCase();
  const p = document.createElement('p');
  p.textContent = text;
  const time = document.createElement('span');
  time.className = 'message-time';
  time.textContent = meta || new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  article.append(by, p, time);
  messagesEl.append(article);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return article;
}

async function unlockAudio() {
  context ||= new AudioContext();
  if (context.state === 'suspended') await context.resume();
}

function cleanupMic() {
  clearInterval(micTimer);
  cancelAnimationFrame(micVADFrame);
  micStream?.getTracks().forEach(track => track.stop());
  micSource?.disconnect();
  micAnalyser?.disconnect();
  micStream = micSource = micAnalyser = null;
  micVADFrame = null;
  voiceDetected = false;
  lastVoiceAt = 0;
}

function stopAll(disableAuto = true) {
  runId++;
  clearTimeout(autoTimer);
  controller?.abort();
  if (recorder && recorder.state !== 'inactive') {
    recorder.onstop = null;
    recorder.stop();
  }
  cleanupMic();
  if (source) { try { source.stop(); } catch { } source = null; }
  finishAudio?.();
  finishAudio = null;
  speechSynthesis.cancel();
  cancelAnimationFrame(audioFrame);
  if (avatar) avatar.mouth = 0;
  if (disableAuto && $('auto-talk')) $('auto-talk').checked = false;
  setState('idle');
}

async function speak(text, id) {
  await unlockAudio();
  if (id !== runId) return;
  if (settings.voice === 'system' || settings.voice === 'browser') return systemSpeak(text, id);
  setState('preparing');
  let buffer;
  try {
    const response = await api('tts', {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: settings.voice, rate: Number(settings.rate) })
    });
    buffer = await context.decodeAudioData(await response.arrayBuffer());
  } catch (err) {
    if (id !== runId || err.name === 'AbortError') return;
    notice('Suara online gagal. Mencoba suara bawaan sistem; gerak mulut cadangan berupa perkiraan.');
    return systemSpeak(text, id);
  }
  if (id !== runId) return;
  analyser ||= context.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.55;
  source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(analyser);
  analyser.disconnect();
  analyser.connect(context.destination);
  setState('speaking');
  const samples = new Float32Array(analyser.fftSize);
  const updateMouth = () => {
    if (id !== runId || state !== 'speaking') return;
    analyser.getFloatTimeDomainData(samples);
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    if (avatar) avatar.mouth = Math.min(1, Math.max(0, rms - 0.008) * 7.5);
    audioFrame = requestAnimationFrame(updateMouth);
  };
  await new Promise(resolve => {
    const currentSource = source;
    finishAudio = resolve;
    currentSource.onended = () => { currentSource.disconnect(); resolve(); };
    currentSource.start();
    updateMouth();
  });
  finishAudio = null;
  source = null;
  cancelAnimationFrame(audioFrame);
  if (avatar) avatar.mouth = 0;
}

function systemSpeak(text, id) {
  return new Promise(resolve => {
    const voices = speechSynthesis.getVoices();
    if (!voices.length) { notice('Suara bawaan sistem tidak tersedia. Jawaban teks tetap bisa dibaca.'); return resolve(); }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'id-ID';
    utterance.voice = voices.find(v => v.lang.startsWith('id')) || voices[0];
    utterance.rate = 1 + Number(settings.rate) / 100;
    const done = () => { clearInterval(timer); if (avatar) avatar.mouth = 0; resolve(); };
    const timer = setInterval(() => { if (avatar) avatar.mouth = state === 'speaking' ? 0.15 + Math.random() * 0.4 : 0; }, 100);
    finishAudio = done;
    utterance.onstart = () => { if (id === runId) setState('speaking'); };
    utterance.onend = done;
    utterance.onerror = done;
    speechSynthesis.speak(utterance);
  });
}

function continueListening(id) {
  if (id === runId && $('auto-talk')?.checked) {
    autoTimer = setTimeout(() => { if (id === runId && state === 'idle') startRecording(); }, 450);
  }
}

async function sendMessage(text) {
  text = text.trim();
  if (!text) return;
  stopAll(false);
  const conv = $('conversation-drawer');
  if (conv && conv.classList.contains('desktop-closed')) {
    conv.classList.remove('desktop-closed');
    $('desktop-chat-toggle')?.classList.add('active');
  }
  notice('');
  appendMessage('user', text);
  if ($('chat-input')) $('chat-input').value = '';
  history.push({ role: 'user', content: text });
  if (history.length > 12) history = history.slice(-12);
  const id = ++runId;
  controller = new AbortController();
  setState('thinking');
  try {
    const response = await api('chat', {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history })
    });
    const reply = await response.json();
    if (id !== runId) return;
    history.push({ role: 'assistant', content: reply.text });
    avatar?.react(reply.emotion, reply.gesture);
    appendMessage('assistant', reply.text);
    await speak(reply.text, id);
    if (id === runId) { setState('idle'); continueListening(id); }
  } catch (err) {
    if (id !== runId || err.name === 'AbortError') return;
    notice(err.message);
    setState('idle');
  }
}

async function startRecording() {
  if (sttStartupBlocked()) {
    await updateHealth();
    if (sttStartupBlocked()) {
      notice(health?.stt?.loadError
        ? `Model STT gagal dimuat: ${health.stt.loadError}`
        : '⏳ Model STT masih dimuat. Tunggu sampai status AICHAT siap.');
      return;
    }
  }
  stopAll(false);
  await unlockAudio();
  notice('');
  try {
    const constraints = {
      audio: {
        deviceId: settings.device ? { exact: settings.device } : undefined,
        echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1
      }
    };
    micStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch {
    notice('Tidak dapat mengakses mikrofon. Periksa izin AICHAT di dialog Windows dan mikrofon default sistem.');
    return;
  }
  micSource = context.createMediaStreamSource(micStream);
  micAnalyser = context.createAnalyser();
  micAnalyser.fftSize = 256;
  micSource.connect(micAnalyser);
  const dataArray = new Uint8Array(micAnalyser.frequencyBinCount);
  const timeData = new Uint8Array(micAnalyser.fftSize);
  const speechThreshold = 0.02;
  const updateLevel = () => {
    if (state !== 'listening') return;
    micAnalyser.getByteFrequencyData(dataArray);
    const avg = dataArray.reduce((sum, v) => sum + v, 0) / dataArray.length;
    if ($('mic-level')) $('mic-level').style.width = Math.min(100, Math.round((avg / 128) * 100)) + '%';
    micAnalyser.getByteTimeDomainData(timeData);
    const rms = Math.sqrt(timeData.reduce((sum, value) => {
      const sample = (value - 128) / 128;
      return sum + sample * sample;
    }, 0) / timeData.length);
    const now = performance.now();
    if (rms >= speechThreshold) {
      voiceDetected = true;
      lastVoiceAt = now;
      if ($('recording-label')) $('recording-label').textContent = 'Berhenti otomatis saat diam…';
    } else if (voiceDetected && now - lastVoiceAt >= 1200 && Date.now() - recordingStarted >= 650) {
      // A completed utterance is submitted after roughly 1.2 seconds of silence.
      finishRecording();
      return;
    }
    micVADFrame = requestAnimationFrame(updateLevel);
  };
  const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type)) || '';
  recorder = new MediaRecorder(micStream, mimeType ? { mimeType } : {});
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = () => {
    const recordedType = recorder.mimeType || mimeType || 'audio/webm';
    cleanupMic();
    if (state === 'listening' || state === 'transcribing') {
      transcribe(new Blob(chunks, { type: recordedType }));
    }
  };
  recorder.start(250);
  recordingStarted = Date.now();
  voiceDetected = false;
  lastVoiceAt = 0;
  if ($('recording-label')) $('recording-label').textContent = 'Menunggu suara…';
  setState('listening');
  updateLevel();
  micTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recordingStarted) / 1000);
    const min = Math.floor(elapsed / 60);
    const sec = String(elapsed % 60).padStart(2, '0');
    if ($('recording-time')) $('recording-time').textContent = `${min}:${sec}`;
    if (elapsed >= 60) finishRecording();
  }, 250);
}

function finishRecording() {
  if (recorder && recorder.state === 'recording') {
    setState('transcribing');
    recorder.stop();
  }
}

async function transcribe(blob) {
  const id = ++runId;
  const requestController = new AbortController();
  controller = requestController;
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    requestController.abort();
  }, 180000);
  setState('transcribing');
  notice('Memuat model STT dan memahami suara…');
  const form = new FormData();
  form.append('audio', blob, 'input.webm');
  try {
    const response = await api('stt', { method: 'POST', body: form, signal: requestController.signal });
    const data = await response.json();
    if (id !== runId) return;
    const text = data.text?.trim();

    if (data.action === 'memory_compact') {
      appendMessage('assistant', `[Memori Berhasil Dirangkum]\n${data.reply}`, 'Sistem');
      await speak(data.reply, id);
      setState('idle');
      return;
    }

    if (data.silent) {
      if (text) {
        notice(`[Silent Mode] Audio dicatat ke file SRT: "${text.slice(0, 35)}..."`);
        setTimeout(() => notice(''), 4000);
      }
      setState('idle');
      continueListening(id);
      return;
    }

    if (!text) {
      notice('Suara belum terdengar jelas. Coba ulangi dengan suara lebih dekat ke mic.');
      setState('idle');
      continueListening(id);
      return;
    }

    sendMessage(text);
  } catch (err) {
    if (id !== runId || (err.name === 'AbortError' && !timedOut)) return;
    if (timedOut) {
      notice('STT belum selesai setelah 3 menit. Periksa model/GPU di Pengaturan, lalu coba lagi.');
    } else {
      notice(err.message);
    }
    setState('idle');
  } finally {
    clearTimeout(timeoutId);
  }
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');
    const select = $('device-setting');
    if (!select) return;
    const current = settings.device;
    select.replaceChildren();
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Default sistem';
    select.appendChild(defaultOption);
    audioInputs.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Mikrofon ${index + 1}`;
      select.appendChild(option);
    });
    select.value = audioInputs.some(d => d.deviceId === current) ? current : '';
  } catch { }
}

function saveSettings() {
  settings = {
    // The visible assistant identity stays fixed for the avatar UI. Behaviour
    // and personality are edited through the server-backed System Prompt.
    name: settings.name || 'Mamad',
    systemPrompt: $('system-prompt-setting')?.value.trim() || DEFAULT_SYSTEM_PROMPT,
    voice: $('voice-setting').value,
    rate: Number($('rate-setting').value),
    fps: Number($('fps-setting').value),
    device: $('device-setting').value,
    avatarModel: settings.avatarModel || 'avatar/character.vrm'
  };
  localStorage.setItem('aichat-settings', JSON.stringify(settings));
  if ($('companion-name')) $('companion-name').textContent = settings.name;
  if ($('rate-value')) $('rate-value').textContent = `${settings.rate}%`;
  if (avatar) avatar.fps = settings.fps;
}

let serverSettings = {
  aiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  aiApiKey: '',
  aiModel: 'gemini-3.1-flash-lite',
  sttModel: 'base',
  device: 'cpu',
  diarization: false,
  wakeWord: 'Hai Anna',
  silentTranscribe: false,
  systemPrompt: DEFAULT_SYSTEM_PROMPT
};

const POSE_EDITOR_BONES = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightUpperArm', 'rightLowerArm', 'rightHand'
];
const poseManager = {
  initialized: false,
  draft: null,
  originalName: '',
  selectedName: '',
  selectedBone: 'head',
  selectedTime: 0,
  selectedTimes: new Set(),
  editorMode: 'rotate',
  previewing: false,
  previewPaused: false,
  editorDragging: false,
  keyframeDragging: false,
  isNew: false
};

let poseKeyframeClipboard = null;

function poseManagerIsTimeSelected(time) {
  const t = Number(time);
  for (const sel of poseManager.selectedTimes) {
    if (Math.abs(sel - t) < 0.006) return true;
  }
  return false;
}

const poseHistory = {
  undo: [],
  redo: [],
  pending: null,
  limit: 60
};

function poseManagerHistoryReset() {
  poseHistory.undo = [];
  poseHistory.redo = [];
  poseHistory.pending = null;
  poseManager.editorDragging = false;
  poseManager.keyframeDragging = false;
  poseManager.selectedTimes.clear();
  poseManagerSetPlaybackControls();
}

function poseManagerHistoryBegin() {
  if (!poseManager.draft || poseHistory.pending) return;
  poseHistory.pending = clonePose(poseManager.draft);
  poseManagerSetPlaybackControls();
}

function poseManagerHistoryCommit() {
  if (!poseHistory.pending || !poseManager.draft) return;
  const before = poseHistory.pending;
  poseHistory.pending = null;
  if (JSON.stringify(before) !== JSON.stringify(poseManager.draft)) {
    poseHistory.undo.push(before);
    if (poseHistory.undo.length > poseHistory.limit) poseHistory.undo.shift();
    poseHistory.redo = [];
  }
  poseManagerSetPlaybackControls();
}

function poseManagerHistoryRun(mutator) {
  poseManagerHistoryBegin();
  try { mutator(); } finally { poseManagerHistoryCommit(); }
}

function poseManagerRestoreHistorySnapshot(snapshot) {
  poseManager.draft = clonePose(snapshot);
  poseManager.selectedTimes.clear();
  const dur = Number(snapshot.duration) || 0.1;
  const durInput = $('pose-duration');
  if (durInput) durInput.value = dur.toFixed(2);
  posePreviewAvatar?.setPoseClip(poseManager.draft);
  poseManagerRenderTimeline();
}

function poseManagerUndo() {
  if (!poseManager.draft || !poseHistory.undo.length) return;
  poseHistory.pending = null;
  poseHistory.redo.push(clonePose(poseManager.draft));
  poseManagerRestoreHistorySnapshot(poseHistory.undo.pop());
  poseManagerSetStatus('Perubahan pose dibatalkan (Undo).');
  poseManagerSetPlaybackControls();
}

function poseManagerRedo() {
  if (!poseManager.draft || !poseHistory.redo.length) return;
  poseHistory.pending = null;
  poseHistory.undo.push(clonePose(poseManager.draft));
  poseManagerRestoreHistorySnapshot(poseHistory.redo.pop());
  poseManagerSetStatus('Perubahan pose dikembalikan (Redo).');
  poseManagerSetPlaybackControls();
}

function ensurePosePreviewAvatar() {
  if (isPoseWindow && avatar) {
    posePreviewAvatar = avatar;
    avatar.paused = false;
    avatar.setArmatureEditorVisible?.(!!poseManager.draft);
    avatar.resize();
    poseManagerSetStatus('Preview avatar siap.');
    poseManagerSetPlaybackControls();
    poseManagerRenderTimeline();
    return;
  }
  if (posePreviewAvatar) {
    posePreviewAvatar.paused = false;
    posePreviewAvatar.setArmatureEditorVisible?.(!!poseManager.draft);
    return;
  }
  const stage = $('pose-preview-stage');
  if (!stage) return;
  try {
    const previewModelUrl = avatar?.currentModelUrl || (settings.avatarModel
      ? (settings.avatarModel.startsWith('http') || settings.avatarModel.startsWith('/')
          ? settings.avatarModel
          : `${import.meta.env.BASE_URL}${settings.avatarModel.replace(/^\/+/, '')}`)
      : undefined);

    posePreviewAvatar = new AvatarStage(stage, () => {
      posePreviewAvatar.paused = false;
      posePreviewAvatar.setArmatureEditorVisible?.(!!poseManager.draft);
      poseManagerRefreshList(poseManager.selectedName);
      if (poseManager.draft) {
        poseManagerPreview();
      }
      poseManagerSetStatus('Preview avatar siap.');
    }, error => {
      poseManagerSetStatus(`Preview avatar gagal dimuat: ${error.message || error}`, true);
    }, {
      modelUrl: previewModelUrl,
      enablePan: true,
      enableArmatureEditor: true,
      onEditorBoneSelect: poseManagerSelectBone,
      onEditorDrag: poseManagerHandleEditorDrag,
      onEditorTransform: poseManagerApplyEditorTransform
    });
    posePreviewAvatar.fps = settings.fps;
  } catch (error) {
    poseManagerSetStatus(`Preview avatar gagal dimuat: ${error.message || error}`, true);
  }
}

function openPoseBrowser() {
  if (!isPoseWindow) $('settings-dialog')?.close();
  if (!isPoseWindow && window.aichatDesktop?.openPoseBrowser) {
    window.aichatDesktop.openPoseBrowser();
    return;
  }
  const dialog = $('pose-browser-dialog');
  if (!dialog) return;
  dialog.showModal();
  ensurePosePreviewAvatar();
  poseManagerInitialize();
  poseManagerStartTimeline();
}

function closePoseBrowser() {
  poseManagerCancelKeyframeDrag?.();
  poseManagerStopPreview();
  poseManagerStopTimeline();
  if (posePreviewAvatar) {
    posePreviewAvatar.setArmatureEditorVisible?.(false);
    posePreviewAvatar.paused = true;
  }
  if (isPoseWindow) {
    window.aichatDesktop?.closePoseBrowser?.();
    return;
  }
  $('pose-browser-dialog')?.close();
}

function clonePose(value) {
  return JSON.parse(JSON.stringify(value));
}

function poseManagerSetStatus(message, error = false) {
  const el = $('pose-manager-status');
  if (el) {
    el.textContent = message;
    el.style.color = error ? '#a34b3f' : '#819582';
  }
}

let poseTimelineFrame = 0;

function poseManagerSetPlaybackControls() {
  const playbackButton = $('pose-preview-btn');
  if (playbackButton) {
    const paused = poseManager.previewPaused;
    playbackButton.textContent = paused ? '▶ Resume' : '⏸ Pause';
    playbackButton.title = `${paused ? 'Lanjutkan' : 'Jeda'} preview pose (Space)`;
    playbackButton.setAttribute('aria-pressed', String(paused));
    playbackButton.disabled = !poseManager.previewing || !posePreviewAvatar?.poseController;
  }
  const copyButton = $('pose-copy-keyframe-btn');
  if (copyButton) {
    copyButton.disabled = !poseManager.draft || (!poseManager.selectedTimes.size && !poseManagerHasKeyframeAtTime());
  }
  const pasteButton = $('pose-paste-keyframe-btn');
  if (pasteButton) {
    pasteButton.disabled = !poseManager.draft || !poseKeyframeClipboard;
  }
  const resetBoneButton = $('pose-reset-bone-btn');
  if (resetBoneButton) {
    resetBoneButton.disabled = !poseManager.draft
      || !poseManager.selectedBone
      || !posePreviewAvatar?.getEditorBoneRestTransform?.(poseManager.selectedBone);
  }
  const deleteKeyframeButton = $('pose-preview-delete-keyframe-btn');
  if (deleteKeyframeButton) {
    deleteKeyframeButton.disabled = !poseManager.draft || (!poseManager.selectedTimes.size && !poseManagerHasKeyframeAtTime());
  }
  const undoButton = $('pose-undo-btn');
  if (undoButton) undoButton.disabled = !poseManager.draft || !poseHistory.undo.length || !!poseHistory.pending;
  const redoButton = $('pose-redo-btn');
  if (redoButton) redoButton.disabled = !poseManager.draft || !poseHistory.redo.length || !!poseHistory.pending;
  const applyAllButton = $('pose-apply-all-keyframes-btn');
  if (applyAllButton) applyAllButton.disabled = !poseManagerGetSelectedBoneFrame();
  const interpolationSelect = $('pose-keyframe-interpolation');
  if (interpolationSelect) {
    const hasKeyframe = !!poseManager.draft && (poseManager.selectedTimes.size > 0 || poseManagerHasKeyframeAtTime());
    interpolationSelect.disabled = !hasKeyframe;
    if (document.activeElement !== interpolationSelect) {
      if (hasKeyframe) {
        const activeTime = poseManager.selectedTimes.size > 0 && !poseManagerIsTimeSelected(poseManager.selectedTime)
          ? [...poseManager.selectedTimes][0]
          : poseManager.selectedTime;
        interpolationSelect.value = poseManagerGetKeyframeInterpolation(activeTime);
      } else {
        interpolationSelect.value = 'linear';
      }
    }
  }
}

function poseManagerRenderTimeline() {
  const range = $('pose-timeline-range');
  const time = $('pose-timeline-time');
  const state = $('pose-timeline-state');
  if (!range || !time || !state) return;
  if (poseManager.keyframeDragging) return;
  const preview = posePreviewAvatar?.getPosePreviewState?.();
  const duration = Math.max(0.1, Number(preview?.duration || poseManager.draft?.duration || 0.1));
  const elapsed = Math.min(duration, Math.max(0, Number(preview?.elapsed || 0)));
  if (poseManager.previewing && !poseManager.previewPaused) poseManager.selectedTime = elapsed;
  range.max = duration.toFixed(2);
  range.value = elapsed.toFixed(2);
  time.textContent = `${elapsed.toFixed(2)}s / ${duration.toFixed(2)}s`;
  state.textContent = poseManager.previewing
    ? (poseManager.previewPaused ? 'Paused' : 'Looping')
    : 'Ready';
  state.dataset.playing = poseManager.previewing && !poseManager.previewPaused ? 'true' : 'false';
  poseManagerSetPlaybackControls();
  poseManagerRenderKeyframeTimeline();
}

function poseManagerStartTimeline() {
  cancelAnimationFrame(poseTimelineFrame);
  const tick = () => {
    poseManagerRenderTimeline();
    if ($('pose-browser-dialog')?.open) poseTimelineFrame = requestAnimationFrame(tick);
  };
  tick();
}

function poseManagerStopTimeline() {
  cancelAnimationFrame(poseTimelineFrame);
  poseTimelineFrame = 0;
}

function poseManagerSeekTimeline() {
  const range = $('pose-timeline-range');
  if (!range || !poseManager.draft) return;
  poseManagerSelectTime(Number(range.value), true);
}

function poseManagerSlug(value) {
  return String(value || '').trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_').replace(/^[_-]+|[_-]+$/g, '').slice(0, 40);
}

function poseManagerUniqueName(base = 'pose_baru') {
  const names = new Set(avatar?.getPoseNames?.() || []);
  let candidate = poseManagerSlug(base) || 'pose_baru';
  let index = 2;
  while (names.has(candidate)) candidate = `${poseManagerSlug(base) || 'pose_baru'}_${index++}`;
  return candidate;
}

function poseManagerEnsureTracks(clip) {
  clip.tracks ||= {};
  clip.positionTracks ||= {};
  clip.expressionTracks ||= {};
  return clip;
}

function poseManagerFrameTimes() {
  if (!poseManager.draft) return [];
  const values = [];
  for (const group of ['tracks', 'positionTracks', 'expressionTracks']) {
    for (const frames of Object.values(poseManager.draft[group] || {})) {
      for (const frame of frames || []) {
        const value = Number(frame.time);
        if (Number.isFinite(value)) values.push(Math.max(0, value));
      }
    }
  }
  return [...new Set(values.map(value => value.toFixed(3)))].map(Number).sort((a, b) => a - b);
}

let activeKeyframeDrag = null;

function poseManagerCancelKeyframeDrag() {
  if (!activeKeyframeDrag) return;
  activeKeyframeDrag.cancel();
}

function poseManagerApplyKeyframeMove(sourceSnapshot, fromTime, toTime) {
  if (!sourceSnapshot) return;
  const draft = clonePose(sourceSnapshot);
  const duration = Math.max(0.1, Number(draft.duration) || 0.1);
  const targetTime = Number(Math.max(0, Math.min(duration, Number(toTime))).toFixed(2));
  const groups = ['tracks', 'positionTracks', 'expressionTracks'];
  for (const group of groups) {
    if (!draft[group]) continue;
    for (const [name, frames] of Object.entries(draft[group])) {
      if (!Array.isArray(frames)) continue;
      const movingIndex = frames.findIndex(f => Math.abs(Number(f.time) - fromTime) < 0.006);
      if (movingIndex >= 0) {
        const movingFrame = { ...frames[movingIndex], time: targetTime };
        frames.splice(movingIndex, 1);
        const targetIndex = frames.findIndex(f => Math.abs(Number(f.time) - targetTime) < 0.006);
        if (targetIndex >= 0) {
          frames[targetIndex] = movingFrame;
        } else {
          frames.push(movingFrame);
        }
        frames.sort((a, b) => Number(a.time) - Number(b.time));
      }
    }
  }
  poseManager.draft = draft;
}

function poseManagerApplyMultiKeyframeMove(sourceSnapshot, selectedTimesSet, delta) {
  if (!sourceSnapshot) return null;
  const draft = clonePose(sourceSnapshot);
  const duration = Math.max(0.1, Number(draft.duration) || 0.1);
  const groups = ['tracks', 'positionTracks', 'expressionTracks'];
  const sortedTimes = [...selectedTimesSet].sort((a, b) => a - b);
  if (!sortedTimes.length) return null;

  let clampedDelta = delta;
  const minT = sortedTimes[0];
  const maxT = sortedTimes[sortedTimes.length - 1];
  if (minT + clampedDelta < 0) clampedDelta = -minT;
  if (maxT + clampedDelta > duration) clampedDelta = duration - maxT;

  const timeMap = new Map();
  for (const t of sortedTimes) {
    timeMap.set(t, Number(Math.max(0, Math.min(duration, t + clampedDelta)).toFixed(2)));
  }

  for (const group of groups) {
    if (!draft[group]) continue;
    for (const [name, frames] of Object.entries(draft[group])) {
      if (!Array.isArray(frames)) continue;
      const moving = [];
      const kept = [];
      for (const f of frames) {
        const fTime = Number(f.time);
        let matchedOld = null;
        for (const t of sortedTimes) {
          if (Math.abs(t - fTime) < 0.006) {
            matchedOld = t;
            break;
          }
        }
        if (matchedOld !== null) {
          moving.push({ ...f, time: timeMap.get(matchedOld) });
        } else {
          kept.push(f);
        }
      }
      for (const m of moving) {
        const idx = kept.findIndex(k => Math.abs(Number(k.time) - m.time) < 0.006);
        if (idx >= 0) kept[idx] = m;
        else kept.push(m);
      }
      kept.sort((a, b) => Number(a.time) - Number(b.time));
      draft[group][name] = kept;
    }
  }
  poseManager.draft = draft;
  return timeMap;
}

function poseManagerCopyKeyframes() {
  if (!poseManager.draft) return;
  let timesToCopy = [];
  if (poseManager.selectedTimes.size > 0) {
    timesToCopy = [...poseManager.selectedTimes].sort((a, b) => a - b);
  } else if (poseManagerHasKeyframeAtTime(poseManager.selectedTime)) {
    timesToCopy = [Number(poseManager.selectedTime.toFixed(2))];
  }

  if (!timesToCopy.length) {
    poseManagerSetStatus('Pilih keyframe untuk disalin (Ctrl+C).', true);
    return;
  }

  const baseTime = timesToCopy[0];
  const span = Number((timesToCopy[timesToCopy.length - 1] - baseTime).toFixed(2));
  const copiedGroups = { tracks: {}, positionTracks: {}, expressionTracks: {} };

  for (const groupName of ['tracks', 'positionTracks', 'expressionTracks']) {
    const group = poseManager.draft[groupName] || {};
    for (const [boneName, frames] of Object.entries(group)) {
      if (!Array.isArray(frames)) continue;
      for (const frame of frames) {
        const fTime = Number(frame.time);
        const matchTime = timesToCopy.find(t => Math.abs(t - fTime) < 0.006);
        if (matchTime !== undefined) {
          copiedGroups[groupName][boneName] ||= [];
          copiedGroups[groupName][boneName].push({
            ...clonePose(frame),
            relTime: Number((fTime - baseTime).toFixed(3))
          });
        }
      }
    }
  }

  poseKeyframeClipboard = {
    count: timesToCopy.length,
    baseTime,
    span,
    times: timesToCopy,
    groups: copiedGroups
  };

  poseManagerSetPlaybackControls();
  poseManagerSetStatus(`${timesToCopy.length} keyframe disalin ke clipboard.`);
}

function poseManagerPasteKeyframes() {
  if (!poseManager.draft || !poseKeyframeClipboard) {
    poseManagerSetStatus('Clipboard keyframe kosong.', true);
    return;
  }

  const pasteBaseTime = Number(poseManager.selectedTime.toFixed(2));
  const requiredDuration = Number((pasteBaseTime + poseKeyframeClipboard.span).toFixed(2));
  let currentDuration = Number(poseManager.draft.duration) || 0.1;
  let durationExtended = false;

  poseManagerHistoryRun(() => {
    if (requiredDuration > currentDuration) {
      currentDuration = Math.min(60, Math.max(currentDuration, requiredDuration));
      poseManager.draft.duration = currentDuration;
      const durInput = $('pose-duration');
      if (durInput) durInput.value = currentDuration.toFixed(2);
      durationExtended = true;
    }

    const newPastedTimes = new Set();

    for (const groupName of ['tracks', 'positionTracks', 'expressionTracks']) {
      const group = poseKeyframeClipboard.groups[groupName] || {};
      poseManager.draft[groupName] ||= {};
      for (const [boneName, frames] of Object.entries(group)) {
        for (const frame of frames) {
          const targetTime = Number(Math.min(currentDuration, Math.max(0, pasteBaseTime + frame.relTime)).toFixed(2));
          const { relTime, ...frameData } = frame;
          poseManagerUpsertFrame(poseManager.draft[groupName], boneName, targetTime, frameData);
          newPastedTimes.add(targetTime);
        }
      }
    }

    poseManager.selectedTimes = newPastedTimes;
    poseManagerUpdateRuntime();
  });

  poseManagerSetPlaybackControls();
  poseManagerSetStatus(
    `${poseKeyframeClipboard.count} keyframe ditempel pada ${pasteBaseTime.toFixed(2)}s` +
    (durationExtended ? ` (durasi otomatis diperpanjang ke ${currentDuration.toFixed(2)}s).` : '.')
  );
}

function poseManagerSelectAllKeyframes() {
  const times = poseManagerFrameTimes();
  if (!times.length) return;
  poseManager.selectedTimes = new Set(times.map(t => Number(t.toFixed(2))));
  poseManagerRenderKeyframeTimeline();
  poseManagerSetPlaybackControls();
  poseManagerSetStatus(`${times.length} keyframe terpilih.`);
}

function poseManagerRenderKeyframeTimeline() {
  const ruler = $('pose-keyframe-ruler');
  const track = $('pose-keyframe-track');
  const info = $('pose-keyframe-info');
  const container = track?.closest('.pose-timeline') || track;
  if (!ruler || !track || !container || !poseManager.draft) return;
  if (poseManager.keyframeDragging) return;
  const duration = Math.max(0.1, Number(poseManager.draft.duration) || 0.1);
  const times = poseManagerFrameTimes();
  const signature = `${duration.toFixed(3)}|${times.map(time => time.toFixed(3)).join(',')}`;
  if (track.dataset.signature !== signature) {
    track.dataset.signature = signature;
    ruler.replaceChildren();
    track.replaceChildren();
    for (let index = 0; index <= 4; index += 1) {
      const tick = document.createElement('span');
      tick.textContent = `${(duration * index / 4).toFixed(1)}s`;
      tick.style.left = `${index * 25}%`;
      ruler.appendChild(tick);
    }

    // Marquee box selection across the entire dark timeline container
    let trackPointerDown = false;
    let trackStartX = 0;
    let trackStartY = 0;
    let trackPointerId = null;
    let marqueeEl = null;
    let didMarqueeDrag = false;

    const startMarquee = event => {
      if (event.button !== 0) return;
      if (event.target.closest('#pose-timeline-range')) return;
      if (event.target.closest('.pose-keyframe-marker')) return;
      event.preventDefault(); // Prevent native text selection
      event.stopPropagation();
      trackPointerDown = true;
      didMarqueeDrag = false;
      trackStartX = event.clientX;
      trackStartY = event.clientY;
      trackPointerId = event.pointerId;
      document.body.classList.add('selecting-marquee');
      try { container.setPointerCapture(event.pointerId); } catch {}
    };

    const moveMarquee = event => {
      if (!trackPointerDown) return;
      event.preventDefault();
      const dx = event.clientX - trackStartX;
      const dy = event.clientY - trackStartY;
      if (!didMarqueeDrag && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
        didMarqueeDrag = true;
        container.classList.add('selecting-marquee');
        if (!marqueeEl) {
          marqueeEl = document.createElement('div');
          marqueeEl.className = 'pose-keyframe-marquee';
          const kfTimeline = $('pose-keyframe-timeline');
          if (kfTimeline) {
            marqueeEl.style.top = `${kfTimeline.offsetTop - 2}px`;
          }
          container.appendChild(marqueeEl);
        }
      }
      if (didMarqueeDrag && marqueeEl) {
        const containerRect = container.getBoundingClientRect();
        const trackRect = track.getBoundingClientRect();
        const rawMinX = Math.min(trackStartX, event.clientX);
        const rawMaxX = Math.max(trackStartX, event.clientX);

        const minPixel = Math.max(0, rawMinX - containerRect.left);
        const maxPixel = Math.min(containerRect.width, rawMaxX - containerRect.left);
        marqueeEl.style.left = `${minPixel}px`;
        marqueeEl.style.width = `${Math.max(2, maxPixel - minPixel)}px`;

        const minRatio = Math.max(0, Math.min(1, (rawMinX - trackRect.left) / Math.max(1, trackRect.width)));
        const maxRatio = Math.max(0, Math.min(1, (rawMaxX - trackRect.left) / Math.max(1, trackRect.width)));
        const minTime = minRatio * duration;
        const maxTime = maxRatio * duration;

        for (const m of track.querySelectorAll('.pose-keyframe-marker')) {
          const mTime = Number(m.dataset.time);
          const inRange = mTime >= minTime - 0.03 && mTime <= maxTime + 0.03;
          m.classList.toggle('selected', inRange || (event.shiftKey && poseManagerIsTimeSelected(mTime)));
        }
      }
    };

    const finishMarquee = event => {
      if (!trackPointerDown) return;
      trackPointerDown = false;
      document.body.classList.remove('selecting-marquee');
      if (trackPointerId !== null) {
        try { container.releasePointerCapture(trackPointerId); } catch {}
        trackPointerId = null;
      }
      container.classList.remove('selecting-marquee');
      if (marqueeEl) {
        marqueeEl.remove();
        marqueeEl = null;
      }

      const trackRect = track.getBoundingClientRect();
      if (didMarqueeDrag) {
        const rawMinX = Math.min(trackStartX, event.clientX);
        const rawMaxX = Math.max(trackStartX, event.clientX);
        const minRatio = Math.max(0, Math.min(1, (rawMinX - trackRect.left) / Math.max(1, trackRect.width)));
        const maxRatio = Math.max(0, Math.min(1, (rawMaxX - trackRect.left) / Math.max(1, trackRect.width)));
        const minTime = minRatio * duration;
        const maxTime = maxRatio * duration;

        const foundTimes = times.filter(t => t >= minTime - 0.03 && t <= maxTime + 0.03);
        if (event.shiftKey) {
          for (const t of foundTimes) {
            poseManager.selectedTimes.add(Number(t.toFixed(2)));
          }
        } else {
          poseManager.selectedTimes = new Set(foundTimes.map(t => Number(t.toFixed(2))));
        }

        if (poseManager.selectedTimes.size > 0) {
          const sorted = [...poseManager.selectedTimes].sort((a, b) => a - b);
          poseManagerSelectTime(sorted[0], true);
          poseManagerSetStatus(`${poseManager.selectedTimes.size} keyframe terpilih (${sorted.map(t => t.toFixed(2)).join(', ')}s). Salin dengan Ctrl+C.`);
        } else {
          poseManagerSetStatus('Tidak ada keyframe di area seleksi.');
        }
        poseManagerSetPlaybackControls();
        poseManagerRenderKeyframeTimeline();
      } else {
        const ratio = Math.max(0, Math.min(1, (event.clientX - trackRect.left) / Math.max(1, trackRect.width)));
        if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
          poseManager.selectedTimes.clear();
        }
        poseManagerSelectTime(ratio * duration, true);
        poseManagerSetPlaybackControls();
        poseManagerRenderKeyframeTimeline();
      }
    };

    container.onpointerdown = startMarquee;
    container.onpointermove = moveMarquee;
    container.onpointerup = finishMarquee;
    container.onpointercancel = finishMarquee;

    for (const time of times) {
      const marker = document.createElement('button');
      marker.type = 'button';
      marker.className = 'pose-keyframe-marker';
      marker.style.left = `${Math.min(100, Math.max(0, (time / duration) * 100))}%`;
      const interp = poseManagerGetKeyframeInterpolation(time);
      marker.title = `Keyframe ${time.toFixed(2)} detik${interp !== 'linear' ? ` [${interp}]` : ''} (Drag untuk menggeser)`;
      marker.dataset.time = time.toFixed(3);
      marker.dataset.interpolation = interp;

      const tooltip = document.createElement('span');
      tooltip.className = 'pose-keyframe-tooltip';
      tooltip.textContent = interp !== 'linear' ? `${time.toFixed(2)}s (${interp})` : `${time.toFixed(2)}s`;
      marker.appendChild(tooltip);

      let isPointerDown = false;
      let isDragging = false;
      let didDrag = false;
      let startX = 0;
      let startY = 0;
      let originTime = time;
      let originalSnapshot = null;
      let currentDragTime = time;
      let lastPointerId = null;

      const cancelDrag = () => {
        if (!isPointerDown) return;
        isPointerDown = false;
        if (lastPointerId !== null) {
          try { marker.releasePointerCapture(lastPointerId); } catch {}
          lastPointerId = null;
        }
        for (const m of track.querySelectorAll('.pose-keyframe-marker')) {
          m.classList.remove('dragging');
        }
        track.classList.remove('dragging-keyframe');
        if (isDragging) {
          isDragging = false;
          poseManager.keyframeDragging = false;
          if (originalSnapshot) poseManager.draft = clonePose(originalSnapshot);
          poseHistory.pending = null;
          poseManagerSelectTime(originTime, true);
          poseManagerSetStatus('Pergeseran keyframe dibatalkan.');
          poseManagerRenderTimeline();
        }
        activeKeyframeDrag = null;
      };

      marker.onpointerdown = event => {
        if (event.button !== 0) return;
        event.preventDefault(); // Stop native text selection and drag
        event.stopPropagation();
        isPointerDown = true;
        isDragging = false;
        didDrag = false;
        startX = event.clientX;
        startY = event.clientY;
        lastPointerId = event.pointerId;
        originTime = Number(marker.dataset.time);
        currentDragTime = originTime;
        originalSnapshot = clonePose(poseManager.draft);

        const wasSelected = poseManagerIsTimeSelected(originTime);
        // If not holding Shift/Ctrl, and the marker was not selected yet, select it alone immediately
        if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !wasSelected) {
          poseManager.selectedTimes = new Set([Number(originTime.toFixed(2))]);
          poseManagerSelectTime(originTime, true);
          poseManagerSetPlaybackControls();
          poseManagerRenderKeyframeTimeline();
        }

        activeKeyframeDrag = { cancel: cancelDrag };
        try { marker.setPointerCapture(event.pointerId); } catch {}
      };

      marker.onpointermove = event => {
        if (!isPointerDown) return;
        const deltaX = Math.abs(event.clientX - startX);
        const deltaY = Math.abs(event.clientY - startY);
        if (!isDragging && (deltaX > 3 || deltaY > 3)) {
          isDragging = true;
          poseManager.keyframeDragging = true;
          if (poseManager.previewing && !poseManager.previewPaused) {
            poseManagerPause();
          }
          poseManagerHistoryBegin();
          marker.classList.add('dragging', 'active');
          track.classList.add('dragging-keyframe');

          if (!poseManagerIsTimeSelected(originTime)) {
            poseManager.selectedTimes.add(Number(originTime.toFixed(2)));
          }
        }
        if (isDragging) {
          const rect = track.getBoundingClientRect();
          const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
          const newTime = Number(Math.max(0, Math.min(duration, ratio * duration)).toFixed(2));
          currentDragTime = newTime;

          if (poseManager.selectedTimes.size > 1 && poseManagerIsTimeSelected(originTime)) {
            const deltaTime = newTime - originTime;
            const timeMap = poseManagerApplyMultiKeyframeMove(originalSnapshot, poseManager.selectedTimes, deltaTime);
            if (timeMap) {
              for (const m of track.querySelectorAll('.pose-keyframe-marker')) {
                const mTime = Number(m.dataset.time);
                for (const [origT, mappedT] of timeMap.entries()) {
                  if (Math.abs(origT - mTime) < 0.006) {
                    m.style.left = `${Math.min(100, Math.max(0, (mappedT / duration) * 100))}%`;
                    m.classList.add('dragging');
                    const mTooltip = m.querySelector('.pose-keyframe-tooltip');
                    if (mTooltip) mTooltip.textContent = `${mappedT.toFixed(2)}s`;
                    break;
                  }
                }
              }
            }
          } else {
            marker.style.left = `${Math.min(100, Math.max(0, (newTime / duration) * 100))}%`;
            marker.title = `Keyframe ${newTime.toFixed(2)} detik (Drag untuk menggeser)`;
            tooltip.textContent = `${newTime.toFixed(2)}s`;

            poseManagerApplyKeyframeMove(originalSnapshot, originTime, newTime);
          }

          const rangeEl = $('pose-timeline-range');
          if (rangeEl) rangeEl.value = newTime.toFixed(2);
          const timeEl = $('pose-timeline-time');
          if (timeEl) timeEl.textContent = `${newTime.toFixed(2)}s / ${duration.toFixed(2)}s`;
          if (info) info.textContent = `${newTime.toFixed(2)}s · ${times.length} keyframe${poseManager.selectedTimes.size > 1 ? ` (${poseManager.selectedTimes.size} terpilih)` : ''}`;

          poseManager.selectedTime = newTime;
          posePreviewAvatar?.setPoseClip(poseManager.draft);
          posePreviewAvatar?.seekPosePreview(newTime);
        }
      };

      const finishDrag = event => {
        if (!isPointerDown) return;
        isPointerDown = false;
        if (lastPointerId !== null) {
          try { marker.releasePointerCapture(lastPointerId); } catch {}
          lastPointerId = null;
        }
        for (const m of track.querySelectorAll('.pose-keyframe-marker')) {
          m.classList.remove('dragging');
        }
        track.classList.remove('dragging-keyframe');
        activeKeyframeDrag = null;

        if (isDragging) {
          didDrag = true;
          setTimeout(() => { didDrag = false; }, 120);
          isDragging = false;
          poseManager.keyframeDragging = false;
          if (Math.abs(currentDragTime - originTime) > 0.005) {
            if (poseManager.selectedTimes.size > 1 && poseManagerIsTimeSelected(originTime)) {
              const deltaTime = currentDragTime - originTime;
              const sortedTimes = [...poseManager.selectedTimes].sort((a, b) => a - b);
              let clampedDelta = deltaTime;
              const minT = sortedTimes[0];
              const maxT = sortedTimes[sortedTimes.length - 1];
              if (minT + clampedDelta < 0) clampedDelta = -minT;
              if (maxT + clampedDelta > duration) clampedDelta = duration - maxT;

              const newTimes = new Set();
              for (const t of sortedTimes) {
                newTimes.add(Number(Math.max(0, Math.min(duration, t + clampedDelta)).toFixed(2)));
              }
              poseManager.selectedTimes = newTimes;
              poseManager.selectedTime = Number(Math.max(0, Math.min(duration, originTime + clampedDelta)).toFixed(2));
              poseManagerSetStatus(`${newTimes.size} keyframe digeser bersama.`);
            } else {
              poseManager.selectedTimes = new Set([currentDragTime]);
              poseManager.selectedTime = currentDragTime;
              poseManagerSetStatus(`Keyframe digeser dari ${originTime.toFixed(2)}s ke ${currentDragTime.toFixed(2)}s.`);
            }

            poseManagerHistoryCommit();
            poseManagerUpdateRuntime();
          } else {
            poseManager.draft = clonePose(originalSnapshot);
            poseHistory.pending = null;
            poseManagerSelectTime(originTime, true);
          }
          poseManagerRenderTimeline();
        }
      };

      marker.onpointerup = finishDrag;
      marker.onpointercancel = finishDrag;

      marker.onclick = event => {
        event.stopPropagation();
        if (didDrag) return;
        const markerTime = Number(marker.dataset.time);
        if (event.shiftKey || event.ctrlKey || event.metaKey) {
          if (poseManagerIsTimeSelected(markerTime)) {
            for (const t of poseManager.selectedTimes) {
              if (Math.abs(t - markerTime) < 0.006) poseManager.selectedTimes.delete(t);
            }
          } else {
            poseManager.selectedTimes.add(Number(markerTime.toFixed(2)));
          }
        } else {
          poseManager.selectedTimes = new Set([Number(markerTime.toFixed(2))]);
        }
        poseManagerSelectTime(markerTime, true);
        poseManagerSetPlaybackControls();
        poseManagerRenderKeyframeTimeline();
      };

      track.appendChild(marker);
    }
  }
  for (const marker of track.querySelectorAll('.pose-keyframe-marker')) {
    const markerTime = Number(marker.dataset.time);
    marker.classList.toggle('active', Math.abs(markerTime - poseManager.selectedTime) < 0.006);
    marker.classList.toggle('selected', poseManagerIsTimeSelected(markerTime));
    const interp = poseManagerGetKeyframeInterpolation(markerTime);
    marker.dataset.interpolation = interp;
    marker.title = `Keyframe ${markerTime.toFixed(2)} detik${interp !== 'linear' ? ` [${interp}]` : ''} (Drag untuk menggeser)`;
    const tooltip = marker.querySelector('.pose-keyframe-tooltip');
    if (tooltip) {
      tooltip.textContent = interp !== 'linear' ? `${markerTime.toFixed(2)}s (${interp})` : `${markerTime.toFixed(2)}s`;
    }
  }
  const selCount = poseManager.selectedTimes.size;
  if (info) info.textContent = `${poseManager.selectedTime.toFixed(2)}s · ${times.length} keyframe${selCount > 1 ? ` (${selCount} terpilih)` : ''}`;
}

function poseManagerHasKeyframeAtTime(time = poseManager.selectedTime) {
  return poseManagerFrameTimes().some(frameTime => Math.abs(frameTime - Number(time)) < 0.006);
}

function poseManagerGetSelectedBoneFrame(time = poseManager.selectedTime) {
  const frames = poseManager.draft?.tracks?.[poseManager.selectedBone] || [];
  return frames.find(frame => Math.abs(Number(frame.time) - Number(time)) < 0.006) || null;
}

function poseManagerGetKeyframeInterpolation(time = poseManager.selectedTime) {
  if (!poseManager.draft) return 'linear';
  const t = Number(time);
  const groups = ['tracks', 'positionTracks', 'expressionTracks'];
  for (const groupName of groups) {
    const group = poseManager.draft[groupName] || {};
    for (const frames of Object.values(group)) {
      if (!Array.isArray(frames)) continue;
      const found = frames.find(f => Math.abs(Number(f.time) - t) < 0.006);
      if (found && found.interpolation) {
        return found.interpolation;
      }
    }
  }
  return 'linear';
}

function poseManagerSetKeyframeInterpolation(mode) {
  if (!poseManager.draft) return;
  const validModes = ['linear', 'easeInOut', 'easeIn', 'easeOut', 'step'];
  const interpolation = validModes.includes(mode) ? mode : 'linear';

  let targetTimes = [];
  if (poseManager.selectedTimes.size > 0) {
    targetTimes = [...poseManager.selectedTimes];
  } else if (poseManagerHasKeyframeAtTime(poseManager.selectedTime)) {
    targetTimes = [Number(poseManager.selectedTime.toFixed(2))];
  }

  if (!targetTimes.length) return;

  poseManagerHistoryRun(() => {
    const groups = ['tracks', 'positionTracks', 'expressionTracks'];
    for (const groupName of groups) {
      const group = poseManager.draft[groupName] || {};
      for (const frames of Object.values(group)) {
        if (!Array.isArray(frames)) continue;
        for (const frame of frames) {
          const fTime = Number(frame.time);
          if (targetTimes.some(t => Math.abs(t - fTime) < 0.006)) {
            if (interpolation === 'linear') {
              delete frame.interpolation;
            } else {
              frame.interpolation = interpolation;
            }
          }
        }
      }
    }
    poseManagerUpdateRuntime();
  });

  poseManagerSetPlaybackControls();
  poseManagerRenderKeyframeTimeline();
  poseManagerSetStatus(`Interpolasi untuk ${targetTimes.length} keyframe diubah ke ${interpolation}.`);
}

function poseManagerSelectTime(seconds, pause = true) {
  if (!poseManager.draft) return;
  const duration = Math.max(0.1, Number(poseManager.draft.duration) || 0.1);
  const targetTime = Math.max(0, Math.min(duration, Number(seconds) || 0));
  poseManager.selectedTime = targetTime;
  if (poseManager.previewing && posePreviewAvatar) {
    if (pause && !poseManager.previewPaused) poseManagerPause();
    poseManager.selectedTime = targetTime;
    posePreviewAvatar.seekPosePreview(poseManager.selectedTime);
  }
  poseManagerRenderTimeline();
}

function poseManagerSelectBone(name) {
  if (!name) return;
  poseManager.selectedBone = name;
  if (poseManager.previewing && !poseManager.previewPaused) poseManagerSelectTime(poseManager.selectedTime, true);
  if ($('pose-selected-bone')) $('pose-selected-bone').textContent = name;
  poseManagerSetPlaybackControls();
  poseManagerSetStatus(`Tulang ${name} dipilih. Putar gizmo lalu simpan keyframe.`);
}

function poseManagerSetEditorTool(mode) {
  poseManager.editorMode = 'rotate';
  posePreviewAvatar?.setEditorTool?.(poseManager.editorMode);
  $('pose-rotate-tool')?.classList.add('active');
  poseManagerSetStatus('Tool Rotate aktif.');
}

function poseManagerUpsertFrame(trackGroup, bone, time, frame) {
  trackGroup[bone] ||= [];
  const existing = trackGroup[bone].findIndex(item => Math.abs(Number(item.time) - time) < 0.006);
  if (existing >= 0) {
    trackGroup[bone][existing] = { ...trackGroup[bone][existing], ...frame, time };
  } else {
    const existingInterp = poseManagerGetKeyframeInterpolation(time);
    const newFrame = { ...frame, time };
    if (existingInterp && existingInterp !== 'linear') {
      newFrame.interpolation = existingInterp;
    }
    trackGroup[bone].push(newFrame);
  }
  trackGroup[bone].sort((a, b) => Number(a.time) - Number(b.time));
}

function poseManagerApplyBoneRotation(bone, time, rotation) {
  poseManagerUpsertFrame(poseManager.draft.tracks, bone, time, { rotation: rotation.slice(0, 3) });
}

function poseManagerApplyAllKeyframes() {
  if (!poseManager.draft) return;
  const bone = poseManager.selectedBone;
  const time = Number(poseManager.selectedTime);
  const current = poseManagerGetSelectedBoneFrame(time);
  if (!current) {
    poseManagerSetStatus(`Pilih keyframe ${bone} terlebih dahulu sebelum Apply all.`, true);
    return;
  }
  const following = (poseManager.draft.tracks?.[bone] || [])
    .filter(frame => Number(frame.time) > time + 0.006);
  if (!following.length) {
    poseManagerSetStatus(`Tidak ada keyframe setelah ${time.toFixed(2)} detik untuk bone ${bone}.`);
    return;
  }
  const rotation = Array.isArray(current.rotation) ? current.rotation.slice(0, 3) : [0, 0, 0];
  poseManagerHistoryRun(() => {
    for (const frame of following) frame.rotation = rotation.slice(0, 3);
    poseManagerUpdateRuntime();
  });
  poseManagerSetStatus(`Rotasi ${bone} pada ${time.toFixed(2)} detik diterapkan ke ${following.length} keyframe berikutnya.`);
}

function poseManagerHandleEditorDrag(dragging) {
  poseManager.editorDragging = !!dragging;
  if (dragging) poseManagerHistoryBegin();
  else poseManagerHistoryCommit();
}

function poseManagerApplyEditorTransform(transform) {
  if (!poseManager.draft || !transform?.bone) return;
  const ownsHistory = !poseManager.editorDragging && !poseHistory.pending;
  if (ownsHistory) poseManagerHistoryBegin();
  poseManager.selectedBone = transform.bone;
  poseManagerApplyBoneRotation(transform.bone, poseManager.selectedTime, transform.rotation);
  poseManagerUpdateRuntime();
  if ($('pose-selected-bone')) $('pose-selected-bone').textContent = transform.bone;
  if (ownsHistory) poseManagerHistoryCommit();
}

function poseManagerResetSelectedBone() {
  if (!poseManager.draft || !poseManager.selectedBone || !posePreviewAvatar) return;
  const bone = poseManager.selectedBone;
  const rest = posePreviewAvatar.getEditorBoneRestTransform?.(bone);
  if (!rest) {
    poseManagerSetStatus(`Pose awal untuk bone ${bone} tidak tersedia.`, true);
    return;
  }
  poseManagerHistoryRun(() => {
    poseManagerApplyBoneRotation(bone, poseManager.selectedTime, rest.rotation);
    if (poseManager.draft.positionTracks?.[bone]) {
      poseManagerUpsertFrame(poseManager.draft.positionTracks, bone, poseManager.selectedTime, {
        position: [0, 0, 0]
      });
    }
    poseManagerUpdateRuntime();
  });
  poseManagerSetStatus(`Bone ${bone} dikembalikan ke pose awal pada ${poseManager.selectedTime.toFixed(2)} detik.`);
}

function poseManagerInsertKeyframe() {
  if (!poseManager.draft || !posePreviewAvatar) return;
  if (poseManager.previewing && !poseManager.previewPaused) poseManagerSelectTime(poseManager.selectedTime, true);
  poseManagerHistoryRun(() => {
    const boneNames = posePreviewAvatar.getEditorBoneNames?.() || POSE_EDITOR_BONES;
    for (const bone of boneNames) {
      const transform = posePreviewAvatar.getEditorBoneTransform?.(bone);
      if (transform) poseManagerApplyBoneRotation(bone, poseManager.selectedTime, transform.rotation);
    }
    poseManagerUpdateRuntime();
  });
  poseManagerSetStatus(`Pose keyframe pada ${poseManager.selectedTime.toFixed(2)} detik dibuat.`);
}

function poseManagerDeleteKeyframe() {
  if (!poseManager.draft) return;
  let timesToDelete = [];
  if (poseManager.selectedTimes.size > 0) {
    timesToDelete = [...poseManager.selectedTimes];
  } else if (poseManagerHasKeyframeAtTime(poseManager.selectedTime)) {
    timesToDelete = [Number(poseManager.selectedTime.toFixed(2))];
  }
  if (!timesToDelete.length) {
    poseManagerSetStatus('Tidak ada keyframe pada waktu ini.', true);
    return;
  }

  let removed = 0;
  poseManagerHistoryRun(() => {
    const groups = ['tracks', 'positionTracks', 'expressionTracks'];
    for (const group of groups) {
      for (const [name, frames] of Object.entries(poseManager.draft[group] || {})) {
        const kept = frames.filter(frame => {
          const fTime = Number(frame.time);
          return !timesToDelete.some(delTime => Math.abs(delTime - fTime) < 0.006);
        });
        removed += frames.length - kept.length;
        if (kept.length) poseManager.draft[group][name] = kept;
        else delete poseManager.draft[group][name];
      }
    }
    poseManager.selectedTimes.clear();
    poseManagerUpdateRuntime();
  });
  poseManagerSetPlaybackControls();
  poseManagerSetStatus(removed ? `${timesToDelete.length} waktu keyframe dihapus.` : 'Tidak ada keyframe dihapus.');
}

function poseManagerSyncMetadata() {
  if (!poseManager.draft) return;
  const duration = Number($('pose-duration')?.value);
  const transition = Number($('pose-transition')?.value);
  poseManager.draft.duration = Number.isFinite(duration) ? Math.min(60, Math.max(0.1, duration)) : 2;
  poseManager.draft.transitionSeconds = Number.isFinite(transition) ? Math.min(5, Math.max(0, transition)) : 0.3;
  poseManager.draft.loop = !!$('pose-loop')?.checked;
}

function poseManagerUpdateRuntime() {
  if (!poseManager.draft || !avatar) return;
  poseManagerSyncMetadata();
  posePreviewAvatar?.setPoseClip(poseManager.draft);
  if (poseManager.previewing && !poseManager.previewPaused && posePreviewAvatar?.poseController) {
    const preview = posePreviewAvatar.getPosePreviewState();
    if (preview.name !== poseManager.draft.name) posePreviewAvatar.previewPose(poseManager.draft.name, true);
  }
  poseManagerRenderTimeline();
}

function poseManagerLoad(name) {
  const temporaryDraft = poseManager.isNew && name === poseManager.draft?.name;
  const clip = temporaryDraft ? poseManager.draft : avatar?.getPoseClip?.(name);
  if (!clip) return;
  poseManager.draft = poseManagerEnsureTracks(clonePose(clip));
  poseManagerHistoryReset();
  posePreviewAvatar?.setPoseClip(poseManager.draft);
  poseManager.originalName = name;
  poseManager.selectedName = name;
  poseManager.isNew = temporaryDraft;
  if ($('pose-preview-title')) $('pose-preview-title').textContent = name;
  $('pose-editor').hidden = false;
  $('pose-name').value = poseManager.draft.name;
  $('pose-name').disabled = avatar.isBuiltinPose(name);
  $('pose-duration').value = Number(poseManager.draft.duration || 2).toFixed(2);
  $('pose-transition').value = Number(poseManager.draft.transitionSeconds || 0).toFixed(2);
  $('pose-loop').checked = poseManager.draft.loop !== false;
  poseManager.selectedTime = poseManagerFrameTimes()[0] || 0;
  posePreviewAvatar?.setArmatureEditorVisible?.(true);
  posePreviewAvatar?.setEditorTool?.(poseManager.editorMode);
  posePreviewAvatar?.selectEditorBone?.(poseManager.selectedBone);
  if ($('pose-selected-bone')) $('pose-selected-bone').textContent = poseManager.selectedBone;
  const hasOverride = avatar.hasPoseOverride(name);
  $('pose-reset-btn').hidden = !avatar.isBuiltinPose(name) || !hasOverride;
  $('pose-delete-btn').hidden = avatar.isBuiltinPose(name);
  poseManagerRenderKeyframeTimeline();
}

function poseManagerRenderCards(names, selected) {
  const cards = $('pose-cards');
  if (!cards) return;
  cards.replaceChildren();
  for (const name of names) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `pose-card${name === selected ? ' active' : ''}`;
    card.dataset.pose = name;
    const thumb = document.createElement('span');
    thumb.className = 'pose-card-thumb';
    thumb.textContent = name === 'wave' ? '👋' : name === 'nod' ? '↕' : name === 'think' ? '🤔' : name === 'talk' ? '💬' : '✦';
    const title = document.createElement('strong');
    title.textContent = name;
    const meta = document.createElement('small');
    meta.textContent = avatar.isBuiltinPose(name) ? 'Bawaan' : 'Custom';
    card.append(thumb, title, meta);
    card.onclick = () => {
      poseManagerStopPreview();
      $('pose-select').value = name;
      poseManagerLoad(name);
      poseManagerRenderCards(names, name);
      poseManagerPreview();
      poseManagerSetStatus(`Pose ${name} diputar looping.`);
    };
    cards.appendChild(card);
  }
}

function poseManagerRefreshList(preferred = '') {
  const select = $('pose-select');
  if (!select || !avatar?.getPoseNames) return;
  const names = avatar.getPoseNames();
  if (poseManager.isNew && poseManager.draft?.name && !names.includes(poseManager.draft.name)) {
    names.push(poseManager.draft.name);
  }
  select.replaceChildren();
  for (const name of names) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = `${name}${avatar.isBuiltinPose(name) ? ' · bawaan' : ' · custom'}`;
    select.appendChild(option);
  }
  if (!names.length) {
    select.disabled = true;
    $('pose-cards')?.replaceChildren();
    $('pose-editor').hidden = true;
    return;
  }
  select.disabled = false;
  const selected = names.includes(preferred) ? preferred : names.includes(poseManager.selectedName) ? poseManager.selectedName : names[0];
  select.value = selected;
  poseManagerRenderCards(names, selected);
  poseManagerLoad(selected);
  poseManagerRenderTimeline();
}

function poseManagerAdd() {
  const source = poseManager.draft || avatar?.getPoseClip?.('idle');
  const draft = source ? clonePose(source) : {
    name: 'pose_baru', duration: 2, loop: true, transitionSeconds: 0.3,
    tracks: { head: [{ time: 0, rotation: [0, 0, 0] }, { time: 2, rotation: [0, 0, 0] }] }
  };
  draft.name = poseManagerUniqueName('pose_baru');
  poseManager.draft = poseManagerEnsureTracks(draft);
  poseManager.originalName = draft.name;
  poseManager.selectedName = draft.name;
  poseManager.isNew = true;
  poseManager.selectedTime = 0;
  posePreviewAvatar?.setPoseClip(draft);
  poseManagerRefreshList(draft.name);
  $('pose-name').disabled = false;
  poseManagerPreview();
  poseManagerSetStatus('Pose baru dibuat. Pilih tulang, gunakan gizmo Rotate, lalu klik Insert keyframe.');
}

function poseManagerPreview() {
  if (!poseManager.draft || !avatar) return;
  poseManagerUpdateRuntime();
  poseManager.previewing = true;
  poseManager.previewPaused = false;
  poseManager.selectedTime = 0;
  if (posePreviewAvatar?.poseController) {
    posePreviewAvatar.previewPose(poseManager.draft.name, true);
    poseManagerSetStatus(`Preview looping: ${poseManager.draft.name}.`);
  } else {
    poseManagerSetStatus('Menyiapkan avatar preview…');
  }
  poseManagerSetPlaybackControls();
  poseManagerRenderTimeline();
}

function poseManagerPause() {
  if (!poseManager.previewing || !posePreviewAvatar) return;
  if (!posePreviewAvatar.pausePosePreview()) {
    if (poseManager.draft) {
      posePreviewAvatar.previewPose?.(poseManager.draft.name, true);
      posePreviewAvatar.pausePosePreview?.();
    }
  }
  poseManager.selectedTime = posePreviewAvatar.getPosePreviewState?.().elapsed || poseManager.selectedTime;
  poseManager.previewPaused = true;
  poseManagerSetStatus(`Preview dijeda pada ${poseManager.draft?.name || 'pose'}.`);
  poseManagerSetPlaybackControls();
  poseManagerRenderTimeline();
}

function poseManagerResume() {
  if (!poseManager.draft || !avatar) return;
  if (!poseManager.previewing) {
    poseManagerPreview();
    return;
  }
  if (poseManager.previewPaused) {
    if (!posePreviewAvatar?.resumePosePreview()) {
      posePreviewAvatar?.previewPose?.(poseManager.draft.name, true);
    }
    poseManager.previewPaused = false;
    poseManagerSetStatus(`Preview looping: ${poseManager.draft.name}.`);
  }
  poseManagerSetPlaybackControls();
  poseManagerRenderTimeline();
}

function poseManagerTogglePreview() {
  if (!poseManager.previewing || poseManager.previewPaused) poseManagerResume();
  else poseManagerPause();
}

function poseManagerStopPreview() {
  avatar?.stopPosePreview?.();
  posePreviewAvatar?.stopPosePreview?.();
  poseManager.previewing = false;
  poseManager.previewPaused = false;
  posePreviewAvatar?.setArmatureEditorVisible?.(!!poseManager.draft);
  poseManagerSetPlaybackControls();
  poseManagerRenderTimeline();
}

function poseManagerSave() {
  if (!poseManager.draft || !avatar) return;
  poseManagerSyncMetadata();
  const name = poseManagerSlug($('pose-name').value);
  if (!name) {
    poseManagerSetStatus('Nama pose harus diisi dengan huruf, angka, _ atau -.', true);
    return;
  }
  const oldName = poseManager.originalName;
  const draft = { ...clonePose(poseManager.draft), name };
  if (name !== oldName) {
    if (avatar.getPoseNames().includes(name)) {
      poseManagerSetStatus(`Nama pose ${name} sudah dipakai.`, true);
      return;
    }
    if (!avatar.renameCustomPose(oldName, draft)) {
      poseManagerSetStatus('Pose bawaan tidak dapat diganti namanya.', true);
      return;
    }
  }
  if (!avatar.savePoseClip(draft)) {
    poseManagerSetStatus('Pose tidak valid dan belum disimpan.', true);
    return;
  }
  posePreviewAvatar?.setPoseClip(draft);
  poseManager.draft = draft;
  poseManager.originalName = name;
  poseManager.selectedName = name;
  poseManager.isNew = false;
  poseManagerRefreshList(name);
  if (poseManager.previewing) {
    const wasPaused = poseManager.previewPaused;
    poseManager.previewPaused = false;
    posePreviewAvatar?.previewPose(name, true);
    if (wasPaused) {
      posePreviewAvatar?.pausePosePreview?.();
      poseManager.previewPaused = true;
    }
    poseManagerSetPlaybackControls();
    poseManagerRenderTimeline();
  }
  poseManagerSetStatus(`Pose ${name} tersimpan di perangkat ini.`);
}

function poseManagerReset() {
  const name = poseManager.originalName;
  if (!avatar?.isBuiltinPose(name) || !avatar.hasPoseOverride(name)) return;
  poseManagerStopPreview();
  avatar.resetPose(name);
  posePreviewAvatar?.resetPose(name);
  poseManagerRefreshList(name);
  if (poseManager.previewing) posePreviewAvatar?.previewPose(name, true);
  poseManagerSetStatus(`Pose ${name} dikembalikan ke file bawaan.`);
}

function poseManagerDelete() {
  const name = poseManager.originalName;
  if (!name || avatar?.isBuiltinPose(name)) return;
  poseManagerStopPreview();
  avatar.removeCustomPose(name);
  posePreviewAvatar?.removeCustomPose(name);
  poseManager.selectedName = '';
  poseManagerRefreshList();
  poseManagerSetStatus(`Pose ${name} dihapus.`);
}

function poseManagerExport() {
  if (!poseManager.draft) return;
  poseManagerSyncMetadata();
  const name = poseManagerSlug($('pose-name').value) || 'pose';
  const blob = new Blob([JSON.stringify({ ...poseManager.draft, name }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}.json`;
  link.click();
  URL.revokeObjectURL(url);
  poseManagerSetStatus(`JSON ${name}.json diekspor.`);
}

async function poseManagerPopulateModelList() {
  const select = $('pose-model-select');
  const statusEl = $('pose-model-status');
  if (!select) return;

  let avatars = [];
  try {
    const res = await fetch('/api/avatars');
    if (res.ok) {
      const data = await res.json();
      if (data.ok && Array.isArray(data.avatars) && data.avatars.length > 0) {
        avatars = data.avatars;
      }
    }
  } catch (err) {
    console.warn('Could not fetch avatars list:', err);
  }

  if (!avatars.length) {
    avatars = [
      { name: 'character', fileName: 'character.vrm', url: 'avatar/character.vrm' },
      { name: 'servermmv', fileName: 'servermmv.vrm', url: 'avatar/servermmv.vrm' }
    ];
  }

  select.replaceChildren();
  const currentActiveUrl = posePreviewAvatar?.currentModelUrl || avatar?.currentModelUrl || settings.avatarModel || 'avatar/character.vrm';
  const currentActiveFile = currentActiveUrl.split('?')[0].split('/').pop();

  for (const av of avatars) {
    const option = document.createElement('option');
    option.value = av.url || `avatar/${av.fileName}`;
    const sizeText = av.sizeMB ? ` (${av.sizeMB} MB)` : '';
    option.textContent = `${av.fileName || av.name}${sizeText}`;
    if (av.fileName === currentActiveFile || option.value.endsWith(`/${currentActiveFile}`)) {
      option.selected = true;
    }
    select.appendChild(option);
  }

  if (statusEl) {
    statusEl.textContent = `Model aktif: ${currentActiveFile}`;
  }
}

async function poseManagerChangeModel(url) {
  if (!url) return;
  const select = $('pose-model-select');
  const statusEl = $('pose-model-status');
  const filename = url.split('?')[0].split('/').pop();

  if (select) select.disabled = true;
  if (statusEl) statusEl.textContent = `Memuat model ${filename}…`;
  poseManagerSetStatus(`Memuat model avatar: ${filename}…`);

  const fullUrl = url.startsWith('http') || url.startsWith('/')
    ? url
    : `${import.meta.env.BASE_URL}${url.replace(/^\/+/, '')}`;

  try {
    const targetAvatar = posePreviewAvatar || avatar;
    if (targetAvatar) {
      await targetAvatar.load(fullUrl);
      targetAvatar.paused = false;

      // Transfer active pose draft onto the newly loaded model
      if (poseManager.draft) {
        targetAvatar.setPoseClip(poseManager.draft);
        targetAvatar.setArmatureEditorVisible?.(true);
        if (poseManager.selectedBone) {
          targetAvatar.selectEditorBone?.(poseManager.selectedBone);
        }
        if (poseManager.previewing) {
          targetAvatar.previewPose?.(poseManager.draft.name, true);
          if (poseManager.previewPaused) {
            targetAvatar.pausePosePreview?.();
          }
          targetAvatar.seekPosePreview?.(poseManager.selectedTime);
        }
      }

      // Sync the main companion avatar if separate
      if (avatar && avatar !== targetAvatar) {
        avatar.load(fullUrl).catch(err => console.warn('Syncing main avatar failed:', err));
      }

      settings.avatarModel = url;
      localStorage.setItem('aichat-settings', JSON.stringify(settings));

      if (statusEl) statusEl.textContent = `Model aktif: ${filename}`;
      poseManagerSetStatus(`Model ${filename} berhasil dimuat. Bone & pose terhubung.`);
    }
  } catch (err) {
    console.error('Failed to change avatar model:', err);
    if (statusEl) statusEl.textContent = `Gagal memuat ${filename}`;
    poseManagerSetStatus(`Gagal memuat model ${filename}: ${err.message || err}`, true);
  } finally {
    if (select) select.disabled = false;
  }
}

function poseManagerInitialize() {
  if (poseManager.initialized) {
    poseManagerRefreshList();
    poseManagerPopulateModelList();
    return;
  }
  poseManager.initialized = true;
  $('pose-select').onchange = () => {
    poseManagerStopPreview();
    const name = $('pose-select').value;
    poseManagerLoad(name);
    poseManagerRenderCards(avatar.getPoseNames(), name);
    poseManagerPreview();
  };
  $('pose-add-btn').onclick = poseManagerAdd;
  $('pose-preview-btn').onclick = poseManagerTogglePreview;
  $('pose-copy-keyframe-btn').onclick = poseManagerCopyKeyframes;
  $('pose-paste-keyframe-btn').onclick = poseManagerPasteKeyframes;
  const previewStage = $('pose-preview-stage');
  if (previewStage) {
    previewStage.setAttribute('tabindex', '0');
    previewStage.onpointerdown = () => {
      if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
        document.activeElement.blur();
      }
      previewStage.focus();
    };
  }
  $('pose-timeline-range').oninput = poseManagerSeekTimeline;
  $('pose-timeline-range').onchange = poseManagerSeekTimeline;
  $('pose-insert-keyframe').onclick = poseManagerInsertKeyframe;
  $('pose-delete-keyframe').onclick = poseManagerDeleteKeyframe;
  $('pose-reset-bone-btn').onclick = poseManagerResetSelectedBone;
  $('pose-preview-delete-keyframe-btn').onclick = poseManagerDeleteKeyframe;
  $('pose-undo-btn').onclick = poseManagerUndo;
  $('pose-redo-btn').onclick = poseManagerRedo;
  $('pose-apply-all-keyframes-btn').onclick = poseManagerApplyAllKeyframes;
  const interpSelect = $('pose-keyframe-interpolation');
  if (interpSelect) {
    interpSelect.onchange = e => poseManagerSetKeyframeInterpolation(e.target.value);
  }
  const modelSelect = $('pose-model-select');
  if (modelSelect) {
    modelSelect.onchange = e => poseManagerChangeModel(e.target.value);
  }
  $('pose-rotate-tool').onclick = () => poseManagerSetEditorTool('rotate');
  $('pose-save-btn').onclick = poseManagerSave;
  $('pose-reset-btn').onclick = poseManagerReset;
  $('pose-delete-btn').onclick = poseManagerDelete;
  $('pose-export-btn').onclick = poseManagerExport;
  for (const id of ['pose-duration', 'pose-transition', 'pose-loop']) {
    $(id).addEventListener('input', poseManagerUpdateRuntime);
    $(id).addEventListener('change', poseManagerUpdateRuntime);
  }
  poseManagerRefreshList();
  poseManagerPopulateModelList();
  poseManagerPreview();
  poseManagerStartTimeline();
}

function updateVramMeter() {
  const hw = $('hardware-setting')?.value || 'cpu';
  const model = $('stt-model-setting')?.value || 'base';
  const diar = $('diarization-setting')?.checked || false;
  const totalVramMB = 12288;

  if (hw === 'cpu') {
    if ($('vram-val')) $('vram-val').textContent = '0.0 GB / 12.0 GB (0%)';
    if ($('vram-bar')) {
      $('vram-bar').style.width = '0%';
      $('vram-bar').style.background = 'linear-gradient(90deg, #10b981, #06b6d4)';
    }
    if ($('vram-hw-note')) $('vram-hw-note').textContent = 'Target: CPU (RAM Sistem ~450 MB)';
    if ($('vram-status-badge')) {
      $('vram-status-badge').textContent = 'HEMAT';
      $('vram-status-badge').style.background = '#064e3b';
      $('vram-status-badge').style.color = '#a7f3d0';
    }
    return;
  }

  let estMB = (model === 'small') ? 1500 : 800;
  if (diar) estMB += 1200;

  const estGB = (estMB / 1024).toFixed(1);
  const pct = Math.min(100, Math.round((estMB / totalVramMB) * 100));

  if ($('vram-val')) $('vram-val').textContent = `${estGB} GB / 12.0 GB (${pct}%)`;
  if ($('vram-bar')) $('vram-bar').style.width = `${pct}%`;

  const targetName = hw === 'cuda:1' ? 'Target: GPU 1 (Sekunder · Bebas)' : 'Target: GPU 0 (Utama · Display)';
  if ($('vram-hw-note')) $('vram-hw-note').textContent = targetName;

  if ($('vram-status-badge') && $('vram-bar')) {
    if (pct < 25) {
      $('vram-bar').style.background = 'linear-gradient(90deg, #10b981, #06b6d4)';
      $('vram-status-badge').textContent = 'AMAN';
      $('vram-status-badge').style.background = '#064e3b';
      $('vram-status-badge').style.color = '#a7f3d0';
    } else if (pct < 50) {
      $('vram-bar').style.background = 'linear-gradient(90deg, #3b82f6, #6366f1)';
      $('vram-status-badge').textContent = 'OPTIMAL';
      $('vram-status-badge').style.background = '#1e3a8a';
      $('vram-status-badge').style.color = '#bfdbfe';
    } else {
      $('vram-bar').style.background = 'linear-gradient(90deg, #f59e0b, #ef4444)';
      $('vram-status-badge').textContent = 'TINGGI';
      $('vram-status-badge').style.background = '#7f1d1d';
      $('vram-status-badge').style.color = '#fecaca';
    }
  }
}

function checkChanges() {
  const currentKey = $('ai-api-key-setting')?.value?.trim() || '';
  const isKeyChanged = currentKey && !currentKey.startsWith('***') && !currentKey.includes('...');
  const isChanged =
    ($('ai-base-url-setting')?.value.trim() !== (serverSettings.aiBaseUrl || '')) ||
    isKeyChanged ||
    ($('ai-model-setting')?.value !== (serverSettings.aiModel || '')) ||
    ($('stt-model-setting')?.value !== serverSettings.sttModel) ||
    ($('hardware-setting')?.value !== serverSettings.device) ||
    ($('diarization-setting')?.checked !== serverSettings.diarization) ||
    ($('wake-word-setting')?.value.trim() !== serverSettings.wakeWord) ||
    ($('silent-setting')?.checked !== serverSettings.silentTranscribe) ||
    ($('system-prompt-setting')?.value.trim() !== (serverSettings.systemPrompt || DEFAULT_SYSTEM_PROMPT)) ||
    ($('voice-setting')?.value !== settings.voice) ||
    (Number($('rate-setting')?.value) !== settings.rate) ||
    (Number($('fps-setting')?.value) !== settings.fps) ||
    ($('device-setting')?.value !== settings.device);

  const applyBtn = $('settings-apply');
  if (applyBtn) {
    applyBtn.disabled = !isChanged;
    applyBtn.style.opacity = isChanged ? '1' : '0.45';
  }
}

async function loadServerSettings() {
  try {
    const res = await (await api('settings')).json();
    serverSettings = { ...serverSettings, ...res };
    if ($('ai-base-url-setting')) $('ai-base-url-setting').value = res.aiBaseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai';
    if ($('ai-api-key-setting')) $('ai-api-key-setting').value = res.aiApiKeyMasked || '';
    if ($('ai-model-setting')) {
      const select = $('ai-model-setting');
      const currentVal = res.aiModel || 'gemini-3.1-flash-lite';
      if (![...select.options].some(opt => opt.value === currentVal)) {
        const opt = document.createElement('option');
        opt.value = currentVal;
        opt.textContent = currentVal;
        select.appendChild(opt);
      }
      select.value = currentVal;
    }
    if ($('stt-model-setting')) $('stt-model-setting').value = res.sttModel || 'base';
    if ($('hardware-setting')) $('hardware-setting').value = res.device || 'cpu';
    if ($('diarization-setting')) $('diarization-setting').checked = !!res.diarization;
    if ($('wake-word-setting')) $('wake-word-setting').value = res.wakeWord || 'Hai Anna';
    if ($('silent-setting')) $('silent-setting').checked = !!res.silentTranscribe;
    if ($('system-prompt-setting')) $('system-prompt-setting').value = res.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    updateVramMeter();
    checkChanges();
  } catch (e) {
    console.error('Failed to load server settings', e);
  }
}

async function applyServerSettings() {
  const applyBtn = $('settings-apply');
  const payload = {
    aiBaseUrl: $('ai-base-url-setting')?.value.trim() || undefined,
    aiModel: $('ai-model-setting')?.value || undefined,
    sttModel: $('stt-model-setting').value,
    device: $('hardware-setting').value,
    diarization: $('diarization-setting').checked,
    wakeWord: $('wake-word-setting').value.trim() || 'Hai Anna',
    silentTranscribe: $('silent-setting').checked,
    systemPrompt: $('system-prompt-setting').value.trim() || DEFAULT_SYSTEM_PROMPT
  };
  const keyVal = $('ai-api-key-setting')?.value?.trim();
  if (keyVal && !keyVal.startsWith('***') && !keyVal.includes('...')) {
    payload.aiApiKey = keyVal;
  }
  if (applyBtn) {
    applyBtn.disabled = true;
    applyBtn.style.opacity = '0.7';
    applyBtn.textContent = '⏳ Memuat model STT…';
  }
  settingsApplying = true;
  setState(state);
  try {
    const res = await (await api('settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })).json();
    serverSettings = { ...serverSettings, ...payload };
    saveSettings();
    checkChanges();
    const sttInfo = res.stt ? ` STT ${res.stt.model} · ${res.stt.device} siap.` : '';
    notice(`✓ Apply selesai.${sttInfo}`);
    updateHealth();
    setTimeout(() => notice(''), 3000);
  } catch (err) {
    notice('Gagal menerapkan pengaturan: ' + err.message);
  } finally {
    settingsApplying = false;
    if (applyBtn) {
      applyBtn.textContent = '✓ Apply';
      checkChanges();
    }
    setState(state);
  }
}

// Wire form change listeners
for (const key of ['voice', 'rate', 'fps', 'device']) {
  const el = $(`${key}-setting`);
  if (el) {
    el.value = settings[key];
    el.addEventListener('input', checkChanges);
    el.addEventListener('change', checkChanges);
  }
}

const systemPromptField = $('system-prompt-setting');
if (systemPromptField) {
  systemPromptField.value = settings.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  systemPromptField.addEventListener('input', checkChanges);
  systemPromptField.addEventListener('change', checkChanges);
}
const systemPromptReset = $('system-prompt-reset');
if (systemPromptReset) {
  systemPromptReset.onclick = () => {
    if (!systemPromptField) return;
    systemPromptField.value = DEFAULT_SYSTEM_PROMPT;
    checkChanges();
    notice('System Prompt dikembalikan ke default. Tekan Apply untuk menyimpan.');
  };
}

for (const id of ['ai-base-url-setting', 'ai-api-key-setting', 'ai-model-setting', 'stt-model-setting', 'hardware-setting', 'diarization-setting', 'wake-word-setting', 'silent-setting']) {
  const el = $(id);
  if (el) {
    el.addEventListener('input', () => { updateVramMeter(); checkChanges(); });
    el.addEventListener('change', () => { updateVramMeter(); checkChanges(); });
  }
}

// Test LLM Connection & Fetch Models
$('test-llm-btn').onclick = async () => {
  const statusEl = $('llm-test-status');
  const baseUrl = $('ai-base-url-setting').value.trim();
  const apiKey = $('ai-api-key-setting').value.trim();
  if (!baseUrl) {
    statusEl.style.color = '#dc2626';
    statusEl.textContent = '✗ Isi AI Base URL terlebih dahulu';
    return;
  }
  statusEl.style.color = '#183f36';
  statusEl.textContent = '⏳ Menguji koneksi & mengambil model...';
  try {
    const res = await (await api('llm/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey })
    })).json();

    if (res.ok && Array.isArray(res.models) && res.models.length > 0) {
      statusEl.style.color = '#059669';
      statusEl.textContent = `✓ Sukses! (${res.count} model ditemukan)`;

      const select = $('ai-model-setting');
      select.replaceChildren();

      res.models.forEach(modelId => {
        const opt = document.createElement('option');
        opt.value = modelId;
        if (modelId === 'gemini-3.1-flash-lite') {
          opt.textContent = `${modelId} (⚡ Rekomendasi Cepat & Hemat)`;
        } else {
          opt.textContent = modelId;
        }
        select.appendChild(opt);
      });

      if (res.recommended && res.models.includes(res.recommended)) {
        select.value = res.recommended;
      }
      checkChanges();
    } else {
      statusEl.style.color = '#d97706';
      statusEl.textContent = 'Terhubung, tapi tidak ada model ditemukan.';
    }
  } catch (err) {
    statusEl.style.color = '#dc2626';
    statusEl.textContent = `✗ Gagal: ${err.message}`;
  }
};

$('settings-apply').onclick = () => applyServerSettings();
$('settings-close-btn').onclick = () => { $('settings-dialog').close(); };
$('settings-close').onclick = () => { $('settings-dialog').close(); };
$('settings-dialog').onclick = e => { if (e.target === $('settings-dialog')) $('settings-dialog').close(); };
$('pose-browser-close').onclick = closePoseBrowser;
$('pose-browser-dialog').onclick = e => { if (e.target === $('pose-browser-dialog')) closePoseBrowser(); };

$('compact-memory-btn').onclick = async () => {
  notice('⏳ Sedang merangkum transkrip ke memori...');
  try {
    const res = await (await api('memory/compact', { method: 'POST' })).json();
    notice(res.message);
    if (res.ok && res.summary) {
      appendMessage('assistant', `[Rangkuman Memori Tersimpan]\n${res.summary}`, 'Memori Baru');
    }
  } catch (err) {
    notice('Gagal merangkum memori: ' + err.message);
  }
};

$('companion-name').textContent = settings.name;
$('rate-value').textContent = `${settings.rate}%`;
$('mic-button').onclick = () => state === 'listening' ? finishRecording() : startRecording();
$('stop-button').onclick = () => stopAll();
$('chat-form').onsubmit = e => { e.preventDefault(); unlockAudio(); sendMessage($('chat-input').value); };
$('chat-input').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!$('send-button').disabled) $('chat-form').requestSubmit(); } };
$('auto-talk').onchange = () => { if ($('auto-talk').checked && state === 'idle') startRecording(); else if (!$('auto-talk').checked) clearTimeout(autoTimer); };

$('test-voice').onclick = async () => {
  stopAll(); saveSettings(); controller = new AbortController(); const id = runId;
  try { await speak(`Hai, aku ${settings.name}. Suaraku sudah terdengar?`, id); continueListening(id); }
  catch (err) { notice(err.message); setState('idle'); }
};

$('clear-chat').onclick = () => {
  stopAll(); poseManagerStopPreview(); history = []; $('messages').replaceChildren();
  appendMessage('assistant', 'Kita mulai lagi. Ada yang ingin kamu ceritakan?');
  $('settings-dialog').close();
};

$('avatar-upload').onchange = async event => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 60 * 1024 * 1024) { notice('Pilih VRM di bawah 60 MB untuk menjaga memori.'); return; }
  const url = URL.createObjectURL(file);
  await avatar?.load(url);
  URL.revokeObjectURL(url);
  $('settings-dialog').close();
};

window.addEventListener('beforeunload', () => stopAll());
document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'listening') { stopAll(); notice('Mic dijeda saat halaman tidak aktif.'); } });

// Floating Action Dock buttons
$('desktop-mic-btn').onclick = () => {
  state === 'listening' ? finishRecording() : startRecording();
};

$('desktop-chat-toggle').onclick = () => {
  const conv = $('conversation-drawer');
  conv?.classList.toggle('desktop-closed');
  $('desktop-chat-toggle')?.classList.toggle('active', !conv?.classList.contains('desktop-closed'));
};

$('chat-drawer-close').onclick = () => {
  $('conversation-drawer')?.classList.add('desktop-closed');
  $('desktop-chat-toggle')?.classList.remove('active');
};

$('desktop-settings-btn').onclick = () => {
  $('settings-dialog').showModal();
  refreshDevices();
  loadServerSettings();
};

$('desktop-pose-btn').onclick = openPoseBrowser;

$('desktop-close-btn').onclick = () => {
  window.aichatDesktop?.close?.();
};

$('avatar-stage').addEventListener('contextmenu', e => {
  e.preventDefault();
  $('settings-dialog').showModal();
  refreshDevices();
  loadServerSettings();
});

// Keyboard shortcuts: M (mic), C (chat drawer), S (settings), Escape (close), Space (pause/resume preview)
window.addEventListener('keydown', e => {
  const activeElement = document.activeElement;
  const inPoseBrowser = isPoseWindow || Boolean($('pose-browser-dialog')?.open);
  const isSpace = e.code === 'Space' || e.key === ' ' || e.keyCode === 32;
  const isTextInput = activeElement?.tagName === 'TEXTAREA'
    || activeElement?.isContentEditable
    || (activeElement?.tagName === 'INPUT' && activeElement.id === 'pose-name' && !activeElement.disabled);

  if (inPoseBrowser && isSpace && !e.altKey && !e.ctrlKey && !e.metaKey && !isTextInput) {
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) {
      poseManagerTogglePreview();
    }
    return;
  }

  if (poseManager.keyframeDragging && e.key === 'Escape') {
    e.preventDefault();
    poseManagerCancelKeyframeDrag();
    return;
  }

  // Handle Pose Browser keyboard shortcuts with Ctrl / Cmd FIRST (before general input escape check)
  if (inPoseBrowser && (e.ctrlKey || e.metaKey)) {
    const isKeyC = e.code === 'KeyC' || e.key?.toLowerCase() === 'c' || e.keyCode === 67;
    const isKeyV = e.code === 'KeyV' || e.key?.toLowerCase() === 'v' || e.keyCode === 86;
    const isKeyZ = e.code === 'KeyZ' || e.key?.toLowerCase() === 'z' || e.keyCode === 90;
    const isKeyY = e.code === 'KeyY' || e.key?.toLowerCase() === 'y' || e.keyCode === 89;
    const isKeyA = e.code === 'KeyA' || e.key?.toLowerCase() === 'a' || e.keyCode === 65;

    // Only allow native text copy/paste/select-all if focused on actual text-editing input (#pose-name or textarea)
    if (!isTextInput) {
      if (isKeyZ) {
        e.preventDefault();
        e.stopPropagation();
        lastKeyframeClipboardActionTime = Date.now();
        e.shiftKey ? poseManagerRedo() : poseManagerUndo();
        return;
      }
      if (isKeyY) {
        e.preventDefault();
        e.stopPropagation();
        lastKeyframeClipboardActionTime = Date.now();
        poseManagerRedo();
        return;
      }
      if (isKeyC) {
        e.preventDefault();
        e.stopPropagation();
        lastKeyframeClipboardActionTime = Date.now();
        poseManagerCopyKeyframes();
        return;
      }
      if (isKeyV) {
        e.preventDefault();
        e.stopPropagation();
        lastKeyframeClipboardActionTime = Date.now();
        poseManagerPasteKeyframes();
        return;
      }
      if (isKeyA) {
        e.preventDefault();
        e.stopPropagation();
        poseManagerSelectAllKeyframes();
        return;
      }
    }
  }

  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(activeElement?.tagName)) {
    if (e.key === 'Escape') {
      activeElement.blur();
    }
    return;
  }
  if (e.key.toLowerCase() === 'm') {
    e.preventDefault();
    state === 'listening' ? finishRecording() : startRecording();
  } else if (e.key.toLowerCase() === 'c') {
    e.preventDefault();
    $('desktop-chat-toggle')?.click();
  } else if (e.key.toLowerCase() === 's') {
    e.preventDefault();
    $('desktop-settings-btn')?.click();
  } else if (e.key.toLowerCase() === 'p') {
    e.preventDefault();
    openPoseBrowser();
  } else if (e.key === 'Escape') {
    $('conversation-drawer')?.classList.add('desktop-closed');
    $('desktop-chat-toggle')?.classList.remove('active');
    if ($('pose-browser-dialog')?.open) closePoseBrowser();
    else $('settings-dialog')?.close();
  }
}, { capture: true });

let lastKeyframeClipboardActionTime = 0;

window.addEventListener('copy', e => {
  const inPoseBrowser = isPoseWindow || Boolean($('pose-browser-dialog')?.open);
  const activeElement = document.activeElement;
  const isTextInput = activeElement?.tagName === 'TEXTAREA'
    || activeElement?.isContentEditable
    || (activeElement?.tagName === 'INPUT' && activeElement.id === 'pose-name' && !activeElement.disabled);
  if (inPoseBrowser && !isTextInput) {
    if (Date.now() - lastKeyframeClipboardActionTime < 150) return;
    lastKeyframeClipboardActionTime = Date.now();
    e.preventDefault();
    poseManagerCopyKeyframes();
  }
});

window.addEventListener('paste', e => {
  const inPoseBrowser = isPoseWindow || Boolean($('pose-browser-dialog')?.open);
  const activeElement = document.activeElement;
  const isTextInput = activeElement?.tagName === 'TEXTAREA'
    || activeElement?.isContentEditable
    || (activeElement?.tagName === 'INPUT' && activeElement.id === 'pose-name' && !activeElement.disabled);
  if (inPoseBrowser && !isTextInput) {
    if (Date.now() - lastKeyframeClipboardActionTime < 150) return;
    lastKeyframeClipboardActionTime = Date.now();
    e.preventDefault();
    poseManagerPasteKeyframes();
  }
});


// Initialize 3D Avatar
try {
  const initialModelUrl = settings.avatarModel
    ? (settings.avatarModel.startsWith('http') || settings.avatarModel.startsWith('/')
        ? settings.avatarModel
        : `${import.meta.env.BASE_URL}${settings.avatarModel.replace(/^\/+/, '')}`)
    : undefined;
  avatar = new AvatarStage(isPoseWindow ? $('pose-preview-stage') : $('avatar-stage'), info => {
    if ($('avatar-error')) $('avatar-error').hidden = true;
    document.body.dataset.avatar = 'ready';
    window.avatarInfo = info;
    if (state === 'idle') setState(state);
    if (isPoseWindow) openPoseBrowser();
  }, err => {
    if ($('avatar-error')) {
      $('avatar-error').hidden = false;
      $('avatar-error').textContent = 'Avatar belum dapat dimuat. Ekspor VRoid ke public/avatar/character.vrm atau pilih Ganti VRM di pengaturan.';
    }
    document.body.dataset.avatar = 'error';
    console.error('Avatar load failed', err);
  }, {
    modelUrl: initialModelUrl,
    enablePan: isPoseWindow,
    enableArmatureEditor: isPoseWindow,
    onEditorBoneSelect: poseManagerSelectBone,
    onEditorDrag: poseManagerHandleEditorDrag,
    onEditorTransform: poseManagerApplyEditorTransform
  });
  avatar.fps = settings.fps;
} catch (err) {
  if ($('avatar-error')) {
    $('avatar-error').hidden = false;
    $('avatar-error').textContent = 'WebGL belum tersedia. Gunakan Edge/Chrome dengan akselerasi grafis.';
  }
  document.body.dataset.avatar = 'error';
}

window.aichatPoseDiagnostics = () => {
  const stage = posePreviewAvatar || avatar;
  const manager = stage?.vrm?.expressionManager;
  return {
    camera: stage?.camera?.position?.toArray?.() || null,
    target: stage?.controls?.target?.toArray?.() || null,
    preview: stage?.getPosePreviewState?.() || null,
    armature: stage?.getEditorState?.() || null,
    boneRotations: stage?.getEditorBoneRotations?.() || {},
    poseEditor: {
      selectedBone: poseManager.selectedBone,
      selectedTime: poseManager.selectedTime,
      selectedTimes: Array.from(poseManager.selectedTimes),
      clipboard: poseKeyframeClipboard ? {
        count: poseKeyframeClipboard.count,
        span: poseKeyframeClipboard.span,
        baseTime: poseKeyframeClipboard.baseTime,
        times: poseKeyframeClipboard.times
      } : null,
      undoDepth: poseHistory.undo.length,
      redoDepth: poseHistory.redo.length,
      draft: poseManager.draft,
      selectedBoneTrack: poseManager.draft?.tracks?.[poseManager.selectedBone] || [],
      currentInterpolation: poseManagerGetKeyframeInterpolation(poseManager.selectedTime)
    },
    mouth: {
      input: Number(stage?.mouth || 0),
      pose: stage?.poseController?.getExpressionValues?.() || {},
      expressions: manager ? Object.fromEntries(['aa', 'ih', 'ou', 'ee', 'oh'].map(name => [name, Number(manager.getValue(name) || 0)])) : null
    }
  };
};

async function updateHealth() {
  try {
    health = await (await api('health')).json();
    sttStartupChecked = true;
    const stt = health.stt || {};
    if (stt.loading) {
      startupNoticeActive = true;
      notice(`⏳ Memuat ${stt.model || 'STT'} ke ${stt.device || 'hardware'}…`);
    } else if (stt.loadError) {
      startupNoticeActive = true;
      notice(`Model STT gagal dimuat: ${stt.loadError}`);
    } else if (startupNoticeActive) {
      startupNoticeActive = false;
      notice('');
    }
    setState(state);
  } catch { }
}

setState('idle');
loadServerSettings();
updateHealth();
const startupHealthTimer = setInterval(() => {
  if (document.hidden) return;
  if (!sttStartupChecked || health?.stt?.loading) {
    updateHealth();
  } else {
    clearInterval(startupHealthTimer);
  }
}, 1000);
setInterval(() => { if (!document.hidden) updateHealth(); }, 30000);
