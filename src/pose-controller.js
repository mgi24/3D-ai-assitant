import * as THREE from 'three';

export const POSE_FILES = ['idle', 'listening', 'thinking', 'speaking', 'wave', 'nod', 'talk', 'think'];
const POSE_STORAGE_KEY = 'aichat-pose-overrides';
const STATE_POSES = {
  idle: 'idle',
  listening: 'listening',
  transcribing: 'thinking',
  thinking: 'thinking',
  preparing: 'thinking',
  speaking: 'speaking'
};

function frameTime(clip, elapsed) {
  if (clip.loop) return ((elapsed % clip.duration) + clip.duration) % clip.duration;
  return THREE.MathUtils.clamp(elapsed, 0, clip.duration);
}

function applyEasing(alpha, mode = 'linear') {
  const t = THREE.MathUtils.clamp(alpha, 0, 1);
  switch (mode) {
    case 'easeInOut':
    case 'smooth':
      return t * t * (3 - 2 * t);
    case 'easeIn':
      return t * t;
    case 'easeOut':
      return t * (2 - t);
    case 'step':
    case 'constant':
      return t >= 1 ? 1 : 0;
    case 'linear':
    default:
      return t;
  }
}

function findFrames(frames, time) {
  if (time <= frames[0].time) return [frames[0], frames[0], 0];
  for (let index = 1; index < frames.length; index++) {
    if (time <= frames[index].time) {
      const previous = frames[index - 1];
      const next = frames[index];
      const span = Math.max(0.0001, next.time - previous.time);
      const rawAlpha = THREE.MathUtils.clamp((time - previous.time) / span, 0, 1);
      const alpha = applyEasing(rawAlpha, previous.interpolation || 'linear');
      return [previous, next, alpha];
    }
  }
  const last = frames.at(-1);
  return [last, last, 0];
}

function sampleRotation(frames, time) {
  const [from, to, alpha] = findFrames(frames, time);
  const fromQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...from.rotation, 'XYZ'));
  if (from === to) return fromQuat;
  const toQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...to.rotation, 'XYZ'));
  return fromQuat.slerp(toQuat, alpha);
}

function samplePosition(frames, time) {
  const [from, to, alpha] = findFrames(frames, time);
  const start = new THREE.Vector3(...from.position);
  if (from === to) return start;
  return start.lerp(new THREE.Vector3(...to.position), alpha);
}

function sampleValue(frames, time) {
  const [from, to, alpha] = findFrames(frames, time);
  const fromValue = Number(from.value ?? from.weight ?? from.amount ?? 0);
  if (from === to) return Number.isFinite(fromValue) ? fromValue : 0;
  const toValue = Number(to.value ?? to.weight ?? to.amount ?? 0);
  return THREE.MathUtils.lerp(
    Number.isFinite(fromValue) ? fromValue : 0,
    Number.isFinite(toValue) ? toValue : 0,
    alpha
  );
}

function cloneClip(clip) {
  return JSON.parse(JSON.stringify(clip));
}

function readStoredOverrides() {
  try {
    const value = JSON.parse(localStorage.getItem(POSE_STORAGE_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function writeStoredOverrides(overrides) {
  try { localStorage.setItem(POSE_STORAGE_KEY, JSON.stringify(overrides)); } catch { }
}

function validClip(clip) {
  return clip && typeof clip === 'object' && typeof clip.name === 'string'
    && Number.isFinite(Number(clip.duration)) && Number(clip.duration) > 0
    && clip.tracks && typeof clip.tracks === 'object';
}

export class PoseController {
  constructor(bones) {
    this.bones = bones;
    this.restRotations = new Map();
    this.restPositions = new Map();
    for (const [name, bone] of Object.entries(bones)) {
      if (!bone) continue;
      this.restRotations.set(name, bone.quaternion.clone());
      this.restPositions.set(name, bone.position.clone());
    }
    this.clips = new Map();
    this.baseClips = new Map();
    this.builtinNames = new Set(POSE_FILES);
    this.state = 'idle';
    this.stateStartedAt = 0;
    this.gesture = null;
    this.gestureStartedAt = 0;
    this.gestureEndsAt = 0;
    this.previewName = null;
    this.previewStartedAt = 0;
    this.previewLoop = true;
    this.previewPaused = false;
    this.previewElapsed = 0;
    this.expressionValues = {};
  }

  async load() {
    const base = import.meta.env.BASE_URL;
    const loaded = await Promise.all(POSE_FILES.map(async name => {
      const response = await fetch(`${base}poses/${name}.json?poseVersion=${Date.now()}`);
      if (!response.ok) throw new Error(`Pose ${name} tidak dapat dimuat (${response.status}).`);
      const clip = await response.json();
      if (!Number.isFinite(clip.duration) || clip.duration <= 0 || !clip.tracks) {
        throw new Error(`Definisi pose ${name} tidak valid.`);
      }
      return [name, clip];
    }));
    this.baseClips = new Map(loaded.map(([name, clip]) => [name, cloneClip(clip)]));
    this.clips = new Map(loaded);
    for (const [name, stored] of Object.entries(readStoredOverrides())) {
      const base = this.baseClips.get(name) || {};
      const clip = {
        ...base,
        ...stored,
        name,
        tracks: stored.tracks || base.tracks || {},
        positionTracks: stored.positionTracks || base.positionTracks || {},
        expressionTracks: stored.expressionTracks || base.expressionTracks || {}
      };
      if (validClip(clip)) this.clips.set(name, clip);
    }
  }

  getPoseNames() {
    return [...this.clips.keys()];
  }

  getClip(name) {
    const clip = this.clips.get(name);
    return clip ? cloneClip(clip) : null;
  }

  isBuiltin(name) {
    return this.builtinNames.has(name);
  }

  hasOverride(name) {
    return Object.prototype.hasOwnProperty.call(readStoredOverrides(), name);
  }

  setClip(clip) {
    if (!validClip(clip)) return false;
    const normalized = cloneClip(clip);
    this.clips.set(normalized.name, normalized);
    return true;
  }

  saveClip(clip) {
    if (!this.setClip(clip)) return false;
    const overrides = readStoredOverrides();
    overrides[clip.name] = cloneClip(clip);
    writeStoredOverrides(overrides);
    return true;
  }

  renameCustomClip(oldName, newClip) {
    if (this.isBuiltin(oldName) || this.clips.has(newClip.name) && oldName !== newClip.name) return false;
    this.clips.delete(oldName);
    const overrides = readStoredOverrides();
    delete overrides[oldName];
    overrides[newClip.name] = cloneClip(newClip);
    writeStoredOverrides(overrides);
    return this.setClip(newClip);
  }

  resetClip(name) {
    const base = this.baseClips.get(name);
    if (!base) return false;
    this.clips.set(name, cloneClip(base));
    const overrides = readStoredOverrides();
    delete overrides[name];
    writeStoredOverrides(overrides);
    return true;
  }

  removeCustomClip(name) {
    if (this.isBuiltin(name)) return false;
    this.clips.delete(name);
    const overrides = readStoredOverrides();
    delete overrides[name];
    writeStoredOverrides(overrides);
    if (this.previewName === name) this.clearPreview();
    return true;
  }

  setState(state, time) {
    if (this.state === state) return;
    this.state = state;
    this.stateStartedAt = time;
  }

  preview(name, time, loop = true) {
    if (!this.clips.has(name)) return false;
    this.previewName = name;
    this.previewStartedAt = time;
    this.previewLoop = loop;
    this.previewPaused = false;
    this.previewElapsed = 0;
    this.gesture = null;
    return true;
  }

  pausePreview(time) {
    if (!this.previewName || this.previewPaused) return false;
    this.previewElapsed = Math.max(0, time - this.previewStartedAt);
    this.previewPaused = true;
    return true;
  }

  resumePreview(time) {
    if (!this.previewName || !this.previewPaused) return false;
    this.previewStartedAt = time - this.previewElapsed;
    this.previewPaused = false;
    return true;
  }

  seekPreview(time, elapsed) {
    if (!this.previewName) return false;
    const clip = this.clips.get(this.previewName);
    if (!clip) return false;
    const duration = Math.max(0.0001, Number(clip.duration) || 0.0001);
    const requested = Math.max(0, Number(elapsed) || 0);
    this.previewElapsed = this.previewLoop
      ? ((requested % duration) + duration) % duration
      : THREE.MathUtils.clamp(requested, 0, duration);
    this.previewStartedAt = time - this.previewElapsed;
    return true;
  }

  getPreviewState(time) {
    const clip = this.previewName ? this.clips.get(this.previewName) : null;
    if (!clip) return { name: null, elapsed: 0, duration: 0, loop: false, paused: false };
    const duration = Math.max(0.0001, Number(clip.duration) || 0.0001);
    const rawElapsed = this.previewPaused ? this.previewElapsed : Math.max(0, time - this.previewStartedAt);
    const elapsed = this.previewLoop
      ? ((rawElapsed % duration) + duration) % duration
      : THREE.MathUtils.clamp(rawElapsed, 0, duration);
    return { name: clip.name, elapsed, duration, loop: this.previewLoop, paused: this.previewPaused };
  }

  getExpressionValues() {
    return { ...this.expressionValues };
  }

  clearPreview() {
    this.previewName = null;
    this.previewPaused = false;
    this.previewElapsed = 0;
  }

  react(gesture, time, durationSeconds) {
    if (!gesture || gesture === 'none' || !this.clips.has(gesture)) {
      this.gesture = null;
      this.gestureEndsAt = time;
      return;
    }
    const clip = this.clips.get(gesture);
    this.gesture = gesture;
    this.gestureStartedAt = time;
    this.gestureEndsAt = time + (durationSeconds ?? (clip.loop ? 4 : clip.duration));
  }

  update(time, dt) {
    if (!this.clips.has('idle')) return;
    const statePose = STATE_POSES[this.state] || 'idle';
    const stateClip = this.clips.get(statePose);
    const gestureClip = this.gesture && time < this.gestureEndsAt ? this.clips.get(this.gesture) : null;
    if (!gestureClip && this.gesture) this.gesture = null;

    const previewClip = this.previewName ? this.clips.get(this.previewName) : null;
    // A preview is the editor's source of truth. Do not layer the live idle
    // animation underneath it: while paused that would keep the avatar
    // moving even though the selected preview time is frozen.
    const active = [];
    if (previewClip) {
      const clip = this.previewLoop ? { ...previewClip, loop: true } : previewClip;
      const elapsed = this.previewPaused ? this.previewElapsed : time - this.previewStartedAt;
      active.push({ clip, elapsed });
    } else {
      active.push({ clip: this.clips.get('idle'), elapsed: time });
      if (statePose !== 'idle' && stateClip) active.push({ clip: stateClip, elapsed: time - this.stateStartedAt });
      if (gestureClip) active.push({ clip: gestureClip, elapsed: time - this.gestureStartedAt });
    }

    const rotations = new Map([...this.restRotations].map(([name, value]) => [name, value.clone()]));
    const positions = new Map([...this.restPositions].map(([name, value]) => [name, value.clone()]));
    const expressions = new Map();
    for (const { clip, elapsed } of active) {
      const sampleAt = frameTime(clip, elapsed);
      for (const [name, frames] of Object.entries(clip.tracks || {})) {
        if (rotations.has(name) && frames.length) rotations.set(name, sampleRotation(frames, sampleAt));
      }
      for (const [name, frames] of Object.entries(clip.positionTracks || {})) {
        if (positions.has(name) && frames.length) {
          positions.set(name, this.restPositions.get(name).clone().add(samplePosition(frames, sampleAt)));
        }
      }
      for (const [name, frames] of Object.entries(clip.expressionTracks || {})) {
        if (Array.isArray(frames) && frames.length) expressions.set(name, THREE.MathUtils.clamp(sampleValue(frames, sampleAt), 0, 1));
      }
    }

    this.expressionValues = Object.fromEntries(expressions);

    const transitionSeconds = previewClip?.transitionSeconds ?? gestureClip?.transitionSeconds ?? stateClip?.transitionSeconds ?? 0.32;
    // When previewing in the Pose Editor, armature must reach exact keyframe targets at 100% fidelity.
    // Continuous exponential damping during playback causes fast gestures (like waving) to attenuate to half-amplitude.
    const isEditorPreview = Boolean(previewClip);
    const blend = isEditorPreview
      ? 1
      : 1 - Math.exp(-Math.max(0, dt) / Math.max(0.04, transitionSeconds));
    for (const [name, bone] of Object.entries(this.bones)) {
      const targetRotation = rotations.get(name);
      const targetPosition = positions.get(name);
      if (!bone) continue;
      if (blend >= 1) {
        if (targetRotation) bone.quaternion.copy(targetRotation);
        if (targetPosition) bone.position.copy(targetPosition);
      } else {
        if (targetRotation) bone.quaternion.slerp(targetRotation, blend);
        if (targetPosition) bone.position.lerp(targetPosition, blend);
      }
    }

    document.body.dataset.pose = active.map(({ clip }) => clip.name).join('+');
  }
}
