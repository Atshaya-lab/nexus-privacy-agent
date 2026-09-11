import type { PolicyAction, PolicyRecord } from '@/types';

/**
 * Default Policy Configuration:
 * - Aadhaar: MASK
 * - PAN: MASK
 * - Name: MASK
 * - Address: MASK
 * - Amount: ALLOW
 * - Phone: MASK
 * - Email: MASK
 */
export const DEFAULT_POLICY: PolicyRecord = {
  aadhaar: 'MASK',
  pan: 'MASK',
  name: 'MASK',
  address: 'MASK',
  amount: 'ALLOW',
  phone: 'MASK',
  email: 'MASK',
  ssn: 'MASK',
  credit_card: 'MASK',
  password: 'MASK',
  dob: 'MASK',
};

const STORAGE_KEY = 'nexus_privacy_policy';

// In-memory cache to guarantee zero-overhead synchronous reads and zero-throw reliability
let cachedPolicy: PolicyRecord = { ...DEFAULT_POLICY };

/**
 * DEFAULT BEHAVIOR: any field category not explicitly configured by the user
 * defaults to 'MASK' — never silently ALLOW unrecognized/unclassified sensitive-looking content.
 * This is a hard rule, not a suggestion.
 */
export function resolvePolicyAction(policy: PolicyRecord, category: string): PolicyAction {
  const norm = (category || '').toLowerCase().trim();
  if (policy && typeof policy[norm] === 'string') {
    return policy[norm];
  }
  // Hard fail-safe default: MASK
  return 'MASK';
}

/**
 * Persist the policy in chrome.storage.local so it survives across sessions.
 * Completely silent and never logs warnings into the webpage developer console.
 */
export async function getPolicy(): Promise<PolicyRecord> {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.id && chrome.storage?.local) {
      try {
        if (!chrome.runtime.getManifest()) {
          return cachedPolicy;
        }
      } catch {
        return cachedPolicy;
      }

      const data = await chrome.storage.local.get(STORAGE_KEY).catch(() => null);
      if (data && data[STORAGE_KEY]) {
        cachedPolicy = { ...DEFAULT_POLICY, ...data[STORAGE_KEY] };
        return cachedPolicy;
      }
    }
  } catch {
    // Silent fail-safe: never throw or warn into website console
  }
  return cachedPolicy || { ...DEFAULT_POLICY };
}

/**
 * Update and persist policy in chrome.storage.local.
 */
export async function setPolicy(policy: PolicyRecord): Promise<void> {
  cachedPolicy = { ...policy };
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.id && chrome.storage?.local) {
      try {
        if (!chrome.runtime.getManifest()) return;
      } catch {
        return;
      }
      await chrome.storage.local.set({ [STORAGE_KEY]: policy }).catch(() => {});
    }
  } catch {
    // Silent fail-safe
  }
}

export default defineUnlistedScript(() => {});
