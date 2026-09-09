import { pipeline, env, RawImage } from '@xenova/transformers';
import type { DomNode, VisualRegion, PerceptionMetrics } from '@/types';

// Configure transformers.js for Chrome extension environment
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

// Configure local WASM paths in extension if available
if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
  try {
    env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('wasm/');
  } catch {
    // fallback to default
  }
}

// Convert data URL to Blob
function dataUrlToBlob(dataUrl: string): Blob {
  const parts = dataUrl.split(',');
  const mime = parts[0]?.match(/:(.*?);/)?.[1] || 'image/png';
  const bstr = atob(parts[1] || '');
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
}

/**
 * Tiered compute check:
 * Returns true if the page has a <canvas> element OR fewer than 30% of extracted DOM nodes have non-empty text.
 */
export function needsVisualPerception(domNodes: DomNode[]): boolean {
  if (!domNodes || domNodes.length === 0) {
    return true;
  }

  // 1. Check for canvas element
  const hasCanvas = domNodes.some((node) => node.tag === 'canvas');
  if (hasCanvas) {
    return true;
  }

  // 2. Check if fewer than 30% have non-empty text content
  const nodesWithText = domNodes.filter((node) => node.text && node.text.trim().length > 0);
  const textPercentage = (nodesWithText.length / domNodes.length) * 100;

  if (textPercentage < 30) {
    return true;
  }

  return false;
}

// Feature-detect WebGPU with fallback to WASM
export async function detectExecutionProvider(): Promise<'webgpu' | 'wasm'> {
  if (typeof navigator !== 'undefined' && 'gpu' in navigator && (navigator as any).gpu) {
    try {
      const gpu = (navigator as any).gpu;
      const adapter = await gpu.requestAdapter();
      if (adapter) {
        return 'webgpu';
      }
    } catch (e) {
      console.warn('[Nexus Privacy Agent] WebGPU requestAdapter failed, falling back to WASM:', e);
    }
  }
  return 'wasm';
}

// Cached OCR pipeline singleton
let ocrPipelinePromise: Promise<any> | null = null;
let cachedProvider: 'webgpu' | 'wasm' = 'wasm';
let coldModelLoadDurationMs = 0;

async function getOcrPipeline(provider: 'webgpu' | 'wasm'): Promise<{ ocr: any; isWarm: boolean }> {
  if (!ocrPipelinePromise) {
    const loadStart = performance.now();
    cachedProvider = provider;

    ocrPipelinePromise = pipeline('image-to-text', 'Xenova/trocr-small-printed', {
      quantized: true,
    }).then((ocr) => {
      coldModelLoadDurationMs = performance.now() - loadStart;
      console.log(
        `[Nexus Privacy Agent] Cold model load: ${coldModelLoadDurationMs.toFixed(1)}ms (one-time cost, not counted against per-capture budget)`
      );
      return ocr;
    });

    const ocr = await ocrPipelinePromise;
    return { ocr, isWarm: false };
  }

  const ocr = await ocrPipelinePromise;
  return { ocr, isWarm: true };
}

interface CandidateBox {
  x: number;
  y: number;
  w: number;
  h: number;
  energy: number;
}

/**
 * Fast spatial contrast/edge analysis to locate candidate text line regions
 */
function detectCandidateTextRegions(rawImg: RawImage, maxRegions = 10): CandidateBox[] {
  const { width, height, data, channels } = rawImg;
  if (!data || width <= 0 || height <= 0) return [];

  const ch = channels || 3;
  const totalPixels = width * height;
  const gray = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    const o = i * ch;
    gray[i] = ((data[o] ?? 0) * 77 + (data[o + 1] ?? 0) * 150 + (data[o + 2] ?? 0) * 29) >> 8;
  }

  const edge = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      if (Math.abs((gray[row + x + 1] ?? 0) - (gray[row + x - 1] ?? 0)) > 25) {
        edge[row + x] = 1;
      }
    }
  }

  // Remove long continuous vertical lines (borders, frames, divider lines)
  // Text characters never have >20px continuous vertical edges at normal UI font sizes
  for (let x = 0; x < width; x++) {
    let run = 0;
    let runStart = 0;
    for (let y = 0; y < height; y++) {
      if (edge[y * width + x] === 1) {
        if (run === 0) runStart = y;
        run++;
      } else {
        if (run > 20) {
          for (let ry = runStart; ry < y; ry++) edge[ry * width + x] = 0;
        }
        run = 0;
      }
    }
    if (run > 20) {
      for (let ry = runStart; ry < height; ry++) edge[ry * width + x] = 0;
    }
  }

  const rowTransitions = new Int32Array(height);
  for (let y = 1; y < height - 1; y++) {
    let t = 0;
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      if (edge[row + x] === 1) t++;
    }
    rowTransitions[y] = t;
  }

  const bands: CandidateBox[] = [];
  let inBand = false;
  let startY = 0;
  let lineEnergy = 0;

  for (let y = 0; y < height; y++) {
    const t = rowTransitions[y] ?? 0;
    if (t >= 15) {
      if (!inBand) {
        inBand = true;
        startY = y;
        lineEnergy = 0;
      }
      lineEnergy += t;
    } else {
      if (inBand) {
        inBand = false;
        const h = y - startY;
        if (h >= 5 && h <= 50) {
          let minX = width;
          let maxX = 0;
          for (let py = startY; py < y; py++) {
            const row = py * width;
            for (let px = 0; px < width; px++) {
              if (edge[row + px] === 1) {
                minX = Math.min(minX, px);
                maxX = Math.max(maxX, px);
              }
            }
          }
          const spanW = maxX - minX;
          if (spanW >= 50 && spanW < width * 0.95) {
            const padX = 12;
            const padY = 6;
            const bx = Math.max(0, minX - padX);
            const by = Math.max(0, startY - padY);
            const bw = Math.min(width - bx, spanW + padX * 2);
            const bh = Math.min(height - by, h + padY * 2);
            bands.push({
              x: bx,
              y: by,
              w: bw,
              h: bh,
              energy: lineEnergy,
            });
          }
        }
      }
    }
  }

  // Sort top-to-bottom
  bands.sort((a, b) => a.y - b.y);
  return bands.slice(0, maxRegions);
}

export interface PerceiveResult {
  visualRegions: VisualRegion[];
  metrics: PerceptionMetrics;
}

/**
 * Runs on-device OCR (TrOCR) on screenshot to detect and extract text regions with bounding boxes.
 */
export async function perceiveScreenshot(screenshotDataUrl: string): Promise<PerceiveResult> {
  const totalStart = performance.now();

  if (!screenshotDataUrl || !screenshotDataUrl.startsWith('data:image/')) {
    return {
      visualRegions: [],
      metrics: {
        totalDurationMs: 0,
        candidateBandsDetected: 0,
        ocrInferenceDurationMs: 0,
        provider: 'wasm',
        isWarm: false,
      },
    };
  }

  // 1. Feature detect execution provider
  const provider = await detectExecutionProvider();
  console.log(`[Nexus Privacy Agent] Execution provider detected: ${provider.toUpperCase()}`);

  // 2. Load model (or get cached singleton) with 4s timeout fallback
  let ocr: any;
  let isWarm = false;
  try {
    const pipelineResult = await Promise.race([
      getOcrPipeline(provider),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('OCR model load timeout')), 4000)),
    ]);
    ocr = pipelineResult.ocr;
    isWarm = pipelineResult.isWarm;
  } catch (ocrLoadErr) {
    console.warn('[Nexus Privacy Agent] OCR pipeline unavailable or timed out, skipping visual OCR:', ocrLoadErr);
    return {
      visualRegions: [],
      metrics: {
        totalDurationMs: Math.round(performance.now() - totalStart),
        candidateBandsDetected: 0,
        ocrInferenceDurationMs: 0,
        provider,
        isWarm: false,
      },
    };
  }

  // 3. Prepare image from dataUrl
  let rawImg: RawImage;
  try {
    const blob = dataUrlToBlob(screenshotDataUrl);
    rawImg = await RawImage.fromBlob(blob);
  } catch (err) {
    console.warn('[Nexus Privacy Agent] RawImage.fromBlob failed:', err);
    return {
      visualRegions: [],
      metrics: {
        totalDurationMs: Math.round(performance.now() - totalStart),
        candidateBandsDetected: 0,
        ocrInferenceDurationMs: 0,
        provider,
        isWarm,
      },
    };
  }

  // 4. Run text region detection & OCR inference
  const infStart = performance.now();
  const visualRegions: VisualRegion[] = [];

  // Find candidate text regions via spatial edge/contrast analysis
  const candidateBoxes = detectCandidateTextRegions(rawImg, 10);

  if (candidateBoxes.length > 0) {
    for (const box of candidateBoxes) {
      try {
        const crop = await rawImg.crop([box.x, box.y, box.x + box.w, box.y + box.h]);
        const ocrResult = await ocr(crop);
        const recognizedText = ocrResult?.[0]?.generated_text?.trim() || '';

        // Only include if recognized text contains alphanumeric characters
        if (/[a-zA-Z0-9]/.test(recognizedText)) {
          const cleanAlphanum = recognizedText.replace(/[^a-zA-Z0-9]/g, '');
          const confidence = Math.min(
            0.95,
            Math.max(0.6, 0.5 + Math.min(0.4, cleanAlphanum.length * 0.05))
          );
          visualRegions.push({
            bbox: { x: box.x, y: box.y, w: box.w, h: box.h },
            extractedText: recognizedText,
            confidence: Math.round(confidence * 100) / 100,
          });
        }
      } catch (cropErr) {
        console.warn('[Nexus Privacy Agent] Crop OCR error:', cropErr);
      }
    }
  } else {
    // If no candidate boxes found, run OCR on the canvas central area to confirm no text exists
    try {
      const cropX1 = Math.max(0, Math.floor(rawImg.width * 0.1));
      const cropY1 = Math.max(0, Math.floor(rawImg.height * 0.2));
      const cropX2 = Math.min(rawImg.width - 1, Math.floor(rawImg.width * 0.9));
      const cropY2 = Math.min(rawImg.height - 1, Math.floor(rawImg.height * 0.8));
      const centerCrop = await rawImg.crop([cropX1, cropY1, cropX2, cropY2]);
      const ocrResult = await ocr(centerCrop);
      const recognizedText = ocrResult?.[0]?.generated_text?.trim() || '';

      if (/[a-zA-Z0-9]/.test(recognizedText)) {
        visualRegions.push({
          bbox: { x: cropX1, y: cropY1, w: cropX2 - cropX1, h: cropY2 - cropY1 },
          extractedText: recognizedText,
          confidence: 0.75,
        });
      }
    } catch (fallbackErr) {
      console.warn('[Nexus Privacy Agent] Center crop OCR fallback error:', fallbackErr);
    }
  }

  const inferenceTimeMs = performance.now() - infStart;
  const totalTimeMs = performance.now() - totalStart;

  // 5. Memory and Latency Feasibility Budget checks (memory <= 500MB, warm latency <= 1.5s)
  let memoryUsageMB: number | undefined;
  if (typeof performance !== 'undefined' && (performance as any).memory) {
    memoryUsageMB = Math.round(((performance as any).memory.usedJSHeapSize / (1024 * 1024)) * 10) / 10;
  }

  // Latency budget is evaluated ONLY against warm inference
  const latencyBudgetExceeded = isWarm ? inferenceTimeMs > 1500 : false;
  const memoryBudgetExceeded = memoryUsageMB !== undefined ? memoryUsageMB > 500 : false;

  console.log('=== Nexus Privacy Agent Perception Metrics ===');
  console.log(`Execution Provider:   ${provider.toUpperCase()}`);
  console.log(`Run Type:             ${isWarm ? 'WARM RUN (Cached Pipeline)' : 'COLD RUN (First Capture)'}`);
  if (!isWarm) {
    console.log(`Cold Model Load:      ${coldModelLoadDurationMs.toFixed(1)}ms (one-time cost, not counted against per-capture budget)`);
  }
  console.log(`Inference Time:       ${inferenceTimeMs.toFixed(1)}ms`);
  console.log(`Total Perceive Time:  ${totalTimeMs.toFixed(1)}ms`);
  if (memoryUsageMB !== undefined) {
    console.log(`Client Memory Usage:  ${memoryUsageMB}MB`);
  }

  // Distinct logging for warm vs cold budget checks as requested
  if (isWarm) {
    if (inferenceTimeMs <= 1500) {
      console.log(`[Nexus Privacy Agent] Warm inference: ${inferenceTimeMs.toFixed(1)}ms (within 1.5s budget)`);
    } else {
      console.warn(
        `[Nexus Privacy Agent] ⚠️ LATENCY BUDGET WARNING: Warm inference (${inferenceTimeMs.toFixed(1)}ms) exceeds the 1.5s budget target!`
      );
    }
  } else {
    console.log(
      `[Nexus Privacy Agent] Cold model load: ${coldModelLoadDurationMs.toFixed(1)}ms (one-time cost, not counted against per-capture budget)`
    );
    console.log(
      `[Nexus Privacy Agent] Cold inference: ${inferenceTimeMs.toFixed(1)}ms (warm inference will be checked against 1.5s budget on subsequent captures)`
    );
  }

  if (memoryBudgetExceeded) {
    console.warn(
      `[Nexus Privacy Agent] ⚠️ MEMORY BUDGET WARNING: Client heap usage (${memoryUsageMB}MB) exceeds the 500MB budget target!`
    );
  }

  const metrics: PerceptionMetrics = {
    loadTimeMs: Math.round(coldModelLoadDurationMs),
    inferenceTimeMs: Math.round(inferenceTimeMs),
    totalTimeMs: Math.round(totalTimeMs),
    provider,
    isWarmRun: isWarm,
    memoryUsageMB,
    latencyBudgetExceeded,
    memoryBudgetExceeded,
  };

  return {
    visualRegions,
    metrics,
  };
}

export default defineUnlistedScript(() => {});
