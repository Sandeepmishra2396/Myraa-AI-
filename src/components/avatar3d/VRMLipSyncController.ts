/**
 * VRMLipSyncController.ts
 *
 * Full 5-Viseme Phonetic Audio Lip-Sync:
 *  - "aa" (Open jaw / A)
 *  - "ih" (Spread lips / I)
 *  - "ou" (Pursed rounded lips / U)
 *  - "ee" (Wide smiling stretch / E)
 *  - "oh" (Tall rounded mouth / O)
 *
 * Analyzes live audio FFT frequency bins across human vocal formant ranges:
 *  - Low band (200-450 Hz)    -> "ou"
 *  - Low-mid band (500-950 Hz)  -> "aa"
 *  - Mid band (700-1400 Hz)   -> "oh"
 *  - Mid-high band (1400-2400 Hz)-> "ih"
 *  - High band (2200-3600 Hz)  -> "ee"
 *
 * Employs smooth attack/decay lerping to eliminate mouth flutter or snapping.
 */
import { VRM } from "@pixiv/three-vrm";

const LERP_ATTACK = 0.45; // Fast response when opening
const LERP_DECAY = 0.25;  // Gentle smooth closure

const FREQUENCY_BINS = 64;
const dataArray = new Uint8Array(FREQUENCY_BINS);

// Live smoothed weights
const currentWeights = {
  aa: 0,
  ih: 0,
  ou: 0,
  ee: 0,
  oh: 0,
};

/**
 * Updates 5-viseme lip shapes every animation frame based on audio output analyser.
 */
export function updateLipSync(
  vrm: VRM,
  analyser: AnalyserNode | null,
  delta: number
): void {
  const expr = vrm.expressionManager;
  if (!expr) return;

  if (!analyser) {
    decayAllVisemes(expr);
    return;
  }

  try {
    analyser.getByteFrequencyData(dataArray);
  } catch {
    decayAllVisemes(expr);
    return;
  }

  // Calculate energy across the 5 acoustic vowel formant bands
  // At 24kHz sample rate, 64 bins -> each bin is ~187.5 Hz
  // bin 1: 187Hz, bin 2: 375Hz, bin 4: 750Hz, bin 7: 1312Hz, bin 12: 2250Hz, bin 16: 3000Hz
  const e_low     = getBandEnergy(1, 3);   // ~180 - 560 Hz  ("ou")
  const e_lowmid  = getBandEnergy(3, 6);   // ~560 - 1100 Hz ("aa")
  const e_mid     = getBandEnergy(4, 8);   // ~750 - 1500 Hz ("oh")
  const e_midhigh = getBandEnergy(7, 12);  // ~1300 - 2250 Hz ("ih")
  const e_high    = getBandEnergy(11, 18); // ~2000 - 3400 Hz ("ee")

  const totalVolume = (e_low + e_lowmid + e_mid + e_midhigh + e_high) / 5.0;

  // Threshold: if silence or faint room noise, decay cleanly
  if (totalVolume < 0.04) {
    decayAllVisemes(expr);
    return;
  }

  // Compute normalized target weights with dynamic emphasis
  const targetAa = Math.min(e_lowmid * 2.4, 1.0);
  const targetOh = Math.min(e_mid * 1.8, 0.85);
  const targetOu = Math.min(e_low * 1.6, 0.7);
  const targetIh = Math.min(e_midhigh * 1.8, 0.75);
  const targetEe = Math.min(e_high * 2.0, 0.8);

  // Soft relative dominance so the mouth transitions through distinct shapes
  applyWeight(expr, "aa", targetAa);
  applyWeight(expr, "oh", targetOh);
  applyWeight(expr, "ou", targetOu);
  applyWeight(expr, "ih", targetIh);
  applyWeight(expr, "ee", targetEe);
}

function getBandEnergy(startBin: number, endBin: number): number {
  let sum = 0;
  for (let i = startBin; i <= endBin; i++) {
    sum += dataArray[i] || 0;
  }
  return sum / ((endBin - startBin + 1) * 255.0);
}

function applyWeight(
  expr: NonNullable<VRM["expressionManager"]>,
  name: "aa" | "ih" | "ou" | "ee" | "oh",
  target: number
): void {
  const current = currentWeights[name];
  const rate = target > current ? LERP_ATTACK : LERP_DECAY;
  const updated = current + (target - current) * rate;
  currentWeights[name] = updated;

  if (expr.getExpression(name) !== undefined) {
    expr.setValue(name, updated);
  }
}

function decayAllVisemes(expr: NonNullable<VRM["expressionManager"]>): void {
  (["aa", "ih", "ou", "ee", "oh"] as const).forEach((name) => {
    currentWeights[name] *= (1.0 - LERP_DECAY);
    if (currentWeights[name] < 0.005) currentWeights[name] = 0;
    if (expr.getExpression(name) !== undefined) {
      expr.setValue(name, currentWeights[name]);
    }
  });
}

/** Reset all visemes to 0 immediately (on turn end / disconnect) */
export function resetLipSync(vrm: VRM): void {
  const expr = vrm.expressionManager;
  (["aa", "ih", "ou", "ee", "oh"] as const).forEach((name) => {
    currentWeights[name] = 0;
    if (expr && expr.getExpression(name) !== undefined) {
      expr.setValue(name, 0);
    }
  });
}
