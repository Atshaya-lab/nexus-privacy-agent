import type {
  RawContext,
  PerceivedContext,
  PiiClassification,
  PolicyRecord,
  SafeContext,
  AuditLogEntry,
  DomNode,
  VisualRegion,
} from '@/types';
import { resolvePolicyAction } from './policy';

/**
 * Draws solid blackout redaction boxes over all MASK/BLOCK bounding boxes on the screenshot canvas.
 */
export async function renderRedactedScreenshot(
  rawScreenshotUrl: string,
  blackoutBoxes: Array<{ bbox: { x: number; y: number; width: number; height: number }; category: string; action: string }>
): Promise<string> {
  if (!rawScreenshotUrl || blackoutBoxes.length === 0) {
    return rawScreenshotUrl;
  }

  // Browser / DOM environment
  if (typeof document !== 'undefined' && typeof Image !== 'undefined') {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(rawScreenshotUrl);
          return;
        }

        // Draw original screenshot
        ctx.drawImage(img, 0, 0);

        // Draw solid blackout rectangles
        for (const item of blackoutBoxes) {
          const { x, y, width, height } = item.bbox;

          // 1. Solid blackout fill - ensures zero sensitive pixels remain
          ctx.fillStyle = '#05070e';
          ctx.fillRect(x, y, width, height);

          // 2. High-contrast privacy border
          ctx.strokeStyle = item.action === 'BLOCK' ? '#991b1b' : '#ef4444';
          ctx.lineWidth = 2;
          ctx.strokeRect(x, y, width, height);

          // 3. Audit stamp
          ctx.fillStyle = '#ffffff';
          const fontSize = Math.max(10, Math.min(13, Math.floor(height * 0.45)));
          ctx.font = `bold ${fontSize}px Arial, sans-serif`;
          ctx.textBaseline = 'middle';
          const labelText = `🛡️ [REDACTED:${item.category.toUpperCase()}]`;
          ctx.fillText(labelText, x + 8, y + height / 2);
        }

        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => resolve(rawScreenshotUrl);
      img.src = rawScreenshotUrl;
    });
  }

  return rawScreenshotUrl;
}

/**
 * Main Phase 3 Sanitize function.
 * Inputs: RawContext + PerceivedContext + PII classifications + current policy.
 * Applies BLOCK, MASK, ALLOW, ASK policies.
 * Outputs: SafeContext with sanitized DOM, redacted screenshot, and complete audit log.
 */
export async function sanitize(
  rawContext: RawContext,
  perceivedContext: PerceivedContext,
  classifications: PiiClassification[],
  policy: PolicyRecord
): Promise<SafeContext> {
  const auditLog: AuditLogEntry[] = [];
  const blackoutBoxes: Array<{
    bbox: { x: number; y: number; width: number; height: number };
    category: string;
    action: string;
  }> = [];
  const pendingAskFields: PiiClassification[] = [];

  // Map classifications by source & index
  const visualClassificationMap = new Map<number, { classification: PiiClassification; action: string }>();
  const domClassificationMap = new Map<number, { classification: PiiClassification; action: string }>();

  for (const c of classifications) {
    const action = resolvePolicyAction(policy, c.category);

    // Record in audit log
    auditLog.push({
      category: c.category,
      action,
      source: c.source,
      bbox: { ...c.bbox },
      timestamp: Date.now(),
      details: c.matchedText
        ? `Regex matched: "${c.matchedText}"`
        : `Spatial label-proximity (${c.category})`,
    });

    if (c.source === 'visual' && typeof c.originalIndex === 'number') {
      visualClassificationMap.set(c.originalIndex, { classification: c, action });
    } else if (c.source === 'dom' && typeof c.originalIndex === 'number') {
      domClassificationMap.set(c.originalIndex, { classification: c, action });
    }

    if (action === 'MASK' || action === 'BLOCK') {
      blackoutBoxes.push({
        bbox: c.bbox,
        category: c.category,
        action,
      });
    } else if (action === 'ASK') {
      pendingAskFields.push(c);
      // For ASK, also blackout visually by default to prevent premature exposure
      blackoutBoxes.push({
        bbox: c.bbox,
        category: `${c.category} (PENDING APPROVAL)`,
        action: 'ASK',
      });
    }
  }

  // 1. Sanitize DOM Nodes
  const sanitizedDom: DomNode[] = [];
  const rawDomNodes = perceivedContext.dom || rawContext.dom || [];

  rawDomNodes.forEach((node, idx) => {
    const classified = domClassificationMap.get(idx);
    if (!classified) {
      sanitizedDom.push({ ...node });
      return;
    }

    const { classification, action } = classified;

    if (action === 'BLOCK') {
      // BLOCK: Remove the field entirely from outbound payload
      return;
    }

    if (action === 'MASK') {
      // MASK: Replace with redaction marker
      sanitizedDom.push({
        ...node,
        text: `[REDACTED:${classification.category}]`,
        attributes: {
          ...node.attributes,
          value: node.attributes?.value ? `[REDACTED:${classification.category}]` : undefined,
          placeholder: node.attributes?.placeholder ? `[REDACTED:${classification.category}]` : undefined,
        },
      });
      return;
    }

    if (action === 'ASK') {
      // ASK: Hold field, do not include in immediate payload
      return;
    }

    // ALLOW: Pass through unchanged
    sanitizedDom.push({ ...node });
  });

  // 2. Sanitize Visual Regions
  const sanitizedVisualRegions: VisualRegion[] = [];
  const rawVisualRegions = perceivedContext.visualRegions || [];

  rawVisualRegions.forEach((region, idx) => {
    const classified = visualClassificationMap.get(idx);
    if (!classified) {
      sanitizedVisualRegions.push({ ...region });
      return;
    }

    const { classification, action } = classified;

    if (action === 'BLOCK') {
      // BLOCK: Omit from outbound visual payload
      return;
    }

    if (action === 'MASK') {
      // MASK: Replace with redaction marker
      sanitizedVisualRegions.push({
        ...region,
        extractedText: `[REDACTED:${classification.category}]`,
      });
      return;
    }

    if (action === 'ASK') {
      // ASK: Hold from outbound payload
      return;
    }

    // ALLOW: Pass through unchanged
    sanitizedVisualRegions.push({ ...region });
  });

  // 3. Render Redacted Screenshot
  const rawScreenshot = perceivedContext.screenshot || rawContext.screenshot || '';
  const redactedScreenshot = await renderRedactedScreenshot(rawScreenshot, blackoutBoxes);

  // 4. Calculate Summary Counts
  const summary = {
    totalDetected: classifications.length,
    masked: auditLog.filter((e) => e.action === 'MASK').length,
    blocked: auditLog.filter((e) => e.action === 'BLOCK').length,
    allowed: auditLog.filter((e) => e.action === 'ALLOW').length,
    pendingAsk: auditLog.filter((e) => e.action === 'ASK').length,
  };

  return {
    url: rawContext.url || perceivedContext.url || '',
    timestamp: Date.now(),
    sanitizedDom,
    redactedScreenshot,
    rawScreenshot,
    auditLog,
    classifications,
    sanitizedVisualRegions,
    summary,
    pendingAskFields,
    policyApplied: { ...policy },
  };
}

export default defineUnlistedScript(() => {});
