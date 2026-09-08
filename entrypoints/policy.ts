import type { PolicyAction, PolicyRecord } from '@/types';

/**
 * Default Policy Configuration:
 * - Aadhaar: MASK
 * - PAN: MASK
 * - Name: ASK
 * - Address: MASK
 * - Amount: ALLOW
 * - Phone: MASK
 * - Email: MASK
 */
export const DEFAULT_POLICY: PolicyRecord = {
  aadhaar: 'MASK',
  pan: 'MASK',
  name: 'ASK',
  address: 'MASK',
  amount: 'ALLOW',
  phone: 'MASK',
  email: 'MASK',
};

const STORAGE_KEY = 'nexus_privacy_policy';

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
 */
export async function getPolicy(): Promise<PolicyRecord> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      if (data && data[STORAGE_KEY]) {
        return { ...DEFAULT_POLICY, ...data[STORAGE_KEY] };
      }
    }
  } catch (err) {
    console.warn('[Nexus Privacy Agent] getPolicy error:', err);
  }
  return { ...DEFAULT_POLICY };
}

/**
 * Update and persist policy in chrome.storage.local.
 */
export async function setPolicy(policy: PolicyRecord): Promise<void> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [STORAGE_KEY]: policy });
    }
  } catch (err) {
    console.warn('[Nexus Privacy Agent] setPolicy error:', err);
  }
}

export default defineUnlistedScript(() => {});
