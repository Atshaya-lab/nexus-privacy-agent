import type { DomNode, VisualRegion, PiiClassification } from '@/types';

// Regex patterns for value matching
const AADHAAR_REGEX = /\b\d{4}\s?\d{4}\s?\d{4}\b/;
const PAN_REGEX = /\b[A-Z]{5}\d{4}[A-Z]\b/i;
const PHONE_REGEX = /(\+91[\-\s]?)?[6-9]\d{9}|\b\d{3}[-\s.]?\d{3}[-\s.]?\d{4}\b/;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const AMOUNT_REGEX = /(?:₹|rs\.?|inr|\$|€|£)\s?\d+(?:,\d+)*(?:\.\d+)?/i;
const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/;
const CREDIT_CARD_REGEX = /\b(?:\d{4}[-\s]?){3}\d{4}\b/;
const DATE_REGEX = /\b(?:\d{1,2}[-\/\s](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-\/\s]\d{2,4}|\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4}|\d{4}[-\/\.]\d{1,2}[-\/\.]\d{1,2})\b/i;

// Label patterns for label-proximity classification
const LABEL_PATTERNS: Array<{ category: string; regex: RegExp }> = [
  { category: 'aadhaar', regex: /\b(aadhaar|adhaar|aadhar|uidai)\b/i },
  { category: 'pan', regex: /\b(pan\s*card|pan\s*no|p\.a\.n|permanent\s*account)\b|^-?pan[:\s]/i },
  { category: 'name', regex: /\b(full\s*name|holder\s*name|candidate\s*name|first\s*name|last\s*name|user\s*name|firstname|lastname|fullname|username)\b|\bname\b/i },
  { category: 'address', regex: /\b(address|street|residential|billing|shipping|current\s*address|permanent\s*address|currentaddress|permanentaddress|useraddress)\b/i },
  { category: 'phone', regex: /\b(phone\s*number|mobile\s*number|telephone|contact\s*no|mobile\s*no|cell\s*phone|mobile|usernumber|userphone|usercontact)\b|\bphone\b/i },
  { category: 'email', regex: /\b(email\s*address|e-mail\s*address|e-mail|useremail)\b|\bemail\b/i },
  { category: 'amount', regex: /\b(total\s*amount|subtotal|amount\s*due|grand\s*total|amount|price|cost|salary)\b|^total[:\s]/i },
  { category: 'ssn', regex: /\b(ssn|social\s*security(?:\s*number)?|tax\s*id)\b/i },
  { category: 'credit_card', regex: /\b(credit\s*card|debit\s*card|card\s*number|cvv|cvc|cardnumber)\b/i },
  { category: 'password', regex: /\b(password|passcode|passwd)\b[:\s]?/i },
  { category: 'dob', regex: /\b(dob|birthdate|birthday|date\s*of\s*birth|dateofbirth|birthdateinput|dateofbirthinput)\b/i },
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
    } ${node.attributes?.type || ''} ${node.attributes?.label || ''} ${
      node.attributes?.['aria-label'] || ''
    }`.toLowerCase();

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

    const ssnMatch = combinedText.match(SSN_REGEX);
    if (ssnMatch) {
      classifications.push({
        category: 'ssn',
        source: 'dom',
        bbox,
        matchedText: ssnMatch[0],
        confidenceInDetection: 0.98,
        originalIndex: nodeIdx,
        originalItem: node,
      });
      return;
    }

    const ccMatch = combinedText.match(CREDIT_CARD_REGEX);
    if (ccMatch) {
      classifications.push({
        category: 'credit_card',
        source: 'dom',
        bbox,
        matchedText: ccMatch[0],
        confidenceInDetection: 0.98,
        originalIndex: nodeIdx,
        originalItem: node,
      });
      return;
    }

    // B. Password input detection:
    // A password is fundamentally a credential input field or explicit password label
    const isInput = node.tag === 'input' || node.tag === 'textarea';
    const isPasswordType = node.tag === 'input' && node.attributes?.type === 'password';
    const isPasswordAttr =
      isInput &&
      /\b(password|passwd|pwd|passcode|secret[_\s-]?key|api[_\s-]?key)\b/i.test(combinedAttrs);
    const isPasswordLabel =
      node.tag === 'label' &&
      /^\s*(?:enter\s+)?(?:password|passcode)\s*:?\s*$/i.test(combinedText);

    if (isPasswordType || isPasswordAttr || isPasswordLabel) {
      classifications.push({
        category: 'password',
        source: 'dom',
        bbox,
        confidenceInDetection: isPasswordType ? 1.0 : 0.9,
        originalIndex: nodeIdx,
        originalItem: node,
      });
      return;
    }

    // Interactive buttons, links (e.g. sidebar chat items), and headings are NOT passwords or form labels
    const isInteractiveOrHeading =
      node.tag === 'button' ||
      node.tag === 'a' ||
      node.tag === 'h1' ||
      node.tag === 'h2' ||
      node.tag === 'h3' ||
      node.tag === 'h4';

    // C. Label & Attribute-based classification for form inputs and read-only displayed records
    if (isInput) {
      const val = (node.attributes?.value || node.text || '').trim();
      const hasValue = val.length > 0;

      // Date input type check
      if (node.attributes?.type === 'date' && hasValue) {
        const dateMatch = combinedText.match(DATE_REGEX);
        classifications.push({
          category: 'dob',
          source: 'dom',
          bbox,
          matchedText: dateMatch ? dateMatch[0] : undefined,
          confidenceInDetection: 0.95,
          originalIndex: nodeIdx,
          originalItem: node,
        });
        return;
      }

      // Check input attributes and associated labels (only classify as sensitive PII if the field contains a value)
      if (hasValue) {
        for (const item of LABEL_PATTERNS) {
          if (item.category === 'password') continue; // Handled above
          if (item.regex.test(combinedAttrs)) {
            let matchedText: string | undefined;
            if (item.category === 'dob') {
              const dateMatch = combinedText.match(DATE_REGEX);
              if (dateMatch) matchedText = dateMatch[0];
            } else if (item.category === 'phone') {
              const phoneMatch = combinedText.match(PHONE_REGEX);
              if (phoneMatch) matchedText = phoneMatch[0];
            } else if (item.category === 'email') {
              const emailMatch = combinedText.match(EMAIL_REGEX);
              if (emailMatch) matchedText = emailMatch[0];
            }
            classifications.push({
              category: item.category,
              source: 'dom',
              bbox,
              matchedText: matchedText || val,
              confidenceInDetection: 0.92,
              originalIndex: nodeIdx,
              originalItem: node,
            });
            return;
          }
        }
      }
    } else if (!isInteractiveOrHeading && node.tag !== 'label') {
      // Never mask site UI form labels! Form labels are prompts for users, not user private data.
      // For read-only profile summaries (e.g. "Name: Rahul Sharma", "DOB: 10/05/1995"):
      // only classify if it actually contains a key-value format.
      const hasValueAfterColon = /:\s*\S+/.test(combinedText);
      if (hasValueAfterColon) {
        for (const item of LABEL_PATTERNS) {
          if (item.category === 'password') continue;
          if (item.regex.test(combinedText)) {
            classifications.push({
              category: item.category,
              source: 'dom',
              bbox,
              confidenceInDetection: 0.85,
              originalIndex: nodeIdx,
              originalItem: node,
            });
            return;
          }
        }
      }
    }
  });

  return deduplicateClassifications(classifications);
}

/**
 * Calculates overlap ratio between two bounding boxes relative to the smaller box.
 * Ratio >= 0.5 indicates significant spatial overlap / containment.
 */
export function computeOverlap(
  boxA: { x: number; y: number; width: number; height: number },
  boxB: { x: number; y: number; width: number; height: number }
): number {
  const x1 = Math.max(boxA.x, boxB.x);
  const y1 = Math.max(boxA.y, boxB.y);
  const x2 = Math.min(boxA.x + boxA.width, boxB.x + boxB.width);
  const y2 = Math.min(boxA.y + boxA.height, boxB.y + boxB.height);

  const interWidth = Math.max(0, x2 - x1);
  const interHeight = Math.max(0, y2 - y1);
  const interArea = interWidth * interHeight;

  if (interArea <= 0) return 0;

  const areaA = boxA.width * boxA.height;
  const areaB = boxB.width * boxB.height;
  const minArea = Math.min(areaA, areaB);

  return interArea / minArea;
}

/**
 * Deduplicates PII classifications across DOM and Visual perception streams:
 * 1. Resolves dual-pipeline collisions: Drops visual OCR regions that overlap an already-classified DOM element (overlap >= 0.40).
 * 2. Resolves DOM parent/container collisions: Drops redundant wrapper containers in favor of specific input/textarea controls (overlap >= 0.65).
 * 3. Enforces unique tracking by DOM element ID.
 */
export function deduplicateClassifications(rawList: PiiClassification[]): PiiClassification[] {
  if (!rawList || rawList.length <= 1) return rawList;

  const domClassifications = rawList.filter((c) => c.source === 'dom');
  const visualClassifications = rawList.filter((c) => c.source === 'visual');

  // 1. Deduplicate DOM nodes
  const keptDom: PiiClassification[] = [];
  const seenDomIds = new Set<string>();

  // Sort DOM nodes so specific form controls (input, textarea, select) have precedence over wrappers
  domClassifications.sort((a, b) => {
    const aTag = (a.originalItem as DomNode)?.tag?.toLowerCase() || '';
    const bTag = (b.originalItem as DomNode)?.tag?.toLowerCase() || '';
    const aIsControl = ['input', 'textarea', 'select'].includes(aTag) ? 1 : 0;
    const bIsControl = ['input', 'textarea', 'select'].includes(bTag) ? 1 : 0;
    if (aIsControl !== bIsControl) return bIsControl - aIsControl;
    return (b.confidenceInDetection || 0) - (a.confidenceInDetection || 0);
  });

  for (const domItem of domClassifications) {
    const domId = (domItem.originalItem as DomNode)?.attributes?.['data-nexus-dom-id'];
    if (domId && seenDomIds.has(domId)) continue;

    // Check if this DOM item significantly overlaps with any already kept DOM item
    const isDuplicate = keptDom.some((kept) => {
      const overlap = computeOverlap(domItem.bbox, kept.bbox);
      return overlap >= 0.65;
    });

    if (!isDuplicate) {
      if (domId) seenDomIds.add(domId);
      keptDom.push(domItem);
    }
  }

  // 2. Deduplicate Visual classifications against kept DOM nodes
  const keptVisual: PiiClassification[] = [];
  for (const visItem of visualClassifications) {
    // If a DOM node already covers this visual region (> 40% overlap), drop visual duplicate
    const overlapsDom = keptDom.some((domItem) => {
      const overlap = computeOverlap(visItem.bbox, domItem.bbox);
      return overlap >= 0.40;
    });

    if (overlapsDom) continue;

    // Check against already kept visual items
    const overlapsVisual = keptVisual.some((kept) => {
      return computeOverlap(visItem.bbox, kept.bbox) >= 0.60;
    });

    if (!overlapsVisual) {
      keptVisual.push(visItem);
    }
  }

  return [...keptDom, ...keptVisual];
}

export default defineUnlistedScript(() => {});
