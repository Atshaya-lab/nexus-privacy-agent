import type { DomNode, VisualRegion, PiiClassification } from '@/types';

// Regex patterns for value matching
const AADHAAR_REGEX = /\b\d{4}\s?\d{4}\s?\d{4}\b/;
const PAN_REGEX = /\b[A-Z]{5}\d{4}[A-Z]\b/i;
const PHONE_REGEX = /(\+91[\-\s]?)?[6-9]\d{9}/;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const AMOUNT_REGEX = /(?:₹|rs\.?|inr|\$)\s?\d+(?:,\d+)*(?:\.\d+)?/i;

// Label patterns for label-proximity classification
const LABEL_PATTERNS: Array<{ category: string; regex: RegExp }> = [
  { category: 'aadhaar', regex: /\b(aadhaar|adhaar|aadhar|uidai|abdhaar|aadha|adha)\b/i },
  { category: 'pan', regex: /\b(pan|p\.a\.n|permanent\s*account)\b|^-?pan[:\s]/i },
  { category: 'name', regex: /\b(name|full\s*name|holder\s*name|candidate\s*name)\b|^name[:\s]/i },
  { category: 'address', regex: /\b(address|addr|adlines|residence|residing|street|location)\b|^address[:\s]/i },
  { category: 'phone', regex: /\b(phone|mobile|tel|telephone|cell|contact\s*no)\b/i },
  { category: 'email', regex: /\b(email|e-mail)\b/i },
  { category: 'amount', regex: /\b(total|amount|subtotal|balance|price|cost|fee)\b/i },
];

/**
 * Structural / chrome patterns that are document titles, disclaimers, or layout chrome (not user form data)
 */
const DOCUMENT_CHROME_REGEX =
  /\b(government\s*of|covernment|republic\s*of|synthetic\s*test|sytimeing|mock\s*card|mock\s*identification|not\s*a\s*valid|receipt\s*for|evaluation\s*only|all\s*white\s*receipt)\b/i;

/**
 * Classifies both DOM text nodes and visual text regions into categories.
 * Implements regex detection + label-proximity spatial detection.
 */
export function detectPii(
  domNodes: DomNode[] = [],
  visualRegions: VisualRegion[] = []
): PiiClassification[] {
  const classifications: PiiClassification[] = [];

  // ==========================================
  // 1. CLASSIFY VISUAL TEXT REGIONS (PHASE 2)
  // ==========================================
  const visualClassified = new Set<number>();

  // Pass 1: In-region regex & direct label match
  visualRegions.forEach((region, index) => {
    const rawText = region.extractedText.trim();
    if (!rawText) return;

    // Check if it's document chrome / banner
    if (DOCUMENT_CHROME_REGEX.test(rawText)) {
      return; // Skip document chrome
    }

    // A. Regex value detections (includes matchedText)
    const aadhaarMatch = rawText.match(AADHAAR_REGEX);
    if (aadhaarMatch) {
      classifications.push({
        category: 'aadhaar',
        source: 'visual',
        bbox: { x: region.bbox.x, y: region.bbox.y, width: region.bbox.w, height: region.bbox.h },
        matchedText: aadhaarMatch[0],
        confidenceInDetection: 0.95,
        originalIndex: index,
        originalItem: region,
      });
      visualClassified.add(index);
      return;
    }

    const panMatch = rawText.match(PAN_REGEX);
    if (panMatch) {
      classifications.push({
        category: 'pan',
        source: 'visual',
        bbox: { x: region.bbox.x, y: region.bbox.y, width: region.bbox.w, height: region.bbox.h },
        matchedText: panMatch[0],
        confidenceInDetection: 0.95,
        originalIndex: index,
        originalItem: region,
      });
      visualClassified.add(index);
      return;
    }

    const phoneMatch = rawText.match(PHONE_REGEX);
    if (phoneMatch) {
      classifications.push({
        category: 'phone',
        source: 'visual',
        bbox: { x: region.bbox.x, y: region.bbox.y, width: region.bbox.w, height: region.bbox.h },
        matchedText: phoneMatch[0],
        confidenceInDetection: 0.9,
        originalIndex: index,
        originalItem: region,
      });
      visualClassified.add(index);
      return;
    }

    const emailMatch = rawText.match(EMAIL_REGEX);
    if (emailMatch) {
      classifications.push({
        category: 'email',
        source: 'visual',
        bbox: { x: region.bbox.x, y: region.bbox.y, width: region.bbox.w, height: region.bbox.h },
        matchedText: emailMatch[0],
        confidenceInDetection: 0.9,
        originalIndex: index,
        originalItem: region,
      });
      visualClassified.add(index);
      return;
    }

    const amountMatch = rawText.match(AMOUNT_REGEX);
    if (amountMatch) {
      classifications.push({
        category: 'amount',
        source: 'visual',
        bbox: { x: region.bbox.x, y: region.bbox.y, width: region.bbox.w, height: region.bbox.h },
        matchedText: amountMatch[0],
        confidenceInDetection: 0.9,
        originalIndex: index,
        originalItem: region,
      });
      visualClassified.add(index);
      return;
    }

    // B. Label-based classification within the region (e.g. "Name: Rahul", "-PAN: ABCDE124F")
    // NOTE: matchedText is omitted for label-proximity-only detections per requirement
    for (const item of LABEL_PATTERNS) {
      if (item.regex.test(rawText)) {
        classifications.push({
          category: item.category,
          source: 'visual',
          bbox: { x: region.bbox.x, y: region.bbox.y, width: region.bbox.w, height: region.bbox.h },
          confidenceInDetection: 0.88,
          originalIndex: index,
          originalItem: region,
        });
        visualClassified.add(index);
        return;
      }
    }
  });

  // Pass 2: Spatial label proximity between adjacent visual regions (multi-box layouts)
  visualRegions.forEach((regionB, indexB) => {
    if (visualClassified.has(indexB)) return;

    const rawTextB = regionB.extractedText.trim();
    if (!rawTextB || DOCUMENT_CHROME_REGEX.test(rawTextB)) return;

    // Check if regionB is spatially adjacent to any classified regionA that acted as a label
    for (const classified of classifications) {
      if (classified.source !== 'visual') continue;

      const boxA = classified.bbox;
      const boxB = {
        x: regionB.bbox.x,
        y: regionB.bbox.y,
        width: regionB.bbox.w,
        height: regionB.bbox.h,
      };

      // Same horizontal row (adjacent on right within 180px)
      const sameRow = Math.abs(boxA.y - boxB.y) <= Math.max(boxA.height, boxB.height) * 0.9;
      const isRightNeighbor = boxB.x >= boxA.x && boxB.x - (boxA.x + boxA.width) < 180;

      // Same vertical column: only if boxA was a short label-only prompt (not already containing a full value)
      const textA = (classified.originalItem?.extractedText || '').trim();
      const isLabelOnlyA = !textA.includes(':') || textA.endsWith(':') || textA.length <= 10;
      const sameCol = Math.abs(boxA.x - boxB.x) <= 80;
      const isBottomNeighbor = isLabelOnlyA && boxB.y >= boxA.y && boxB.y - (boxA.y + boxA.height) < 50;

      if ((sameRow && isRightNeighbor) || (sameCol && isBottomNeighbor)) {
        classifications.push({
          category: classified.category,
          source: 'visual',
          bbox: boxB,
          confidenceInDetection: 0.82,
          originalIndex: indexB,
          originalItem: regionB,
        });
        visualClassified.add(indexB);
        return;
      }
    }
  });

  // Pass 3: Hard fail-safe: Any unclassified visual region on canvas/UI defaults to 'unclassified'
  visualRegions.forEach((region, index) => {
    if (visualClassified.has(index)) return;

    const rawText = region.extractedText.trim();
    if (!rawText || DOCUMENT_CHROME_REGEX.test(rawText)) return;

    // Region is unclassified text content: tag as 'unclassified'
    classifications.push({
      category: 'unclassified',
      source: 'visual',
      bbox: { x: region.bbox.x, y: region.bbox.y, width: region.bbox.w, height: region.bbox.h },
      confidenceInDetection: 0.7,
      originalIndex: index,
      originalItem: region,
    });
    visualClassified.add(index);
  });

  // ==========================================
  // 2. CLASSIFY DOM TEXT NODES (PHASE 1)
  // ==========================================
  domNodes.forEach((node, nodeIdx) => {
    if (node.tag === 'canvas') return; // Canvas content handled visually

    const combinedText = `${node.text || ''} ${node.attributes?.value || ''}`.trim();
    const combinedAttrs = `${node.attributes?.name || ''} ${node.attributes?.id || ''} ${
      node.attributes?.placeholder || ''
    } ${node.attributes?.type || ''}`.toLowerCase();

    if (!combinedText && !combinedAttrs) return;

    const bbox = {
      x: node.boundingBox.x,
      y: node.boundingBox.y,
      width: node.boundingBox.width,
      height: node.boundingBox.height,
    };

    // A. Regex value detections
    const aadhaarMatch = combinedText.match(AADHAAR_REGEX);
    if (aadhaarMatch) {
      classifications.push({
        category: 'aadhaar',
        source: 'dom',
        bbox,
        matchedText: aadhaarMatch[0],
        confidenceInDetection: 0.98,
        originalIndex: nodeIdx,
        originalItem: node,
      });
      return;
    }

    const panMatch = combinedText.match(PAN_REGEX);
    if (panMatch) {
      classifications.push({
        category: 'pan',
        source: 'dom',
        bbox,
        matchedText: panMatch[0],
        confidenceInDetection: 0.98,
        originalIndex: nodeIdx,
        originalItem: node,
      });
      return;
    }

    const phoneMatch = combinedText.match(PHONE_REGEX);
    if (phoneMatch) {
      classifications.push({
        category: 'phone',
        source: 'dom',
        bbox,
        matchedText: phoneMatch[0],
        confidenceInDetection: 0.95,
        originalIndex: nodeIdx,
        originalItem: node,
      });
      return;
    }

    const emailMatch = combinedText.match(EMAIL_REGEX);
    if (emailMatch) {
      classifications.push({
        category: 'email',
        source: 'dom',
        bbox,
        matchedText: emailMatch[0],
        confidenceInDetection: 0.95,
        originalIndex: nodeIdx,
        originalItem: node,
      });
      return;
    }

    const amountMatch = combinedText.match(AMOUNT_REGEX);
    if (amountMatch) {
      classifications.push({
        category: 'amount',
        source: 'dom',
        bbox,
        matchedText: amountMatch[0],
        confidenceInDetection: 0.95,
        originalIndex: nodeIdx,
        originalItem: node,
      });
      return;
    }

    // B. Label & Attribute-based classification
    for (const item of LABEL_PATTERNS) {
      if (item.regex.test(combinedAttrs) || item.regex.test(combinedText)) {
        classifications.push({
          category: item.category,
          source: 'dom',
          bbox,
          confidenceInDetection: 0.9,
          originalIndex: nodeIdx,
          originalItem: node,
        });
        return;
      }
    }
  });

  return classifications;
}

export default defineUnlistedScript(() => {});
