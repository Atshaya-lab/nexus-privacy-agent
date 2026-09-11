import type { DomNode, UserProfile } from '@/types';

export type ProfileFieldKey = keyof Omit<UserProfile, 'updatedAt'>;

export interface FieldSignals {
  tag?: string;
  type?: string;
  name?: string;
  id?: string;
  placeholder?: string;
  autocomplete?: string;
  ariaLabel?: string;
  labelText?: string;
  currentValue?: string;
}

export interface FieldClassificationResult {
  dataKey: ProfileFieldKey | 'unclassified';
  confidence: number; // 0.0 - 1.0
  matchedSignal?: string;
  reason?: string;
}

/**
 * Standard keyword rules for mapping DOM attributes to UserProfile field keys.
 */
const CLASSIFICATION_RULES: Record<
  ProfileFieldKey,
  {
    autocomplete: string[];
    types: string[];
    keywords: string[];
    negativeKeywords?: string[];
  }
> = {
  email: {
    autocomplete: ['email'],
    types: ['email'],
    keywords: ['email', 'e-mail', 'mail_address', 'email_address', 'user_email', 'useremail', 'user email'],
    negativeKeywords: ['confirm_email', 'secondary_email'],
  },
  phone: {
    autocomplete: ['tel', 'tel-national', 'tel-local', 'mobile'],
    types: ['tel'],
    keywords: [
      'phone',
      'telephone',
      'mobile',
      'cell',
      'contact_no',
      'contact_num',
      'phone_number',
      'mobile_no',
      'mobile_number',
      'usernumber',
      'user number',
      'whatsapp',
    ],
    negativeKeywords: ['fax', 'emergency_contact', 'card', 'aadhaar'],
  },
  firstName: {
    autocomplete: ['given-name', 'fname'],
    types: [],
    keywords: ['first_name', 'firstname', 'fname', 'given_name', 'forename'],
    negativeKeywords: ['last_name', 'family_name', 'full_name'],
  },
  lastName: {
    autocomplete: ['family-name', 'lname', 'surname'],
    types: [],
    keywords: ['last_name', 'lastname', 'lname', 'surname', 'family_name'],
    negativeKeywords: ['first_name', 'given_name', 'full_name'],
  },
  fullName: {
    autocomplete: ['name'],
    types: [],
    keywords: [
      'full_name',
      'fullname',
      'your_name',
      'applicant_name',
      'candidate_name',
      'customer_name',
      'name',
    ],
    negativeKeywords: ['first_name', 'last_name', 'username', 'user_name', 'company_name', 'card_name'],
  },
  pincode: {
    autocomplete: ['postal-code', 'zip-code'],
    types: [],
    keywords: ['pincode', 'pin_code', 'postal_code', 'postalcode', 'zip', 'zipcode', 'zip_code', 'postcode'],
    negativeKeywords: [],
  },
  dateOfBirth: {
    autocomplete: ['bday'],
    types: ['date'],
    keywords: ['dob', 'date_of_birth', 'birth_date', 'birthdate', 'birthday', 'dateofbirth', 'date of birth'],
    negativeKeywords: ['expiry_date', 'valid_till', 'issue_date'],
  },
  gender: {
    autocomplete: ['sex'],
    types: [],
    keywords: ['gender', 'sex'],
    negativeKeywords: [],
  },
  city: {
    autocomplete: ['address-level2'],
    types: [],
    keywords: ['city', 'town', 'district'],
    negativeKeywords: [],
  },
  state: {
    autocomplete: ['address-level1'],
    types: [],
    keywords: ['state', 'province', 'region'],
    negativeKeywords: ['statement', 'state_code'],
  },
  address: {
    autocomplete: ['street-address', 'address-line1'],
    types: [],
    keywords: [
      'address',
      'street',
      'street_address',
      'residential_address',
      'permanent_address',
      'current_address',
      'currentaddress',
      'current address',
      'permanentaddress',
      'permanent address',
      'address_line',
      'flat_no',
      'house_no',
      'addr',
    ],
    negativeKeywords: ['email_address', 'ip_address', 'mac_address', 'web_address'],
  },
};

/**
 * Normalizes text to lowercase with standard word boundaries.
 */
function normalizeSignal(text?: string): string {
  if (!text) return '';
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[_\-\.\:\/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Classifies field signals into an abstract ProfileFieldKey.
 */
export function classifyField(signals: FieldSignals): FieldClassificationResult {
  const normAutocomplete = (signals.autocomplete || '').trim().toLowerCase();
  const normType = (signals.type || '').trim().toLowerCase();
  const normName = normalizeSignal(signals.name);
  const normId = normalizeSignal(signals.id);
  const normPlaceholder = normalizeSignal(signals.placeholder);
  const normAria = normalizeSignal(signals.ariaLabel);
  const normLabel = normalizeSignal(signals.labelText);

  // 1. High Confidence: HTML5 autocomplete attribute match
  if (normAutocomplete) {
    for (const [key, rule] of Object.entries(CLASSIFICATION_RULES) as [ProfileFieldKey, typeof CLASSIFICATION_RULES[ProfileFieldKey]][]) {
      if (rule.autocomplete.some((ac) => normAutocomplete === ac || normAutocomplete.includes(ac))) {
        return {
          dataKey: key,
          confidence: 0.98,
          matchedSignal: `autocomplete="${signals.autocomplete}"`,
          reason: `Exact match on HTML autocomplete token`,
        };
      }
    }
  }

  // 2. High Confidence: Input Type exact match (email, tel, date)
  if (normType) {
    for (const [key, rule] of Object.entries(CLASSIFICATION_RULES) as [ProfileFieldKey, typeof CLASSIFICATION_RULES[ProfileFieldKey]][]) {
      if (rule.types.includes(normType)) {
        // Double check not a negative keyword in name/id
        return {
          dataKey: key,
          confidence: 0.92,
          matchedSignal: `type="${signals.type}"`,
          reason: `HTML input type '${signals.type}' maps directly to ${key}`,
        };
      }
    }
  }

  // 3. High to Medium Confidence: Explicit keyword match in name or id
  const combinedIdent = `${normName} ${normId}`;
  for (const [key, rule] of Object.entries(CLASSIFICATION_RULES) as [ProfileFieldKey, typeof CLASSIFICATION_RULES[ProfileFieldKey]][]) {
    // Check negatives first
    if (rule.negativeKeywords && rule.negativeKeywords.some((neg) => combinedIdent.includes(neg.replace(/_/g, ' ')))) {
      continue;
    }

    for (const kw of rule.keywords) {
      const cleanKw = kw.replace(/_/g, ' ');
      // Exact word boundary match in name/id
      const regex = new RegExp(`(^|\\s)${cleanKw}(\\s|$)`, 'i');
      if (regex.test(combinedIdent)) {
        return {
          dataKey: key,
          confidence: 0.88,
          matchedSignal: `identifier="${signals.name || signals.id}" (matched "${kw}")`,
          reason: `Strong attribute identifier match for ${key}`,
        };
      }
    }
  }

  // 4. Medium Confidence: Label text match
  if (normLabel) {
    for (const [key, rule] of Object.entries(CLASSIFICATION_RULES) as [ProfileFieldKey, typeof CLASSIFICATION_RULES[ProfileFieldKey]][]) {
      if (rule.negativeKeywords && rule.negativeKeywords.some((neg) => normLabel.includes(neg.replace(/_/g, ' ')))) {
        continue;
      }

      for (const kw of rule.keywords) {
        const cleanKw = kw.replace(/_/g, ' ');
        const regex = new RegExp(`(^|\\s)${cleanKw}(\\s|$)`, 'i');
        if (regex.test(normLabel)) {
          return {
            dataKey: key,
            confidence: 0.82,
            matchedSignal: `label="${signals.labelText}"`,
            reason: `Surrounding form label indicates field represents ${key}`,
          };
        }
      }
    }
  }

  // 5. Medium-Low Confidence: Placeholder or Aria Label
  const combinedHints = `${normPlaceholder} ${normAria}`;
  if (combinedHints.trim()) {
    for (const [key, rule] of Object.entries(CLASSIFICATION_RULES) as [ProfileFieldKey, typeof CLASSIFICATION_RULES[ProfileFieldKey]][]) {
      if (rule.negativeKeywords && rule.negativeKeywords.some((neg) => combinedHints.includes(neg.replace(/_/g, ' ')))) {
        continue;
      }

      for (const kw of rule.keywords) {
        const cleanKw = kw.replace(/_/g, ' ');
        const regex = new RegExp(`(^|\\s)${cleanKw}(\\s|$)`, 'i');
        if (regex.test(combinedHints)) {
          return {
            dataKey: key,
            confidence: 0.75,
            matchedSignal: `placeholder/aria="${signals.placeholder || signals.ariaLabel}"`,
            reason: `Placeholder text or aria-label suggests field represents ${key}`,
          };
        }
      }
    }
  }

  // Fall-safe: unclassified
  return {
    dataKey: 'unclassified',
    confidence: 0.0,
    reason: 'No matching user profile attribute found for field signals',
  };
}

/**
 * Classifies a DOM Node extracted during context perception.
 */
export function classifyDomNode(node: DomNode): FieldClassificationResult {
  const attrs = node.attributes || {};
  return classifyField({
    tag: node.tag,
    type: attrs.type,
    name: attrs.name,
    id: attrs.id,
    placeholder: attrs.placeholder,
    autocomplete: attrs.autocomplete,
    ariaLabel: attrs['aria-label'],
    labelText: attrs.label || attrs['data-label'] || attrs.title || node.text,
    currentValue: attrs.value,
  });
}

/**
 * Classifies an actual live HTML element in the content script.
 */
export function classifyElement(el: HTMLElement): FieldClassificationResult {
  const inputEl = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  let labelText = '';

  // Check <label for="id">
  if (el.id) {
    const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (l) labelText = (l.textContent || '').trim();
  }

  // Check parent or closest label
  if (!labelText) {
    const closestLabel = el.closest('label');
    if (closestLabel) labelText = (closestLabel.textContent || '').trim();
  }

  // Check previous sibling or container label
  if (!labelText && el.parentElement) {
    const rowLabel = el.parentElement.querySelector('label');
    if (rowLabel && rowLabel !== (el as HTMLElement)) {
      labelText = (rowLabel.textContent || '').trim();
    }
  }

  return classifyField({
    tag: el.tagName.toLowerCase(),
    type: (inputEl as HTMLInputElement).type,
    name: inputEl.name,
    id: el.id,
    placeholder: (inputEl as HTMLInputElement).placeholder,
    autocomplete: (inputEl as HTMLInputElement).autocomplete,
    ariaLabel: el.getAttribute('aria-label') || undefined,
    labelText,
    currentValue: inputEl.value,
  });
}
