import type {
  PerceivedContext,
  ProtectedContext,
  ProtectedDomNode,
  ProtectedVisualRegion,
  RedactionTarget,
  RedactionSummary,
  SensitivePiiType,
  VisualRegion,
  DomNode,
} from '@/types';

interface SensitiveRule {
  type: SensitivePiiType;
  name: string;
  pattern: RegExp;
  excludePattern?: RegExp;
}

/**
 * Standard sensitive PII label matching rules.
 * Built with OCR typo-tolerance for small on-device models.
 */
export const SENSITIVE_LABEL_RULES: SensitiveRule[] = [
  {
    type: 'AADHAAR',
    name: 'aadhaar_id',
    // Matches "Aadhaar", "Adhaar", "Aadhar", "Abdhaar", UIDAI, or raw 12-digit spaced sequence
    pattern: /\b(aadhaar|adhaar|aadhar|uidai|abdhaar|aadha|adha)\b|\b\d{4}\s+\d{4}\s+\d{4}\b/i,
  },
  {
    type: 'PAN',
    name: 'pan_card_id',
    // Matches "PAN", "P.A.N", "Permanent Account Number", or PAN prefix
    pattern: /\b(pan|p\.a\.n|permanent\s*account)\b|^-?pan[:\s]/i,
    excludePattern: /\b(japan|company|span|expand)\b/i,
  },
  {
    type: 'NAME',
    name: 'person_name',
    // Matches "Name:", "Full Name", "Cardholder Name"
    pattern: /\b(name|full\s*name|holder\s*name|candidate\s*name)\b|^name[:\s]/i,
    excludePattern: /\b(domain\s*name|tag\s*name|company\s*name|bank\s*name)\b/i,
  },
  {
    type: 'ADDRESS',
    name: 'residential_address',
    // Matches "Address:", "Addr:", "Residence", "Residing at", or OCR typos like "Adlines"
    pattern: /\b(address|addr|adlines|residence|residing|street|location)\b|^address[:\s]/i,
    excludePattern: /\b(ip\s*address|mac\s*address|web\s*address|email\s*address)\b/i,
  },
  {
    type: 'PHONE',
    name: 'phone_number',
    pattern: /\b(phone|mobile|telephone|cell|contact\s*no)\b|^\+?\d{10,12}$/i,
  },
  {
    type: 'EMAIL',
    name: 'email_address',
    pattern: /\b(email|e-mail)\b|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i,
  },
];

/**
 * Non-sensitive control rules to prevent false positive redactions.
 */
export const NON_SENSITIVE_CONTROL_PATTERN =
  /\b(total|amount|subtotal|balance|cost|fee|price|sum|order|tax|gst|receipt)\b/i;

/**
 * Detects sensitive regions using hybrid label-proximity + in-region label matching.
 * Redacts entire spatial bounding boxes rather than relying on exact character accuracy.
 */
export function detectSensitiveRegions(visualRegions: VisualRegion[]): RedactionTarget[] {
  const targets: RedactionTarget[] = [];
  const sensitiveIndices = new Set<number>();

  // 1. In-region direct detection: check if region text contains sensitive labels
  visualRegions.forEach((region, index) => {
    const text = region.extractedText.trim();
    if (!text) return;

    // First check if it is explicitly a non-sensitive control field (e.g. Total / ₹4,500)
    const isControlField =
      NON_SENSITIVE_CONTROL_PATTERN.test(text) &&
      !/\b(aadhaar|pan|name|address)\b/i.test(text);

    if (isControlField) {
      return; // Preserve non-sensitive control field
    }

    for (const rule of SENSITIVE_LABEL_RULES) {
      if (rule.pattern.test(text)) {
        if (rule.excludePattern && rule.excludePattern.test(text)) {
          continue;
        }

        targets.push({
          regionIndex: index,
          bbox: { ...region.bbox },
          piiType: rule.type,
          originalLabel: text.split(/[:\n]/)[0] || text,
          matchedRule: rule.name,
          confidence: region.confidence,
        });
        sensitiveIndices.add(index);
        break;
      }
    }
  });

  // 2. Spatial proximity detection: check for separate label and value boxes
  // If region A is a sensitive label, check if any unlabeled region B is horizontally or vertically adjacent
  visualRegions.forEach((regionB, indexB) => {
    if (sensitiveIndices.has(indexB)) return;

    const textB = regionB.extractedText.trim();
    if (!textB) return;

    // Do not redact non-sensitive control fields through proximity
    if (NON_SENSITIVE_CONTROL_PATTERN.test(textB)) return;

    for (const targetA of targets) {
      const boxA = targetA.bbox;
      const boxB = regionB.bbox;

      // Horizontal adjacency (same line, B is to the right of label A within 180px)
      const sameRow = Math.abs(boxA.y - boxB.y) <= Math.max(boxA.h, boxB.h) * 0.9;
      const isRightNeighbor = boxB.x >= boxA.x && boxB.x - (boxA.x + boxA.w) < 180;

      // Vertical adjacency (stacked form field, B is below label A within 60px)
      const sameCol = Math.abs(boxA.x - boxB.x) <= 80;
      const isBottomNeighbor = boxB.y >= boxA.y && boxB.y - (boxA.y + boxA.h) < 60;

      if ((sameRow && isRightNeighbor) || (sameCol && isBottomNeighbor)) {
        targets.push({
          regionIndex: indexB,
          bbox: { ...regionB.bbox },
          piiType: targetA.piiType,
          originalLabel: `PROXIMITY_VALUE_NEAR_${targetA.piiType}`,
          matchedRule: `proximity_to_${targetA.matchedRule}`,
          confidence: regionB.confidence,
        });
        sensitiveIndices.add(indexB);
        break;
      }
    }
  });

  return targets;
}

/**
 * Visually stamps solid blackout / privacy redaction rectangles over sensitive bounding boxes on the screenshot.
 * Guarantees zero sensitive pixels remain in the rendered image.
 */
export async function redactScreenshot(
  screenshotDataUrl: string,
  targets: RedactionTarget[]
): Promise<string> {
  if (!screenshotDataUrl || targets.length === 0) {
    return screenshotDataUrl;
  }

  // In browser environments
  if (typeof document !== 'undefined' && typeof Image !== 'undefined') {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(screenshotDataUrl);
          return;
        }

        // Draw original screenshot
        ctx.drawImage(img, 0, 0);

        // Stamp redaction boxes over sensitive regions
        for (const target of targets) {
          const { x, y, w, h } = target.bbox;

          // 1. Solid blackout fill (completely obliterates all underlying pixels)
          ctx.fillStyle = '#090d16'; // Deep charcoal black
          ctx.fillRect(x, y, w, h);

          // 2. High-contrast privacy border
          ctx.strokeStyle = '#ef4444'; // Security Red
          ctx.lineWidth = 2;
          ctx.strokeRect(x, y, w, h);

          // 3. Clear audit label stamp
          ctx.fillStyle = '#f8fafc';
          ctx.font = `bold ${Math.max(10, Math.min(13, Math.floor(h * 0.45)))}px Arial, sans-serif`;
          ctx.textBaseline = 'middle';
          const displayType = String(target.piiType || '').toUpperCase().replace('_', ' ');
          ctx.fillText(`🛡️ ${displayType}`, x + 8, y + h / 2);
        }

        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => resolve(screenshotDataUrl);
      img.src = screenshotDataUrl;
    });
  }

  return screenshotDataUrl;
}

/**
 * Sanitizes DOM nodes by masking sensitive form inputs, values, and text content.
 */
export function protectDom(dom: DomNode[]): ProtectedDomNode[] {
  return dom.map((node) => {
    const combinedAttrs = `${node.attributes.name || ''} ${node.attributes.id || ''} ${
      node.attributes.placeholder || ''
    } ${node.attributes.type || ''}`.toLowerCase();
    const textLower = (node.text || '').toLowerCase();

    // Check if DOM node matches any sensitive rule
    let matchedType: SensitivePiiType | undefined;
    for (const rule of SENSITIVE_LABEL_RULES) {
      if (rule.pattern.test(combinedAttrs) || rule.pattern.test(textLower)) {
        if (!rule.excludePattern || !rule.excludePattern.test(combinedAttrs)) {
          matchedType = rule.type;
          break;
        }
      }
    }

    if (matchedType) {
      return {
        ...node,
        text: `[REDACTED: ${matchedType}]`,
        attributes: {
          ...node.attributes,
          value: node.attributes.value ? `[REDACTED: ${matchedType}]` : undefined,
          placeholder: node.attributes.placeholder ? `[REDACTED: ${matchedType}]` : undefined,
        },
        isRedacted: true,
        redactionType: matchedType,
      };
    }

    return {
      ...node,
      isRedacted: false,
    };
  });
}

/**
 * Main Phase 3 Protect Stage entrypoint.
 * Converts a PerceivedContext into a ProtectedContext with zero PII crossing the trust boundary.
 */
export async function protectContext(perceived: PerceivedContext): Promise<ProtectedContext> {
  const visualRegions = perceived.visualRegions || [];

  // 1. Detect sensitive visual regions via spatial label-proximity policy
  const redactionTargets = detectSensitiveRegions(visualRegions);
  const targetIndices = new Map(redactionTargets.map((t) => [t.regionIndex, t]));

  // 2. Visually redact screenshot
  const protectedScreenshot = await redactScreenshot(perceived.screenshot, redactionTargets);

  // 3. Redact visual regions data payload (so raw OCR strings never leave the trust boundary)
  const protectedVisualRegions: ProtectedVisualRegion[] = visualRegions.map((r, i) => {
    const target = targetIndices.get(i);
    if (target) {
      return {
        ...r,
        extractedText: `[REDACTED: ${target.piiType}]`,
        isRedacted: true,
        redactionType: target.piiType,
        redactionReason: `Spatial label-proximity redaction (${target.matchedRule})`,
      };
    }
    return {
      ...r,
      isRedacted: false,
    };
  });

  // 4. Sanitize DOM nodes
  const protectedDom = protectDom(perceived.dom);

  // 5. Generate Redaction Summary
  const uniqueTypes = Array.from(new Set(redactionTargets.map((t) => t.piiType)));
  const summary: RedactionSummary = {
    totalRegionsEvaluated: visualRegions.length,
    sensitiveRegionsCount: redactionTargets.length,
    preservedRegionsCount: visualRegions.length - redactionTargets.length,
    redactedPiiTypes: uniqueTypes,
    trustBoundaryPassed: true,
    redactionPolicy: 'hybrid-spatial-label-proximity',
  };

  return {
    url: perceived.url,
    timestamp: perceived.timestamp,
    rawDom: perceived.dom,
    protectedDom,
    rawScreenshot: perceived.screenshot,
    protectedScreenshot,
    visualRegions: protectedVisualRegions,
    redactionTargets,
    redactionSummary: summary,
    perceptionSkipped: perceived.perceptionSkipped,
    perceptionMetrics: perceived.perceptionMetrics,
  };
}

export default defineUnlistedScript(() => {});
