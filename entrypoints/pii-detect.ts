import type { DomNode, VisualRegion, PiiClassification } from '@/types';

// Regex patterns for value matching
const AADHAAR_REGEX = /\b\d{4}\s?\d{4}\s?\d{4}\b/;
const PAN_REGEX = /\b[A-Z]{5}\d{4}[A-Z]\b/i;
const PHONE_REGEX = /(?:\+91[\-\s]?)?[6-9]\d{9}|\b\d{3}[-\s.]?\d{3}[-\s.]?\d{4}\b/;
const EMAIL_REGEX = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/;
const AMOUNT_REGEX = /(?:₹|rs\.?|inr|\$|€|£)\s?\d+(?:,\d+)*(?:\.\d+)?/i;
const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/;
const CREDIT_CARD_REGEX = /\b(?:\d{4}[-\s]?){3}\d{4}\b/;
const API_KEY_REGEX = /\b(?:sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|hf_[a-zA-Z0-9]{20,}|AIza[0-9A-Za-z-_]{35}|bearer\s+[a-zA-Z0-9_\-\.]{20,}|(?:ey[a-zA-Z0-9_-]{15,}\.ey[a-zA-Z0-9_-]{15,}\.[a-zA-Z0-9_-]{15,}))\b/i;

// Label patterns for input attribute inspection (id, name, placeholder, autocomplete)
const INPUT_LABEL_PATTERNS: Array<{ category: string; regex: RegExp }> = [
  { category: 'password', regex: /\b(password|passwd|pass|pwd|secret|token|api[_\s-]?key|auth|pin|cvv|cvc)\b/i },
  { category: 'aadhaar', regex: /\b(aadhaar|adhaar|aadhar|uidai|abdhaar)\b/i },
  { category: 'pan', regex: /\b(pan|p\.a\.n|permanent\s*account)\b|^-?pan[:\s]/i },
  { category: 'ssn', regex: /\b(ssn|social\s*security|tax\s*id)\b/i },
  { category: 'credit_card', regex: /\b(card|credit|debit|cardnumber|cc-num|cc_number)\b/i },
  { category: 'phone', regex: /\b(phone|mobile|tel|telephone|cell|contact\s*no)\b/i },
  { category: 'email', regex: /\b(email|e-mail)\b/i },
  { category: 'name', regex: /\b(fullname|full_name|firstname|first_name|lastname|last_name|holder_name)\b/i },
  { category: 'dob', regex: /\b(dob|birthdate|date_of_birth|birth_date)\b/i },
  { category: 'address', regex: /\b(address|street|residence|addr_line)\b/i },
];

// Label patterns for visual OCR proximity
const LABEL_PATTERNS: Array<{ category: string; regex: RegExp }> = [
  { category: 'aadhaar', regex: /\b(aadhaar|adhaar|aadhar|uidai)\b/i },
  { category: 'pan', regex: /\b(pan\s*card|pan\s*no|p\.a\.n|permanent\s*account)\b|^-?pan[:\s]/i },
  { category: 'name', regex: /\b(full\s*name|holder\s*name|candidate\s*name|first\s*name|last\s*name)\b|^name[:\s]/i },
  { category: 'address', regex: /\b(street\s*address|residential\s*address|billing\s*address|shipping\s*address)\b|^address[:\s]/i },
  { category: 'phone', regex: /\b(phone\s*number|mobile\s*number|telephone|contact\s*no)\b|^phone[:\s]/i },
  { category: 'email', regex: /\b(email\s*address|e-mail\s*address)\b|^email[:\s]/i },
  { category: 'amount', regex: /\b(total\s*amount|subtotal|amount\s*due|grand\s*total)\b|^total[:\s]/i },
  { category: 'ssn', regex: /\b(ssn|social\s*security(?:\s*number)?|tax\s*id)\b/i },
  { category: 'credit_card', regex: /\b(credit\s*card|debit\s*card|card\s*number|cvv|cvc|cardnumber)\b/i },
  { category: 'password', regex: /\b(password|passcode|passwd)\b[:\s]?/i },
  { category: 'dob', regex: /\b(dob|birthdate|date\s*of\s*birth)\b/i },
];

/**
 * Structural / chrome patterns that are document titles, disclaimers, or layout chrome (not user form data)
 */
const DOCUMENT_CHROME_REGEX =
  /\b(government\s*of|covernment|republic\s*of|synthetic\s*test|sytimeing|mock\s*card|mock\s*identification|not\s*a\s*valid|receipt\s*for|evaluation\s*only|all\s*white\s*receipt)\b/i;

/**
 * Classifies both DOM text nodes and visual text regions into categories.
 * Implements regex detection + input attribute classification + label-proximity spatial detection.
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
    if (!rawText || DOCUMENT_CHROME_REGEX.test(rawText)) return;

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

    const apiKeyMatch = rawText.match(API_KEY_REGEX);
    if (apiKeyMatch) {
      classifications.push({
        category: 'password',
        source: 'visual',
        bbox: { x: region.bbox.x, y: region.bbox.y, width: region.bbox.w, height: region.bbox.h },
        matchedText: apiKeyMatch[0],
        confidenceInDetection: 0.99,
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

    // B. Label-based classification within the region
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

  // Pass 2: Spatial label proximity between adjacent visual regions
  visualRegions.forEach((regionB, indexB) => {
    if (visualClassified.has(indexB)) return;

    const rawTextB = regionB.extractedText.trim();
    if (!rawTextB || DOCUMENT_CHROME_REGEX.test(rawTextB)) return;

    for (const classified of classifications) {
      if (classified.source !== 'visual') continue;

      const boxA = classified.bbox;
      const boxB = {
        x: regionB.bbox.x,
        y: regionB.bbox.y,
        width: regionB.bbox.w,
        height: regionB.bbox.h,
      };

      const sameRow = Math.abs(boxA.y - boxB.y) <= Math.max(boxA.height, boxB.height) * 0.9;
      const isRightNeighbor = boxB.x >= boxA.x && boxB.x - (boxA.x + boxA.width) < 180;

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

  // ==========================================
  // 2. CLASSIFY DOM TEXT NODES (PHASE 1)
  // ==========================================
  domNodes.forEach((node, nodeIdx) => {
    if (node.tag === 'canvas') return;

    // Never mask action buttons, navigation links, or section headings as PII
    const isActionOrHeading =
      node.tag === 'button' ||
      node.role === 'button' ||
      node.tag === 'a' ||
      node.tag === 'h1' ||
      node.tag === 'h2' ||
      node.tag === 'h3' ||
      node.tag === 'h4' ||
      node.tag === 'h5' ||
      node.tag === 'h6' ||
      node.tag === 'label';

    const isInputField = node.tag === 'input' || node.tag === 'textarea' || node.tag === 'select';

    const nodeText = (node.text || '').trim();
    const nodeVal = (node.attributes?.value || '').trim();
    const combinedValueText = `${nodeVal || (isInputField ? '' : nodeText)}`.trim();
    const inputAttrs = `${node.attributes?.name || ''} ${node.attributes?.id || ''} ${
      node.attributes?.placeholder || ''
    } ${node.attributes?.['aria-label'] || ''} ${node.attributes?.autocomplete || ''}`.toLowerCase();
    const inputType = (node.attributes?.type || '').toLowerCase();

    const bbox = {
      x: node.boundingBox.x,
      y: node.boundingBox.y,
      width: node.boundingBox.width,
      height: node.boundingBox.height,
    };

    // 1. Password input type -> Immediate MASK
    if (isInputField && (inputType === 'password' || inputAttrs.includes('password') || inputAttrs.includes('secret') || inputAttrs.includes('token') || inputAttrs.includes('api_key') || inputAttrs.includes('apikey'))) {
      classifications.push({
        category: 'password',
        source: 'dom',
        bbox,
        matchedText: nodeVal ? '********' : undefined,
        confidenceInDetection: 0.99,
        originalIndex: nodeIdx,
        originalItem: node,
      });
      return;
    }

    // 2. Value Regex Detections (high-confidence pattern match on actual data)
    const textToCheck = isInputField ? (nodeVal || nodeText) : nodeText;

<<<<<<< HEAD
    if (textToCheck) {
      const apiKeyMatch = textToCheck.match(API_KEY_REGEX);
      if (apiKeyMatch) {
        classifications.push({
          category: 'password',
          source: 'dom',
          bbox,
          matchedText: apiKeyMatch[0],
          confidenceInDetection: 0.99,
          originalIndex: nodeIdx,
          originalItem: node,
        });
        return;
=======
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

    // C. Label & Attribute-based classification for form inputs and explicit labels
    if (isInput) {
      // Check input attributes (placeholder, name, id, etc.)
      for (const item of LABEL_PATTERNS) {
        if (item.category === 'password') continue; // Handled above
        if (item.regex.test(combinedAttrs)) {
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
    } else if (!isInteractiveOrHeading) {
      // For non-interactive text: only check if it is formatted as an explicit form label
      const isExplicitLabelFormat =
        node.tag === 'label' || /:\s*$/.test(combinedText) || combinedText.length <= 25;
      if (isExplicitLabelFormat) {
        for (const item of LABEL_PATTERNS) {
          if (item.category === 'password') continue; // Handled above
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
>>>>>>> 269857d863111dc4937309da436c10d27d93bc12
      }

      const aadhaarMatch = textToCheck.match(AADHAAR_REGEX);
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

      const panMatch = textToCheck.match(PAN_REGEX);
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

      const ssnMatch = textToCheck.match(SSN_REGEX);
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

      const ccMatch = textToCheck.match(CREDIT_CARD_REGEX);
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

      const phoneMatch = textToCheck.match(PHONE_REGEX);
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

      const emailMatch = textToCheck.match(EMAIL_REGEX);
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
    }

    // 3. Form Input Attribute Classification (ONLY for <input>, <textarea>, <select>)
    // Never classify static headings, labels, or buttons by attribute keywords!
    if (isInputField) {
      if (inputType === 'email') {
        classifications.push({
          category: 'email',
          source: 'dom',
          bbox,
          confidenceInDetection: 0.95,
          originalIndex: nodeIdx,
          originalItem: node,
        });
        return;
      }

      if (inputType === 'tel') {
        classifications.push({
          category: 'phone',
          source: 'dom',
          bbox,
          confidenceInDetection: 0.95,
          originalIndex: nodeIdx,
          originalItem: node,
        });
        return;
      }

      for (const item of INPUT_LABEL_PATTERNS) {
        if (item.regex.test(inputAttrs)) {
          classifications.push({
            category: item.category,
            source: 'dom',
            bbox,
            confidenceInDetection: 0.92,
            originalIndex: nodeIdx,
            originalItem: node,
          });
          return;
        }
      }
    }
  });

  return classifications;
}

export default defineUnlistedScript(() => {});
