/**
 * VRMLoader.ts
 * Handles loading a .vrm file using Three.js GLTFLoader + VRMLoaderPlugin.
 * Validates model capabilities (humanoid, expressions, lookAt, blink, mouth).
 * Provides a simple cached-load API so Avatar3DRenderer can call it safely.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRM, VRMUtils } from "@pixiv/three-vrm";

export interface VRMCapabilities {
  version: string;
  name: string;
  authors: string[];
  licenseUrl: string;
  hasHumanoid: boolean;
  hasExpressionManager: boolean;
  hasLookAt: boolean;
  hasBlink: boolean;
  visemes: {
    aa: boolean;
    ih: boolean;
    ou: boolean;
    ee: boolean;
    oh: boolean;
  };
  springBones: {
    jointCount: number;
    colliderCount: number;
  };
  expressionNames: string[];
}

export interface VRMLoadResult {
  vrm: VRM;
  capabilities: VRMCapabilities;
  warnings: string[];
}

let loader: GLTFLoader | null = null;

function getLoader(): GLTFLoader {
  if (!loader) {
    loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
  }
  return loader;
}

export async function loadVRM(url: string): Promise<VRMLoadResult> {
  const gltf = await getLoader().loadAsync(url);
  const vrm: VRM = gltf.userData.vrm;

  if (!vrm) {
    throw new Error(`[VRMLoader] No VRM data found in file: ${url}`);
  }

  // Optimise VRM for rendering
  VRMUtils.rotateVRM0(vrm);

  const warnings: string[] = [];

  // Metadata & Licensing audit
  const vrmMeta = (vrm as any).meta;
  const version: string = vrmMeta?.metaVersion ?? vrmMeta?.version ?? "1.0";
  const name: string = vrmMeta?.name ?? vrmMeta?.title ?? "MYRAA Avatar";
  const authors: string[] = Array.isArray(vrmMeta?.authors)
    ? vrmMeta.authors
    : [vrmMeta?.author ?? "Unknown"];
  const licenseUrl: string = vrmMeta?.licenseUrl ?? vrmMeta?.licenseName ?? "Proprietary / Custom";

  // Check humanoid
  const hasHumanoid = !!vrm.humanoid;
  if (!hasHumanoid) warnings.push("No humanoid rig found.");

  // Check expression manager
  const exprMgr = vrm.expressionManager;
  const hasExpressionManager = !!exprMgr;
  if (!hasExpressionManager) warnings.push("No expression manager found.");

  const expressionNames: string[] = hasExpressionManager
    ? Object.keys((exprMgr as any)?._expressions ?? {})
    : [];

  const hasBlink =
    hasExpressionManager &&
    (exprMgr!.getExpression("blink") !== undefined ||
      exprMgr!.getExpression("blinkLeft") !== undefined);
  if (!hasBlink) warnings.push("No blink expression found.");

  // 5-Viseme Audit
  const visemes = {
    aa: hasExpressionManager && exprMgr!.getExpression("aa") !== undefined,
    ih: hasExpressionManager && exprMgr!.getExpression("ih") !== undefined,
    ou: hasExpressionManager && exprMgr!.getExpression("ou") !== undefined,
    ee: hasExpressionManager && exprMgr!.getExpression("ee") !== undefined,
    oh: hasExpressionManager && exprMgr!.getExpression("oh") !== undefined,
  };

  const missingVisemes = Object.entries(visemes)
    .filter(([_, present]) => !present)
    .map(([k]) => k);
  if (missingVisemes.length > 0) {
    warnings.push(`Missing visemes: ${missingVisemes.join(", ")}`);
  }

  // SpringBone audit
  const springMgr = vrm.springBoneManager;
  const jointCount = springMgr?.joints?.size ?? (springMgr as any)?.springBones?.size ?? 0;
  const colliderCount = springMgr?.colliders?.length ?? 0;

  // Check lookAt
  const hasLookAt = !!vrm.lookAt;
  if (!hasLookAt) warnings.push("No lookAt component found — eye tracking disabled.");

  if (warnings.length > 0) {
    console.warn("[VRMLoader] Capability warnings:", warnings);
  }

  console.log(
    `[VRMLoader] Loaded VRM: "${name}" by [${authors.join(", ")}] (VRM ${version}) — Rig: ${hasHumanoid}, Visemes: ${Object.values(visemes).filter(Boolean).length}/5, Springs: ${jointCount}, LookAt: ${hasLookAt}`
  );

  return {
    vrm,
    capabilities: {
      version,
      name,
      authors,
      licenseUrl,
      hasHumanoid,
      hasExpressionManager,
      hasLookAt,
      hasBlink,
      visemes,
      springBones: {
        jointCount,
        colliderCount,
      },
      expressionNames,
    },
    warnings,
  };
}
