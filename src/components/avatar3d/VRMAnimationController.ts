/**
 * VRMAnimationController.ts
 *
 * Phase 2 Upgraded Animation Engine:
 * 1. State-Based Facial Expression Blending:
 *    - Idle: Neutral + subtle Relaxed
 *    - Listening: Attentive focus (alert open eyes, slight listening forward lean)
 *    - Thinking: Contemplative/curious (head tilt + look up + slight surprised blend)
 *    - Talking: Natural warm smile + speech cadence
 *    - Success / Proud: Happy (0.85)
 *    - Error: Concerned / Sad (0.65)
 *    - Greeting / Playful: Happy (0.8) + welcoming nod
 * 2. Natural Standing Pose (No T-pose):
 *    - Arms relaxed at sides (~70° down from horizontal)
 *    - Gentle elbow bend and natural wrist orientation
 * 3. Layered Idle Animation:
 *    - Organic harmonic breathing (15.3 breaths/min with harmonic richness)
 *    - Pelvic weight shifting and gentle spine counter-sway
 *    - Natural alive head micro-drifting
 *    - Realistic randomized auto-blinking (2.4s - 5.6s)
 * 4. Hair & Clothing Secondary Physics (SpringBone Wind Simulation):
 *    - Dynamic ambient breeze applied to VRM SpringBone gravity direction
 *    - Causes hair strands and cloth to sway organically in space
 */
import * as THREE from "three";
import { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import { MyraaEmotion } from "../MyraaCoreVisualizer";
import { LiveState } from "../../lib/audio";

export class VRMAnimationController {
  private vrm: VRM;
  private time = 0;

  // Natural Blinking State
  private blinkTimer = 0;
  private nextBlinkInterval = 3.2;
  private isBlinking = false;
  private blinkProgress = 0;
  private readonly BLINK_DURATION = 0.15; // 150ms quick natural blink

  // Smooth State Blend Weights
  private stateBlend = {
    thinking: 0,
    talking: 0,
    listening: 0,
    sitting: 0,
    walking: 0,
    happy: 0,
    sad: 0,
  };

  // Greeting nod trigger
  private greetingNodProgress = 0;

  // Cached bone references for high-performance 60 FPS update
  private bones: {
    leftUpperArm: THREE.Object3D | null;
    rightUpperArm: THREE.Object3D | null;
    leftLowerArm: THREE.Object3D | null;
    rightLowerArm: THREE.Object3D | null;
    leftHand: THREE.Object3D | null;
    rightHand: THREE.Object3D | null;
    leftShoulder: THREE.Object3D | null;
    rightShoulder: THREE.Object3D | null;
    spine: THREE.Object3D | null;
    chest: THREE.Object3D | null;
    upperChest: THREE.Object3D | null;
    neck: THREE.Object3D | null;
    head: THREE.Object3D | null;
    hips: THREE.Object3D | null;
    leftUpperLeg: THREE.Object3D | null;
    rightUpperLeg: THREE.Object3D | null;
    leftLowerLeg: THREE.Object3D | null;
    rightLowerLeg: THREE.Object3D | null;
  };

  constructor(vrm: VRM) {
    this.vrm = vrm;

    const humanoid = vrm.humanoid;
    this.bones = {
      leftUpperArm: humanoid?.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperArm) ?? null,
      rightUpperArm: humanoid?.getNormalizedBoneNode(VRMHumanBoneName.RightUpperArm) ?? null,
      leftLowerArm: humanoid?.getNormalizedBoneNode(VRMHumanBoneName.LeftLowerArm) ?? null,
      rightLowerArm: humanoid?.getNormalizedBoneNode(VRMHumanBoneName.RightLowerArm) ?? null,
      leftHand: humanoid?.getNormalizedBoneNode(VRMHumanBoneName.LeftHand) ?? null,
      rightHand: humanoid?.getNormalizedBoneNode(VRMHumanBoneName.RightHand) ?? null,
      leftShoulder: humanoid?.getNormalizedBoneNode(VRMHumanBoneName.LeftShoulder) ?? null,
      rightShoulder: humanoid?.getNormalizedBoneNode(VRMHumanBoneName.RightShoulder) ?? null,
      spine: humanoid?.getNormalizedBoneNode(VRMHumanBoneName.Spine) ?? null,
      chest: humanoid?.getNormalizedBoneNode(VRMHumanBoneName.Chest) ?? null,
      upperChest: humanoid?.getNormalizedBoneNode(VRMHumanBoneName.UpperChest) ?? null,
      neck: humanoid?.getNormalizedBoneNode(VRMHumanBoneName.Neck) ?? null,
      head: humanoid?.getNormalizedBoneNode(VRMHumanBoneName.Head) ?? null,
      hips: humanoid?.getNormalizedBoneNode(VRMHumanBoneName.Hips) ?? null,
      leftUpperLeg: humanoid?.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperLeg) ?? null,
      rightUpperLeg: humanoid?.getNormalizedBoneNode(VRMHumanBoneName.RightUpperLeg) ?? null,
      leftLowerLeg: humanoid?.getNormalizedBoneNode(VRMHumanBoneName.LeftLowerLeg) ?? null,
      rightLowerLeg: humanoid?.getNormalizedBoneNode(VRMHumanBoneName.RightLowerLeg) ?? null,
    };

    this.scheduleNextBlink();
    this.applyInstantStandingPose();
  }

  /**
   * Initializes resting A-pose immediately on model spawn.
   */
  private applyInstantStandingPose(): void {
    const b = this.bones;
    if (b.leftUpperArm) b.leftUpperArm.rotation.set(0.08, 0.04, -1.22);
    if (b.rightUpperArm) b.rightUpperArm.rotation.set(0.08, -0.04, 1.22);
    if (b.leftLowerArm) b.leftLowerArm.rotation.set(0.14, 0.05, -0.16);
    if (b.rightLowerArm) b.rightLowerArm.rotation.set(0.14, -0.05, 0.16);
    if (b.leftHand) b.leftHand.rotation.set(0.04, 0.0, -0.05);
    if (b.rightHand) b.rightHand.rotation.set(0.04, 0.0, 0.05);
    if (b.leftShoulder) b.leftShoulder.rotation.set(0.0, 0.0, -0.04);
    if (b.rightShoulder) b.rightShoulder.rotation.set(0.0, 0.0, 0.04);
    if (b.leftUpperLeg) b.leftUpperLeg.rotation.set(-0.02, 0.02, -0.03);
    if (b.rightUpperLeg) b.rightUpperLeg.rotation.set(-0.02, -0.02, 0.03);
    if (b.leftLowerLeg) b.leftLowerLeg.rotation.set(0.0, 0.0, 0.0);
    if (b.rightLowerLeg) b.rightLowerLeg.rotation.set(0.0, 0.0, 0.0);
  }

  private scheduleNextBlink(): void {
    this.nextBlinkInterval = 2.4 + Math.random() * 3.2; // 2.4s to 5.6s
    this.blinkTimer = 0;
    this.isBlinking = false;
    this.blinkProgress = 0;
  }

  /**
   * Trigger a gentle welcoming nod (e.g. on greeting / startup)
   */
  public triggerGreetingNod(): void {
    this.greetingNodProgress = 0.01;
  }

  /**
   * Main animation loop — call every frame with delta seconds.
   */
  public update(
    delta: number,
    characterState: "idle" | "thinking" | "talking" | "sitting" | "walking" = "idle",
    activeEmotion: MyraaEmotion = "idle",
    voiceEnergy = 0,
    liveState: LiveState = "disconnected"
  ): void {
    const dt = Math.min(delta, 0.1);
    this.time += dt;

    // 1. Smooth state blend transitions
    const targetThinking = characterState === "thinking" ? 1.0 : 0.0;
    const targetTalking = characterState === "talking" ? 1.0 : 0.0;
    const targetListening = liveState === "listening" ? 1.0 : 0.0;
    const targetSitting = characterState === "sitting" ? 1.0 : 0.0;
    const targetWalking = characterState === "walking" ? 1.0 : 0.0;

    const targetHappy =
      activeEmotion === "happy" || activeEmotion === "excited" || activeEmotion === "playful" || activeEmotion === "proud"
        ? 1.0
        : 0.0;

    const targetSad =
      activeEmotion === "sad" || activeEmotion === "confused" || activeEmotion === "embarrassed"
        ? 1.0
        : 0.0;

    this.stateBlend.thinking += (targetThinking - this.stateBlend.thinking) * Math.min(dt * 5.0, 1.0);
    this.stateBlend.talking += (targetTalking - this.stateBlend.talking) * Math.min(dt * 6.0, 1.0);
    this.stateBlend.listening += (targetListening - this.stateBlend.listening) * Math.min(dt * 4.0, 1.0);
    this.stateBlend.sitting += (targetSitting - this.stateBlend.sitting) * Math.min(dt * 3.5, 1.0);
    this.stateBlend.walking += (targetWalking - this.stateBlend.walking) * Math.min(dt * 4.0, 1.0);
    this.stateBlend.happy += (targetHappy - this.stateBlend.happy) * Math.min(dt * 4.0, 1.0);
    this.stateBlend.sad += (targetSad - this.stateBlend.sad) * Math.min(dt * 4.0, 1.0);

    // 2. Procedural Animation Layers
    this.updateStandingAndBreathing(dt, voiceEnergy);
    this.updateBlinking(dt);
    this.updateFacialExpressions(dt, characterState);
    this.updateHairAndClothingPhysics(dt);
  }

  /**
   * Generates organic standing idle with natural breathing, body sway, and state modulation.
   */
  private updateStandingAndBreathing(dt: number, voiceEnergy: number): void {
    const b = this.bones;
    const t = this.time;

    // Harmonic Breathing Curves
    const breathPhase = t * 1.6;
    const breath = Math.sin(breathPhase);
    const breathSecondary = Math.sin(breathPhase * 2.0) * 0.15;

    // Organic Body Weight Sway
    const swayHips = Math.sin(t * 0.55) * 0.012;
    const swayTorso = Math.cos(t * 0.45) * 0.008;

    // Head Micro-Motion
    const headIdlePitch = Math.sin(t * 0.9) * 0.012;
    const headIdleYaw = Math.cos(t * 0.6) * 0.014;

    // Thinking Offsets
    const thinkTiltZ = this.stateBlend.thinking * 0.09;
    const thinkTiltX = this.stateBlend.thinking * -0.05;
    const thinkYawY = this.stateBlend.thinking * 0.06;

    // Listening Attentive Posture (slight forward lean and attentive head pitch)
    const listenLeanX = this.stateBlend.listening * 0.035;
    const listenHeadPitchX = this.stateBlend.listening * 0.025;

    // Talking Speech Cadence
    const speechNodX = this.stateBlend.talking * (Math.sin(t * 5.0) * 0.018 + voiceEnergy * 0.035);
    const speechSwayY = this.stateBlend.talking * Math.sin(t * 2.8) * 0.012;

    // Greeting nod progression
    let greetingNodOffset = 0;
    if (this.greetingNodProgress > 0) {
      this.greetingNodProgress += dt / 0.8;
      if (this.greetingNodProgress >= 1) {
        this.greetingNodProgress = 0;
      } else {
        greetingNodOffset = Math.sin(this.greetingNodProgress * Math.PI) * 0.12;
      }
    }

    // Sitting and Walking Kinematics Modulation
    const sSit = this.stateBlend.sitting;
    const sWalk = this.stateBlend.walking;

    // Locomotion harmonic cycle (in-place stationary walk)
    const walkPhase = t * 4.4; // ~105 steps/min cadence
    const walkLegL = Math.sin(walkPhase) * 0.35 * sWalk;
    const walkLegR = -walkLegL;
    const walkKneeL = Math.max(0, -Math.sin(walkPhase)) * 0.45 * sWalk;
    const walkKneeR = Math.max(0, Math.sin(walkPhase)) * 0.45 * sWalk;
    const walkArmL = -Math.sin(walkPhase) * 0.25 * sWalk;
    const walkArmR = Math.sin(walkPhase) * 0.25 * sWalk;
    const walkHipBob = Math.abs(Math.sin(walkPhase)) * 0.02 * sWalk;

    // --- Hips ---
    if (b.hips) {
      b.hips.position.y = -0.42 * sSit + walkHipBob;
      b.hips.rotation.z = swayHips * (1.0 - sSit);
      b.hips.rotation.y = swayTorso * 0.5 * (1.0 - sSit);
    }

    // --- Spine & Chest (Breathing + Listening lean) ---
    if (b.spine) {
      b.spine.rotation.x = 0.02 + breath * 0.012 + listenLeanX;
      b.spine.rotation.y = swayTorso * (1.0 - sSit);
    }
    if (b.chest) {
      b.chest.rotation.x = -0.01 + (breath + breathSecondary) * 0.022 + voiceEnergy * 0.01;
      b.chest.rotation.z = -swayHips * 0.5 * (1.0 - sSit);
    }
    if (b.upperChest) {
      b.upperChest.rotation.x = (breath + breathSecondary) * 0.01;
    }

    // --- Neck & Head ---
    if (b.neck) {
      b.neck.rotation.x = breath * 0.006 + listenHeadPitchX * 0.5;
      b.neck.rotation.z = thinkTiltZ * 0.3;
    }
    if (b.head) {
      b.head.rotation.x = headIdlePitch + thinkTiltX + speechNodX + listenHeadPitchX + greetingNodOffset;
      b.head.rotation.y = headIdleYaw + thinkYawY + speechSwayY;
      b.head.rotation.z = thinkTiltZ;
    }

    // --- Shoulders ---
    if (b.leftShoulder) {
      b.leftShoulder.rotation.z = -0.04 - breath * 0.006;
    }
    if (b.rightShoulder) {
      b.rightShoulder.rotation.z = 0.04 + breath * 0.006;
    }

    // --- Upper Arms ---
    const thinkArmR_Z = -this.stateBlend.thinking * 0.12;
    const thinkArmR_X = this.stateBlend.thinking * 0.15;
    const thinkElbowR_X = this.stateBlend.thinking * 0.25;

    const speechArmL_Z = this.stateBlend.talking * Math.sin(t * 3.2) * 0.015;
    const speechArmR_Z = this.stateBlend.talking * Math.cos(t * 3.2) * 0.015;
    const sitArmRelax = sSit * 0.45;

    if (b.leftUpperArm) {
      b.leftUpperArm.rotation.x = 0.08 + breath * 0.008 + walkArmL;
      b.leftUpperArm.rotation.y = 0.04;
      b.leftUpperArm.rotation.z = -1.22 + breath * 0.008 + speechArmL_Z + sitArmRelax * 0.1;
    }
    if (b.rightUpperArm) {
      b.rightUpperArm.rotation.x = 0.08 + breath * 0.008 + thinkArmR_X + walkArmR;
      b.rightUpperArm.rotation.y = -0.04;
      b.rightUpperArm.rotation.z = 1.22 - breath * 0.008 + thinkArmR_Z + speechArmR_Z - sitArmRelax * 0.1;
    }

    // --- Elbows ---
    if (b.leftLowerArm) {
      b.leftLowerArm.rotation.x = 0.14 + breath * 0.005 + sitArmRelax;
      b.leftLowerArm.rotation.y = 0.05;
      b.leftLowerArm.rotation.z = -0.16;
    }
    if (b.rightLowerArm) {
      b.rightLowerArm.rotation.x = 0.14 + breath * 0.005 + thinkElbowR_X + sitArmRelax;
      b.rightLowerArm.rotation.y = -0.05;
      b.rightLowerArm.rotation.z = 0.16;
    }

    // --- Hands ---
    if (b.leftHand) {
      b.leftHand.rotation.x = 0.04;
      b.leftHand.rotation.z = -0.05;
    }
    if (b.rightHand) {
      b.rightHand.rotation.x = 0.04;
      b.rightHand.rotation.z = 0.05;
    }

    // --- Legs (Standing / Sitting / Walking) ---
    const sitUpperLegPitch = -1.48 * sSit;
    const sitLowerLegBend = 1.52 * sSit;

    if (b.leftUpperLeg) {
      b.leftUpperLeg.rotation.x = -0.02 * (1.0 - sSit) + sitUpperLegPitch + walkLegL;
      b.leftUpperLeg.rotation.y = 0.02;
      b.leftUpperLeg.rotation.z = -0.03 * (1.0 - sSit);
    }
    if (b.rightUpperLeg) {
      b.rightUpperLeg.rotation.x = -0.02 * (1.0 - sSit) + sitUpperLegPitch + walkLegR;
      b.rightUpperLeg.rotation.y = -0.02;
      b.rightUpperLeg.rotation.z = 0.03 * (1.0 - sSit);
    }
    if (b.leftLowerLeg) {
      b.leftLowerLeg.rotation.x = sitLowerLegBend + walkKneeL;
    }
    if (b.rightLowerLeg) {
      b.rightLowerLeg.rotation.x = sitLowerLegBend + walkKneeR;
    }
  }

  /**
   * Natural randomized blinking
   */
  private updateBlinking(dt: number): void {
    const expr = this.vrm.expressionManager;
    if (!expr) return;

    this.blinkTimer += dt;

    if (!this.isBlinking && this.blinkTimer >= this.nextBlinkInterval) {
      this.isBlinking = true;
      this.blinkProgress = 0;
    }

    if (this.isBlinking) {
      this.blinkProgress += dt / this.BLINK_DURATION;
      if (this.blinkProgress >= 1) {
        expr.setValue("blink", 0);
        this.scheduleNextBlink();
      } else {
        const weight = Math.sin(this.blinkProgress * Math.PI);
        expr.setValue("blink", weight);
      }
    }
  }

  /**
   * Phase 2 State-Based Facial Expression Blending:
   *  - Idle: Neutral + slight Relaxed
   *  - Listening: Attentive focus (neutral 0.5, alert eyes)
   *  - Thinking: Contemplative (relaxed 0.4 + surprised 0.2)
   *  - Talking: Warm subtle smile (happy 0.25)
   *  - Success: Happy (0.85)
   *  - Error: Concerned / Sad (0.65)
   */
  private updateFacialExpressions(
    dt: number,
    characterState: "idle" | "thinking" | "talking" | "sitting" | "walking"
  ): void {
    const expr = this.vrm.expressionManager;
    if (!expr) return;

    // Reset base emotion expressions before calculating blended target
    const baseEmotions = ["neutral", "relaxed", "happy", "surprised", "sad", "angry"];
    baseEmotions.forEach((e) => {
      if (expr.getExpression(e) !== undefined) {
        expr.setValue(e, 0);
      }
    });

    // 1. Success / Happy state
    if (this.stateBlend.happy > 0.02) {
      const w = this.stateBlend.happy * 0.85;
      if (expr.getExpression("happy")) expr.setValue("happy", w);
      return;
    }

    // 2. Error / Sad state
    if (this.stateBlend.sad > 0.02) {
      const w = this.stateBlend.sad * 0.65;
      if (expr.getExpression("sad")) expr.setValue("sad", w);
      if (expr.getExpression("surprised")) expr.setValue("surprised", this.stateBlend.sad * 0.15);
      return;
    }

    // 3. Thinking state
    if (this.stateBlend.thinking > 0.05) {
      const t = this.stateBlend.thinking;
      if (expr.getExpression("relaxed")) expr.setValue("relaxed", 0.4 * t);
      if (expr.getExpression("surprised")) expr.setValue("surprised", 0.2 * t);
      return;
    }

    // 4. Listening state
    if (this.stateBlend.listening > 0.05) {
      const l = this.stateBlend.listening;
      if (expr.getExpression("neutral")) expr.setValue("neutral", 0.6 * l);
      if (expr.getExpression("surprised")) expr.setValue("surprised", 0.15 * l);
      return;
    }

    // 5. Talking state (Warm subtle smile)
    if (this.stateBlend.talking > 0.05) {
      const tk = this.stateBlend.talking;
      if (expr.getExpression("happy")) expr.setValue("happy", 0.22 * tk);
      if (expr.getExpression("neutral")) expr.setValue("neutral", 0.5 * (1 - tk));
      return;
    }

    // 6. Default Idle state
    if (expr.getExpression("neutral")) expr.setValue("neutral", 0.75);
    if (expr.getExpression("relaxed")) expr.setValue("relaxed", 0.25);
  }

  /**
   * Hair and clothing physics simulation:
   * Modulates ambient breeze on VRM SpringBone joints so secondary hair & clothing
   * sway organically even while standing still.
   */
  private updateHairAndClothingPhysics(dt: number): void {
    const springMgr = this.vrm.springBoneManager;
    if (!springMgr) return;

    const t = this.time;

    // Organic procedural breeze vector (lateral sway + subtle depth gust)
    const breezeX = Math.sin(t * 1.5) * 0.12 + Math.cos(t * 3.4) * 0.04;
    const breezeZ = Math.sin(t * 0.9) * 0.06;

    // Update joint gravity direction slightly to simulate ambient air current
    springMgr.joints.forEach((joint) => {
      if (joint.settings) {
        joint.settings.gravityDir.x = breezeX;
        joint.settings.gravityDir.z = breezeZ;
      }
    });
  }
}
