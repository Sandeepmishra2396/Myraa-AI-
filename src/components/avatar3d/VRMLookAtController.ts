/**
 * VRMLookAtController.ts
 *
 * Organic Human Eye & Head Gaze Tracking:
 *  1. Smooth cursor tracking (primary target in world space).
 *  2. Micro-saccades: Human eyes make rapid subtle micro-jumps (every 1.5-3.0s)
 *     with stable fixation pauses rather than robotic continuous tracking.
 *  3. Occasional side glances: Brief organic curiosity look-away every 6-9s.
 *  4. Listening State: Locks steady attentive eye contact with the user.
 *  5. Thinking State: Natural cognitive gaze shift (looks upward and away).
 *  6. Talking State: Natural conversational eye motion matching speech.
 */
import * as THREE from "three";
import { VRM } from "@pixiv/three-vrm";
import { LiveState } from "../../lib/audio";

// Tracked smoothed coordinates
let smoothTargetX = 0;
let smoothTargetY = 0;
const BASE_LERP = 0.055;

// Saccades and Gaze Wander State
let saccadeTimer = 0;
let nextSaccadeInterval = 2.0;
let saccadeOffsetX = 0;
let saccadeOffsetY = 0;

let glanceTimer = 0;
let nextGlanceInterval = 7.0;
let isGlancing = false;
let glanceProgress = 0;
let glanceDirX = 0.25;

// Reusable 3D look-at target object
const lookAtTarget = new THREE.Object3D();
let targetAdded = false;

/** Initialize look-at target and attach to scene */
export function initLookAt(vrm: VRM, scene: THREE.Scene): void {
  if (!vrm.lookAt) return;
  if (!targetAdded) {
    scene.add(lookAtTarget);
    targetAdded = true;
  }
  vrm.lookAt.target = lookAtTarget;
  vrm.lookAt.autoUpdate = true;
}

/**
 * Update look-at target based on mouse position and psychological gaze behaviors.
 */
export function updateLookAt(
  mouseNormX: number,
  mouseNormY: number,
  headWorldPosition: THREE.Vector3,
  delta = 0.016,
  characterState: "idle" | "thinking" | "talking" = "idle",
  liveState: LiveState = "disconnected"
): void {
  const dt = Math.min(delta, 0.1);

  // 1. Saccade Generator (Quick micro-shifts in eye fixation)
  saccadeTimer += dt;
  if (saccadeTimer >= nextSaccadeInterval) {
    saccadeTimer = 0;
    nextSaccadeInterval = 1.4 + Math.random() * 2.2;
    // Micro-displacement in world meters (~±0.06m at 2m distance is ~1.7°)
    saccadeOffsetX = (Math.random() - 0.5) * 0.12;
    saccadeOffsetY = (Math.random() - 0.5) * 0.08;
  }

  // 2. Side Glance Generator (Occasional natural side wander)
  glanceTimer += dt;
  if (!isGlancing && glanceTimer >= nextGlanceInterval) {
    isGlancing = true;
    glanceProgress = 0;
    glanceDirX = Math.random() > 0.5 ? 0.35 : -0.35;
  }
  let currentGlanceOffset = 0;
  if (isGlancing) {
    glanceProgress += dt / 1.2; // 1.2s glance duration
    if (glanceProgress >= 1) {
      isGlancing = false;
      glanceTimer = 0;
      nextGlanceInterval = 5.5 + Math.random() * 4.5;
    } else {
      // Smooth bell curve out and back
      currentGlanceOffset = Math.sin(glanceProgress * Math.PI) * glanceDirX;
    }
  }

  // 3. State-Based Gaze Modulation
  let stateOffsetX = 0;
  let stateOffsetY = 0;
  let lerpSpeed = BASE_LERP;

  if (characterState === "thinking") {
    // Classic human thinking/recall gaze: look up and slightly away
    stateOffsetY = 0.45;
    stateOffsetX = 0.28;
    lerpSpeed = 0.04; // contemplative slower drift
  } else if (liveState === "listening") {
    // Attentive listening: lock steady onto user with almost zero wander
    saccadeOffsetX *= 0.2;
    saccadeOffsetY *= 0.2;
    currentGlanceOffset = 0;
    lerpSpeed = 0.08; // responsive eye contact
  } else if (characterState === "talking") {
    // Conversational pacing
    stateOffsetY = Math.sin(Date.now() * 0.002) * 0.04;
  }

  // 4. Base Cursor Target Mapping ([-1.5m, +1.5m] laterally, [head - 0.8m, head + 0.8m] vertically)
  const baseTargetX = (mouseNormX - 0.5) * 3.0;
  const baseTargetY = -(mouseNormY - 0.5) * 1.8 + headWorldPosition.y;

  const targetX = baseTargetX + saccadeOffsetX + currentGlanceOffset + stateOffsetX;
  const targetY = baseTargetY + saccadeOffsetY + stateOffsetY;

  // Smooth lerp
  smoothTargetX += (targetX - smoothTargetX) * lerpSpeed;
  smoothTargetY += (targetY - smoothTargetY) * lerpSpeed;

  lookAtTarget.position.set(
    headWorldPosition.x + smoothTargetX,
    smoothTargetY,
    headWorldPosition.z + 2.2 // 2.2m in front of avatar
  );
}

/** Cleanup when VRM is unloaded */
export function cleanupLookAt(scene: THREE.Scene): void {
  scene.remove(lookAtTarget);
  targetAdded = false;
  smoothTargetX = 0;
  smoothTargetY = 0;
  saccadeTimer = 0;
  glanceTimer = 0;
  isGlancing = false;
}
