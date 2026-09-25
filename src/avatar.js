import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { PoseController } from './pose-controller.js';

const EDITOR_BONE_NAMES = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightUpperArm', 'rightLowerArm', 'rightHand'
];

export class AvatarStage {
  constructor(container, onReady, onError, options = {}) {
    this.container = container;
    this.options = options;
    this.editorEnabled = options.enableArmatureEditor === true;
    this.editorVisible = false;
    this.editorSelectedBone = null;
    this.editorMode = 'rotate';
    this.editorWasDragging = false;
    this.editorPointerDown = null;
    this.state = 'idle';
    this.emotion = 'neutral';
    this.mouth = 0;
    this.paused = false;
    this.fps = 30;
    this.time = 0;
    this.nextBlink = 2;
    this.blinkAt = -100;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-label', 'Avatar VRoid 3D yang beranimasi');
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 30);
    this.camera.position.set(0, 1.15, 3.5);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.95, 0);
    this.controls.enablePan = options.enablePan === true;
    this.controls.screenSpacePanning = true;
    this.controls.panSpeed = 0.8;
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    if (this.controls.enablePan) this.renderer.domElement.addEventListener('contextmenu', event => event.preventDefault());
    if (this.editorEnabled) {
      this.renderer.domElement.setAttribute('tabindex', '0');
      this.renderer.domElement.addEventListener('pointerdown', event => {
        if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
          document.activeElement.blur();
        }
        this.renderer.domElement.focus();
        if (event.button === 0) this.editorPointerDown = { x: event.clientX, y: event.clientY };
      });
      this.renderer.domElement.addEventListener('pointerup', event => {
        if (event.button !== 0 || !this.editorVisible || this.editorWasDragging || !this.editorPointerDown) return;
        const distance = Math.hypot(event.clientX - this.editorPointerDown.x, event.clientY - this.editorPointerDown.y);
        this.editorPointerDown = null;
        if (distance > 6) return;
        const picked = this.pickEditorBone(event.clientX, event.clientY);
        if (picked) this.selectEditorBone(picked);
      });
    }
    this.controls.minDistance = 1.3;
    this.controls.maxDistance = 5;
    this.controls.minPolarAngle = 0.3;
    this.controls.maxPolarAngle = Math.PI * 0.7;
    this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb1aaa2, 0.7));
    const key = new THREE.DirectionalLight(0xfff5e7, 1.0);
    key.position.set(-1, 3, 4);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xdaf2ed, 0.3);
    fill.position.set(3, 2, -2);
    this.scene.add(fill);
    this.target = new THREE.Object3D();
    this.target.position.set(0, 1.4, 4);
    this.scene.add(this.target);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.onReady = onReady;
    this.onError = onError;
    this.lastFrame = 0;
    this.lastUpdate = 0;
    this.animate = this.animate.bind(this);
    this.raf = requestAnimationFrame(this.animate);
    this.currentModelUrl = options.modelUrl || `${import.meta.env.BASE_URL}avatar/character.vrm`;
    this.load(this.currentModelUrl);
  }

  resize() {
    const { width, height } = this.container.getBoundingClientRect();
    this.renderer.setSize(width, height);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  async load(url) {
    this.currentModelUrl = url;
    try {
      const loader = new GLTFLoader();
      loader.register(parser => new VRMLoaderPlugin(parser));
      const gltf = await loader.loadAsync(url);
      const vrm = gltf.userData.vrm;
      if (!vrm) throw Error('File bukan model VRM yang valid.');
      VRMUtils.rotateVRM0(vrm);
      VRMUtils.combineSkeletons(vrm.scene);
      VRMUtils.combineMorphs(vrm);
      if (this.vrm) {
        this.scene.remove(this.vrm.scene);
        VRMUtils.deepDispose(this.vrm.scene);
      }
      this.vrm = vrm;
      this.scene.add(vrm.scene);
      this.bones = {};
      for (const name of ['hips', 'spine', 'chest', 'head', 'neck', 'leftUpperArm', 'rightUpperArm',
        'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand']) {
        this.bones[name] = vrm.humanoid.getNormalizedBoneNode(name);
      }
      this.poseController = new PoseController(this.bones);
      this.poseController.setState(this.state, this.time);
      await this.poseController.load();
      this.setupArmatureEditor();
      if (vrm.lookAt) vrm.lookAt.target = this.target;
      this.onReady({
        name: vrm.meta?.name || 'Karakter VRoid',
        bones: Object.keys(vrm.humanoid.humanBones).length,
        expressions: Object.keys(vrm.expressionManager?.expressionMap || {})
      });
    } catch (err) { this.onError(err); }
  }

  setState(state) {
    if (this.state !== state) this.poseController?.clearPreview();
    this.state = state;
    this.poseController?.setState(state, this.time);
  }
  react(emotion = 'happy', gesture = 'wave') {
    this.emotion = emotion;
    this.poseController?.clearPreview();
    this.poseController?.react(gesture, this.time);
  }
  getPoseNames() {
    return this.poseController?.getPoseNames() || [];
  }
  getPoseClip(name) {
    return this.poseController?.getClip(name) || null;
  }
  setPoseClip(clip) {
    return this.poseController?.setClip(clip) || false;
  }
  setupArmatureEditor() {
    if (!this.editorEnabled || !this.vrm) return;
    this.editorBoneNames = EDITOR_BONE_NAMES.filter(name => this.bones?.[name]);
    const editableBones = new Set(this.editorBoneNames.map(name => this.bones[name]));
    this.armaturePairs = [];
    for (const name of this.editorBoneNames) {
      const bone = this.bones[name];
      let parent = bone?.parent || null;
      while (parent && !editableBones.has(parent)) parent = parent.parent;
      if (parent && parent !== bone) this.armaturePairs.push([parent, bone]);
    }

    if (this.armatureHelper) {
      this.scene.remove(this.armatureHelper);
      this.armatureLineGeometry?.dispose();
      this.armatureJointGeometry?.dispose();
      this.armatureHelper = null;
    }

    // Draw only the normalized humanoid armature. The VRM scene also contains
    // hair/accessory spring bones; those are physics bones and are intentionally
    // omitted from the editor so they cannot obscure or steal bone clicks.
    this.armatureLineGeometry = new THREE.BufferGeometry();
    this.armatureLineGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(new Float32Array(this.armaturePairs.length * 6), 3)
    );
    this.armatureLines = new THREE.LineSegments(this.armatureLineGeometry, new THREE.LineBasicMaterial({
      color: 0xf4c542,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false
    }));
    this.armatureLines.renderOrder = 20;

    this.armatureJointGeometry = new THREE.BufferGeometry();
    this.armatureJointGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(new Float32Array(this.editorBoneNames.length * 3), 3)
    );
    this.armatureJoints = new THREE.Points(this.armatureJointGeometry, new THREE.PointsMaterial({
      color: 0xffe47a,
      size: 10,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false
    }));
    this.armatureJoints.renderOrder = 21;
    this.armatureHelper = new THREE.Group();
    this.armatureHelper.add(this.armatureLines, this.armatureJoints);
    this.armatureHelper.visible = !!this.editorVisible;
    this.scene.add(this.armatureHelper);
    this.updateArmatureHelper();

    if (!this.transformControls) {
      this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
      this.transformControls.setMode(this.editorMode);
      this.transformControls.setSpace('local');
      this.transformControls.setSize(0.72);
      this.transformControls.getHelper().renderOrder = 25;
      this.transformControls.getHelper().visible = false;
      this.scene.add(this.transformControls.getHelper());
      this.transformControls.addEventListener('dragging-changed', event => {
        this.editorWasDragging = !!event.value;
        this.controls.enabled = !event.value;
        this.options.onEditorDrag?.(!!event.value);
      });
      this.transformControls.addEventListener('objectChange', () => {
        const bone = this.bones?.[this.editorSelectedBone];
        if (!bone || !this.editorVisible) return;
        const transform = this.getEditorBoneTransform(this.editorSelectedBone);
        this.options.onEditorTransform?.({
          bone: this.editorSelectedBone,
          rotation: transform.rotation,
          position: transform.position
        });
      });
    } else {
      this.transformControls.detach();
      if (this.editorSelectedBone && this.editorVisible) {
        const bone = this.bones?.[this.editorSelectedBone];
        if (bone) {
          this.transformControls.attach(bone);
          this.transformControls.getHelper().visible = true;
        }
      }
    }
  }
  pickEditorBone(clientX, clientY) {
    if (!this.vrm || !this.bones || !this.editorBoneNames?.length) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointerX = clientX - rect.left;
    const pointerY = clientY - rect.top;
    let selected = null;
    let closest = 42;
    const projected = new THREE.Vector3();
    for (const name of this.editorBoneNames) {
      const bone = this.bones[name];
      if (!bone) continue;
      bone.getWorldPosition(projected);
      projected.project(this.camera);
      if (projected.z < -1 || projected.z > 1) continue;
      const x = (projected.x * 0.5 + 0.5) * rect.width;
      const y = (-projected.y * 0.5 + 0.5) * rect.height;
      const distance = Math.hypot(pointerX - x, pointerY - y);
      if (distance < closest) {
        selected = name;
        closest = distance;
      }
    }
    return selected;
  }
  setArmatureEditorVisible(visible) {
    this.editorVisible = !!visible && this.editorEnabled && !!this.vrm;
    if (this.armatureHelper) this.armatureHelper.visible = this.editorVisible;
    if (this.transformControls) {
      if (this.editorVisible) this.transformControls.getHelper().visible = true;
      else {
        this.transformControls.detach();
        this.transformControls.getHelper().visible = false;
        this.editorSelectedBone = null;
      }
    }
  }
  setEditorTool(mode = 'rotate') {
    this.editorMode = 'rotate';
    this.transformControls?.setMode('rotate');
  }
  selectEditorBone(name) {
    const bone = this.bones?.[name];
    if (!bone || !this.editorVisible || !this.transformControls) return false;
    this.editorSelectedBone = name;
    this.transformControls.attach(bone);
    this.transformControls.getHelper().visible = true;
    this.options.onEditorBoneSelect?.(name);
    return true;
  }
  getEditorBoneNames() {
    return [...(this.editorBoneNames || Object.keys(this.bones || {}).filter(name => this.bones[name]))];
  }
  getEditorState() {
    return {
      visible: this.editorVisible,
      selectedBone: this.editorSelectedBone,
      mode: this.editorMode,
      boneCount: this.getEditorBoneNames().length,
      hiddenBoneCount: Math.max(0, this.vrm?.scene?.getObjectsByProperty?.('type', 'Bone')?.length - this.getEditorBoneNames().length || 0)
    };
  }
  getEditorBoneRotations() {
    return Object.fromEntries(this.getEditorBoneNames().map(name => [
      name,
      this.bones[name]?.quaternion?.toArray?.() || null
    ]));
  }
  getEditorBoneTransform(name = this.editorSelectedBone) {
    const bone = this.bones?.[name];
    if (!bone) return null;
    const rest = this.poseController?.restPositions?.get(name);
    return {
      bone: name,
      rotation: [bone.rotation.x, bone.rotation.y, bone.rotation.z],
      position: [
        bone.position.x - (rest?.x || 0),
        bone.position.y - (rest?.y || 0),
        bone.position.z - (rest?.z || 0)
      ]
    };
  }
  getEditorBoneRestTransform(name = this.editorSelectedBone) {
    if (!this.bones?.[name]) return null;
    const restRotation = this.poseController?.restRotations?.get(name);
    if (!restRotation) return null;
    const euler = new THREE.Euler().setFromQuaternion(restRotation, 'XYZ');
    return {
      bone: name,
      rotation: [euler.x, euler.y, euler.z],
      position: [0, 0, 0]
    };
  }
  isBuiltinPose(name) {
    return this.poseController?.isBuiltin(name) || false;
  }
  hasPoseOverride(name) {
    return this.poseController?.hasOverride(name) || false;
  }
  savePoseClip(clip) {
    return this.poseController?.saveClip(clip) || false;
  }
  renameCustomPose(oldName, clip) {
    return this.poseController?.renameCustomClip(oldName, clip) || false;
  }
  resetPose(name) {
    return this.poseController?.resetClip(name) || false;
  }
  removeCustomPose(name) {
    return this.poseController?.removeCustomClip(name) || false;
  }
  previewPose(name, loop = true) {
    return this.poseController?.preview(name, this.time, loop) || false;
  }
  pausePosePreview() {
    return this.poseController?.pausePreview(this.time) || false;
  }
  resumePosePreview() {
    return this.poseController?.resumePreview(this.time) || false;
  }
  seekPosePreview(seconds) {
    return this.poseController?.seekPreview(this.time, seconds) || false;
  }
  getPosePreviewState() {
    return this.poseController?.getPreviewState(this.time) || { name: null, elapsed: 0, duration: 0, loop: false, paused: false };
  }
  stopPosePreview() {
    this.poseController?.clearPreview();
  }
  resetView() {
    this.camera.position.set(0, 1.15, 3.5);
    this.controls.target.set(0, 0.95, 0);
  }
  updateArmatureHelper() {
    if (!this.armatureHelper?.visible || !this.bones) return;
    const from = new THREE.Vector3();
    const to = new THREE.Vector3();
    const line = this.armatureLineGeometry?.getAttribute('position');
    for (let index = 0; index < (this.armaturePairs?.length || 0); index += 1) {
      const [parent, bone] = this.armaturePairs[index];
      parent.getWorldPosition(from);
      bone.getWorldPosition(to);
      line.setXYZ(index * 2, from.x, from.y, from.z);
      line.setXYZ(index * 2 + 1, to.x, to.y, to.z);
    }
    if (line) line.needsUpdate = true;
    const joints = this.armatureJointGeometry?.getAttribute('position');
    for (let index = 0; index < (this.editorBoneNames?.length || 0); index += 1) {
      const bone = this.bones[this.editorBoneNames[index]];
      bone.getWorldPosition(to);
      joints.setXYZ(index, to.x, to.y, to.z);
    }
    if (joints) joints.needsUpdate = true;
  }
  animate(now) {
    this.raf = requestAnimationFrame(this.animate);
    if (document.hidden || this.paused) { this.lastUpdate = now; return; }
    if (now - this.lastFrame < 1000 / this.fps - 0.5) return;
    this.lastFrame = now;
    const dt = Math.min(0.06, (now - (this.lastUpdate || now)) / 1000);
    this.lastUpdate = now;
    this.time += dt;
    const t = this.time;
    if (this.vrm) {
      const talk = this.state === 'speaking';
      const previewFrozen = this.poseController?.previewPaused === true;
      this.poseController?.update(t, dt);
      if (!previewFrozen && t > this.nextBlink) {
        this.blinkAt = t;
        this.nextBlink = t + 2.5 + Math.random() * 3;
      }
      const blinkAge = previewFrozen ? -1 : t - this.blinkAt;
      const blink = blinkAge < 0.16 ? Math.sin(blinkAge / 0.16 * Math.PI) : 0;
      const manager = this.vrm.expressionManager;
      if (manager) {
        manager.setValue('blink', Math.max(0, blink));
        for (const name of ['happy', 'sad', 'relaxed', 'surprised', 'angry']) {
          const reacting = this.poseController?.gesture && t < this.poseController.gestureEndsAt;
          const active = (talk || reacting) && name === this.emotion;
          const current = manager.getValue(name) || 0;
          manager.setValue(name, THREE.MathUtils.lerp(current, active ? 0.45 : name === 'relaxed' ? 0.08 : 0, dt * 6));
        }
        const poseExpressions = this.poseController?.getExpressionValues?.() || {};
        const audioAmplitude = THREE.MathUtils.clamp(this.mouth, 0, 1);
        const poseMouth = Math.max(
          0,
          ...['aa', 'ih', 'ou', 'ee', 'oh'].map(name => Number(poseExpressions[name]) || 0)
        );
        const amplitude = THREE.MathUtils.clamp(Math.max(audioAmplitude, poseMouth), 0, 1);
        manager.setValue('aa', Math.max(Number(poseExpressions.aa) || 0, amplitude * 0.8));
        manager.setValue('ih', Math.max(Number(poseExpressions.ih) || 0, audioAmplitude * (0.15 + 0.12 * Math.sin(t * 15))));
        manager.setValue('ou', Math.max(Number(poseExpressions.ou) || 0, audioAmplitude * (0.12 + 0.1 * Math.cos(t * 12))));
        manager.setValue('ee', Number(poseExpressions.ee) || 0);
        manager.setValue('oh', Number(poseExpressions.oh) || 0);
      }
      this.vrm.update(previewFrozen ? 0 : dt);
    }
    this.updateArmatureHelper();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.renderedFrames = (this.renderedFrames || 0) + 1;
  }
}
