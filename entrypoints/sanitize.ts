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
import { deduplicateClassifications } from './pii-detect';

/**
 * Draws solid blackout redaction boxes over all MASK/BLOCK bounding boxes on the screenshot canvas.
 */
export async function renderRedactedScreenshot(
  rawScreenshotUrl: string,
  blackoutBoxes: Array<{ bbox: { x: number; y: number; width: number; height: number }; category: string; action: string }>,
  viewport?: { width: number; height: number; dpr: number } | null
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

        // Calculate scaling factor between physical screenshot pixels and CSS DOM coordinates
        let scaleX = 1;
        let scaleY = 1;
        if (viewport && viewport.width > 0 && viewport.height > 0) {
          scaleX = canvas.width / viewport.width;
          scaleY = canvas.height / viewport.height;
        } else if (viewport && viewport.dpr > 0) {
          scaleX = viewport.dpr;
          scaleY = viewport.dpr;
        }

        // Draw solid blackout rectangles
        for (const item of blackoutBoxes) {
          const x = Math.round(item.bbox.x * scaleX);
          const y = Math.round(item.bbox.y * scaleY);
          const width = Math.round(item.bbox.width * scaleX);
          const height = Math.round(item.bbox.height * scaleY);

          // 1. Solid blackout fill - ensures zero sensitive pixels remain
          ctx.fillStyle = '#05070e';
          ctx.fillRect(x, y, width, height);

          // 2. High-contrast privacy border
          ctx.strokeStyle = item.action === 'BLOCK' ? '#991b1b' : '#ef4444';
          ctx.lineWidth = Math.max(2, Math.round(2 * scaleX));
          ctx.strokeRect(x, y, width, height);

          // 3. Audit stamp
          ctx.fillStyle = '#ffffff';
          const fontSize = Math.max(10, Math.min(18, Math.floor(height * 0.45)));
          ctx.font = `bold ${fontSize}px Arial, sans-serif`;
          ctx.textBaseline = 'middle';
          const displayCat = item.category.toUpperCase().replace('_', ' ');
          const labelText = `🛡️ ${displayCat}`;
          ctx.fillText(labelText, x + Math.round(8 * scaleX), y + height / 2);
        }

        // Compress to JPEG 0.85 to keep payload compact (~250KB vs 15MB PNG) and avoid HTTP 413
        try {
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        } catch {
          resolve(canvas.toDataURL('image/png'));
        }
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

  // Deduplicate classifications defensively before creating audit log & blackout boxes
  const uniqueClassifications = deduplicateClassifications(classifications);

  // Map classifications by source & index
  const visualClassificationMap = new Map<number, { classification: PiiClassification; action: string }>();
  const domClassificationMap = new Map<number, { classification: PiiClassification; action: string }>();

  for (const c of uniqueClassifications) {
    const action = resolvePolicyAction(policy, c.category);

    // Record rich, field-accurate details in audit log
    const domId = c.originalItem?.attributes?.['data-nexus-dom-id'];
    let details = '';

    if (c.source === 'dom') {
      const node = c.originalItem as DomNode | undefined;
      const attrs = node?.attributes || {};
      const id = attrs.id ? `#${attrs.id}` : '';
      const name = attrs.name ? `[name="${attrs.name}"]` : '';
      const selector = id || name;

      // Determine the most descriptive human-readable label
      const fieldTitle =
        attrs.placeholder ||
        attrs.label ||
        (attrs.id ? attrs.id.replace(/([A-Z])/g, ' $1').trim() : '') ||
        (attrs.name ? attrs.name.replace(/([A-Z_])/g, ' $1').trim() : '') ||
        c.category.toUpperCase();

      if (c.matchedText) {
        details = selector
          ? `Matched "${c.matchedText}" in ${fieldTitle} (${selector})`
          : `Matched "${c.matchedText}" in ${fieldTitle}`;
      } else if (attrs.value && attrs.value.trim().length > 0 && !attrs.value.startsWith('[REDACTED')) {
        const valPreview = attrs.value.length > 25 ? `${attrs.value.slice(0, 22)}...` : attrs.value;
        details = selector
          ? `Field "${fieldTitle}" (${selector}) [Value: "${valPreview}"]`
          : `Field "${fieldTitle}" [Value: "${valPreview}"]`;
      } else if (selector) {
        details = `Field "${fieldTitle}" (${selector})`;
      } else {
        details = `Field "${fieldTitle}" protected by policy`;
      }
    } else {
      // Visual source
      const rawText = (c.originalItem as VisualRegion)?.extractedText || '';
      if (c.matchedText) {
        details = `OCR matched: "${c.matchedText}"`;
      } else if (rawText) {
        const textPreview = rawText.length > 30 ? `${rawText.slice(0, 27)}...` : rawText;
        details = `OCR detected: "${textPreview}"`;
      } else {
        details = `Visual ${c.category} region`;
      }
    }

    auditLog.push({
      category: c.category,
      action,
      source: c.source,
      bbox: { ...c.bbox },
      timestamp: Date.now(),
      details,
      domId,
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
  const viewport = perceivedContext.viewport || rawContext.viewport || null;
  const redactedScreenshot = await renderRedactedScreenshot(rawScreenshot, blackoutBoxes, viewport);

  // 4. Calculate Summary Counts
  const summary = {
    totalDetected: uniqueClassifications.length,
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
    classifications: uniqueClassifications,
    sanitizedVisualRegions,
    summary,
    pendingAskFields,
    policyApplied: { ...policy },
  };
}

export default defineUnlistedScript(() => {});
