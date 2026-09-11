import type { UserProfile } from '@/types';

export const USER_PROFILE_STORAGE_KEY = 'nexus_user_profile';

export const DEFAULT_USER_PROFILE: UserProfile = {
  // 1. 👤 Basic Details
  fullName: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  dateOfBirth: '',
  gender: '',

  // 2. 🏠 Address Details
  address: '',
  city: '',
  state: '',
  pincode: '',
  country: '',

  // 3. 💼 Career Details
  jobTitle: '',
  experience: '',
  education: '',
  college: '',
  linkedin: '',
  portfolio: '',

  // 4. ✈️ Travel Preferences
  defaultOrigin: '',
  defaultDestination: '',
  berthPreference: '',
  foodPreference: '',
};

/**
 * Derives first and last name from full name if not explicitly set.
 */
function normalizeProfile(profile: Partial<UserProfile>): UserProfile {
  const merged: UserProfile = { ...DEFAULT_USER_PROFILE, ...profile };
  const trimmedFull = (merged.fullName || '').trim();

  if (trimmedFull && (!merged.firstName || !merged.lastName)) {
    const parts = trimmedFull.split(/\s+/);
    if (!merged.firstName) {
      merged.firstName = parts[0] || '';
    }
    if (!merged.lastName && parts.length > 1) {
      merged.lastName = parts.slice(1).join(' ');
    }
  }

  return merged;
}

/**
 * Validates profile fields for common formats.
 */
export function validateProfile(profile: UserProfile): {
  valid: boolean;
  errors: Partial<Record<keyof UserProfile, string>>;
} {
  const errors: Partial<Record<keyof UserProfile, string>> = {};

  if (profile.email && profile.email.trim().length > 0) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(profile.email.trim())) {
      errors.email = 'Please enter a valid email address';
    }
  }

  if (profile.phone && profile.phone.trim().length > 0) {
    const cleanPhone = profile.phone.replace(/[\s\-\(\)\+\.]/g, '');
    if (cleanPhone.length < 7 || cleanPhone.length > 15 || !/^\d+$/.test(cleanPhone)) {
      errors.phone = 'Please enter a valid phone number (7-15 digits)';
    }
  }

  if (profile.pincode && profile.pincode.trim().length > 0) {
    if (profile.pincode.trim().length < 3 || profile.pincode.trim().length > 10) {
      errors.pincode = 'Pincode should be between 3 and 10 characters';
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

/**
 * Retrieves the user profile securely from chrome.storage.local.
 * Strictly local to the client browser. Never transmitted over the network.
 */
export async function getProfile(): Promise<UserProfile> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      const result = await chrome.storage.local.get([USER_PROFILE_STORAGE_KEY]);
      const stored = result?.[USER_PROFILE_STORAGE_KEY];
      if (stored && typeof stored === 'object') {
        return normalizeProfile(stored);
      }
    } catch (err) {
      console.warn('[Nexus Profile] Failed to read profile from chrome.storage.local:', err);
    }
  }

  // Fallback for non-extension environment or unit tests
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const item = window.localStorage.getItem(USER_PROFILE_STORAGE_KEY);
      if (item) {
        return normalizeProfile(JSON.parse(item));
      }
    } catch {}
  }

  return { ...DEFAULT_USER_PROFILE };
}

/**
 * Saves the user profile securely into chrome.storage.local.
 */
export async function saveProfile(profile: Partial<UserProfile>): Promise<boolean> {
  const normalized = normalizeProfile(profile);

  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      await chrome.storage.local.set({ [USER_PROFILE_STORAGE_KEY]: normalized });
      return true;
    } catch (err) {
      console.error('[Nexus Profile] Failed to save profile to chrome.storage.local:', err);
      return false;
    }
  }

  // Fallback for non-extension environment
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(USER_PROFILE_STORAGE_KEY, JSON.stringify(normalized));
      return true;
    } catch {}
  }

  return false;
}

/**
 * Updates individual fields in the user profile.
 */
export async function updateProfile(partial: Partial<UserProfile>): Promise<UserProfile> {
  const current = await getProfile();
  const updated = normalizeProfile({ ...current, ...partial });
  await saveProfile(updated);
  return updated;
}

/**
 * Clears the stored user profile from chrome.storage.local.
 */
export async function clearProfile(): Promise<boolean> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      await chrome.storage.local.remove([USER_PROFILE_STORAGE_KEY]);
    } catch {}
  }

  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.removeItem(USER_PROFILE_STORAGE_KEY);
    } catch {}
  }

  return true;
}
