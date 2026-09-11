import { useState, useEffect } from 'react';
import type {
  PerceivedContext,
  SafeContext,
  DomNode,
  PolicyRecord,
  PolicyAction,
  PiiClassification,
  PlanResponse,
  PlanAction,
  BlockedActionItem,
  ExecutionReport,
  UserProfile,
  MissingFieldItem,
} from '@/types';
import { needsVisualPerception, perceiveScreenshot } from '../perceive';
import { detectPii } from '../pii-detect';
import { sanitize } from '../sanitize';
import { getPolicy, setPolicy, DEFAULT_POLICY } from '../policy';
import {
  getProfile,
  saveProfile,
  clearProfile,
  validateProfile,
  DEFAULT_USER_PROFILE,
} from '../agent/profile';
import { isAutofillIntent, generateAutofillPlan, detectMissingFormFields } from '../agent/autofill';
import './App.css';

export const LAST_ACTION_STORAGE_KEY = 'nexus_last_executed_action_state';

export interface ExecutedStepSummary {
  stepIndex: number;
  actionType: string;
  description: string;
  value?: string | null;
  targetSelector?: string;
  status: 'SUCCESS' | 'FAILED' | 'BLOCKED';
  message?: string;
}

export interface LastExecutedActionState {
  taskPrompt: string;
  url?: string;
  domain?: string;
  pageTitle?: string;
  plan: PlanResponse | null;
  executionReport: ExecutionReport | null;
  autoRunStep: string;
  completedAt: number;
  success: boolean;
  totalSteps: number;
  executedSteps: number;
  steps: ExecutedStepSummary[];
}

function formatTimeAgo(timestamp: number): string {
  if (!timestamp) return '';
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 15) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const DUMMY_FALLBACK_SCREENSHOT =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * Client-Side Fallback Planner.
 * Decomposes natural language tasks into grounded browser actions when backend server is offline or fast local execution is preferred.
 */
function planClientFallback(
  task: string,
  safeCtx: SafeContext,
  profile?: UserProfile
): PlanResponse {
  const norm = task.toLowerCase().trim();
  const domNodes = safeCtx.sanitizedDom || [];
  const actions: PlanAction[] = [];
  const blockedActions: BlockedActionItem[] = [];

  // Privacy gate check: if user's goal targets sensitive masked PII (Aadhaar, PAN, etc.)
  for (const entry of safeCtx.auditLog) {
    if (entry.action === 'MASK' || entry.action === 'BLOCK') {
      const cat = entry.category.toLowerCase();
      if (
        (cat === 'aadhaar' && (norm.includes('aadhaar') || norm.includes('uidai'))) ||
        (cat === 'pan' && (norm.includes('pan') || norm.includes('tax'))) ||
        (norm.includes(cat) && !norm.includes('do not') && !norm.includes("don't"))
      ) {
        blockedActions.push({
          step: `Target ${entry.category}`,
          reason: `Privacy Gate: Element contains sensitive ${entry.category.toUpperCase()} which has been masked. Access denied.`,
          groundedBbox: {
            x: entry.bbox.x,
            y: entry.bbox.y,
            w: entry.bbox.width,
            h: entry.bbox.height,
          },
          auditEntry: entry,
        });
        return {
          done: true,
          summary: `Privacy Gate intercepted attempt to access masked ${entry.category.toUpperCase()} element.`,
          groundingMode: 'CLIENT_FALLBACK',
          actions: [],
          blockedActions,
          auditTrail: [],
        };
      }
    }
  }

  // 0. Autonomous Form Autofill from saved local vault
  if (isAutofillIntent(task)) {
    return generateAutofillPlan(task, domNodes, profile);
  }

  // Helper to extract bounding box safely
  const getBbox = (node?: DomNode) => ({
    x: node?.boundingBox?.x || 0,
    y: node?.boundingBox?.y || 0,
    w: node?.boundingBox?.width || 80,
    h: node?.boundingBox?.height || 32,
  });

  // 1. Search query: "search for X", "type X into search", "click search"
  if (norm.includes('search') || norm.includes('find') || norm.includes('query')) {
    const searchInput = domNodes.find((n) => {
      const p = (n.attributes?.placeholder || '').toLowerCase();
      const name = (n.attributes?.name || '').toLowerCase();
      const id = (n.attributes?.id || '').toLowerCase();
      const aria = (n.attributes?.['aria-label'] || '').toLowerCase();
      return (
        (n.tag === 'input' || n.tag === 'textarea') &&
        (p.includes('search') || name.includes('search') || id.includes('search') || aria.includes('search') || n.attributes?.type === 'search')
      );
    }) || domNodes.find((n) => n.tag === 'input' && n.attributes?.type !== 'hidden');

    const searchBtn = domNodes.find((n) => {
      const t = (n.text || '').toLowerCase();
      const p = (n.attributes?.placeholder || '').toLowerCase();
      const aria = (n.attributes?.['aria-label'] || '').toLowerCase();
      return (
        (n.tag === 'button' || n.attributes?.type === 'submit') &&
        (t.includes('search') || p.includes('search') || aria.includes('search'))
      );
    });

    const queryMatch = task.match(/(?:search\s+(?:for\s+)?|type\s+)["']?([^"']+)["']?(?:\s+into|\s+in)?/i);
    const query = queryMatch?.[1] && !queryMatch[1].toLowerCase().includes('search') ? queryMatch[1].trim() : 'Privacy Agent';

    if (searchInput && (norm.includes('type') || norm.includes('enter') || norm.includes('for') || !norm.startsWith('click'))) {
      actions.push({
        action: 'click',
        targetSelector: searchInput.attributes?.id ? `#${searchInput.attributes.id}` : searchInput.tag,
        groundedBbox: getBbox(searchInput),
        confidence: 0.9,
        reasoning: 'Focus search input field',
      });
      actions.push({
        action: 'type',
        targetSelector: searchInput.attributes?.id ? `#${searchInput.attributes.id}` : searchInput.tag,
        groundedBbox: getBbox(searchInput),
        value: query,
        confidence: 0.95,
        reasoning: `Type "${query}" into search field`,
      });
    }

    if (searchBtn && (norm.includes('click') || norm.includes('button') || !searchInput)) {
      actions.push({
        action: 'click',
        targetSelector: searchBtn.attributes?.id ? `#${searchBtn.attributes.id}` : searchBtn.tag,
        groundedBbox: getBbox(searchBtn),
        confidence: 0.9,
        reasoning: 'Click search button',
      });
    }
  }

  // 2. Submit action
  else if (norm.includes('submit') || norm.includes('send') || norm.includes('complete')) {
    const submitBtn =
      domNodes.find((n) => {
        const t = (n.text || '').toLowerCase();
        const ty = (n.attributes?.type || '').toLowerCase();
        return (n.tag === 'button' || ty === 'submit') && (t.includes('submit') || t.includes('send') || ty === 'submit');
      }) || domNodes.find((n) => n.tag === 'button');

    if (submitBtn) {
      actions.push({
        action: 'click',
        targetSelector: submitBtn.attributes?.id ? `#${submitBtn.attributes.id}` : submitBtn.tag,
        groundedBbox: getBbox(submitBtn),
        confidence: 0.9,
        reasoning: `Click ${submitBtn.text || 'Submit button'}`,
      });
    }
  }

  // 3. Login / Sign In
  else if (norm.includes('log in') || norm.includes('login') || norm.includes('sign in')) {
    const loginBtn = domNodes.find((n) => {
      const t = (n.text || '').toLowerCase();
      const id = (n.attributes?.id || '').toLowerCase();
      return (n.tag === 'button' || n.tag === 'a') && (t.includes('log in') || t.includes('login') || t.includes('sign in') || id.includes('login'));
    });

    if (loginBtn) {
      actions.push({
        action: 'click',
        targetSelector: loginBtn.attributes?.id ? `#${loginBtn.attributes.id}` : loginBtn.tag,
        groundedBbox: getBbox(loginBtn),
        confidence: 0.9,
        reasoning: `Click ${loginBtn.text || 'Log in'}`,
      });
    }
  }

  // 4. Autofill whole form from saved profile details
  else if (norm.includes('saved detail') || norm.includes('autofill') || (norm.includes('fill') && norm.includes('form'))) {
    const fieldMapping: Array<{ key: keyof UserProfile; keywords: string[] }> = [
      { key: 'fullName', keywords: ['full-name', 'fullname', 'name', 'applicant'] },
      { key: 'email', keywords: ['email', 'mail'] },
      { key: 'phone', keywords: ['phone', 'mobile', 'tel', 'contact'] },
      { key: 'address', keywords: ['address', 'street'] },
      { key: 'city', keywords: ['city', 'town'] },
      { key: 'pincode', keywords: ['pincode', 'pin', 'zip', 'postal'] },
    ];

    for (const mapping of fieldMapping) {
      const val = profile ? String(profile[mapping.key] || '') : '';
      if (!val) continue;

      const targetInput = domNodes.find((n) => {
        if (n.tag !== 'input' && n.tag !== 'textarea') return false;
        const id = (n.attributes?.id || '').toLowerCase();
        const name = (n.attributes?.name || '').toLowerCase();
        const placeholder = (n.attributes?.placeholder || '').toLowerCase();
        return mapping.keywords.some((kw) => id.includes(kw) || name.includes(kw) || placeholder.includes(kw));
      });

      if (targetInput) {
        actions.push({
          action: 'type',
          targetSelector: targetInput.attributes?.id ? `#${targetInput.attributes.id}` : targetInput.tag,
          groundedBbox: getBbox(targetInput),
          value: val,
          confidence: 0.95,
          reasoning: `Autofill ${mapping.key} with "${val}"`,
        });
      }
    }
  }

  // 5. Typing / Filling fields
  else if (norm.includes('type') || norm.includes('fill') || norm.includes('enter')) {
    const typeMatch =
      task.match(/(?:type|enter|input)\s+["']?([^"']+)["']?\s+(?:into|in|to)\s+(?:the\s+)?([^,.]+)/i) ||
      task.match(/fill\s+(?:the\s+)?([^,.]+)\s+with\s+["']?([^"']+)["']?/i);

    let val = '';
    let targetKeyword = '';
    if (typeMatch && typeMatch[1] && typeMatch[2]) {
      if (norm.startsWith('fill')) {
        targetKeyword = typeMatch[1].replace(/["']/g, '').trim().toLowerCase();
        val = typeMatch[2].replace(/^["']|["']$/g, '').trim();
      } else {
        val = typeMatch[1].replace(/^["']|["']$/g, '').trim();
        targetKeyword = typeMatch[2].replace(/["']/g, '').trim().toLowerCase();
      }
    } else {
      for (const k of ['name', 'first', 'last', 'email', 'phone', 'address', 'city', 'pincode']) {
        if (norm.includes(k)) {
          targetKeyword = k;
          if (profile && profile[k as keyof UserProfile]) {
            val = String(profile[k as keyof UserProfile]);
          } else if (k === 'name' && profile?.fullName) {
            val = profile.fullName;
          }
          break;
        }
      }
    }

    const matchedInput =
      domNodes.find((n) => {
        if (n.tag !== 'input' && n.tag !== 'textarea') return false;
        const id = (n.attributes?.id || '').toLowerCase();
        const name = (n.attributes?.name || '').toLowerCase();
        const p = (n.attributes?.placeholder || '').toLowerCase();
        const aria = (n.attributes?.['aria-label'] || '').toLowerCase();
        return (
          id.includes(targetKeyword) ||
          name.includes(targetKeyword) ||
          p.includes(targetKeyword) ||
          aria.includes(targetKeyword)
        );
      }) || domNodes.find((n) => n.tag === 'input' && n.attributes?.type !== 'hidden');

    if (matchedInput) {
      actions.push({
        action: 'click',
        targetSelector: matchedInput.attributes?.id ? `#${matchedInput.attributes.id}` : matchedInput.tag,
        groundedBbox: getBbox(matchedInput),
        confidence: 0.9,
        reasoning: `Click ${targetKeyword || 'input'} field`,
      });
      actions.push({
        action: 'type',
        targetSelector: matchedInput.attributes?.id ? `#${matchedInput.attributes.id}` : matchedInput.tag,
        groundedBbox: getBbox(matchedInput),
        value: val || profile?.fullName || 'User Input',
        confidence: 0.95,
        reasoning: `Type "${val || profile?.fullName || 'User Input'}" into ${targetKeyword || 'input'} field`,
      });
    }
  }

  // 6. Generic Click
  else if (norm.includes('click')) {
    const cleanTarget = norm
      .replace(/^(?:please\s+)?click\s+(?:the\s+)?(?:on\s+)?/, '')
      .replace(/\s+(?:button|link|field|input|box)$/, '')
      .replace(/^["']|["']$/g, '')
      .trim();

    const targetWords = cleanTarget
      .toLowerCase()
      .split(/[\s"']+/)
      .filter((w) => w.length > 2);

    const matchedEl =
      domNodes.find((n) => {
        const t = (n.text || '').toLowerCase();
        const id = (n.attributes?.id || '').toLowerCase();
        const name = (n.attributes?.name || '').toLowerCase();
        const p = (n.attributes?.placeholder || '').toLowerCase();
        const aria = (n.attributes?.['aria-label'] || '').toLowerCase();
        return (
          t.includes(cleanTarget) ||
          id.includes(cleanTarget) ||
          name.includes(cleanTarget) ||
          p.includes(cleanTarget) ||
          aria.includes(cleanTarget) ||
          (targetWords.length > 0 && targetWords.every((w) => t.includes(w) || id.includes(w) || aria.includes(w)))
        );
      }) ||
      domNodes.find((n) => {
        const isInteractive = n.tag === 'button' || n.tag === 'a' || n.tag === 'input' || n.role === 'button';
        if (!isInteractive) return false;
        const t = (n.text || '').toLowerCase();
        const id = (n.attributes?.id || '').toLowerCase();
        return targetWords.some((w) => t.includes(w) || id.includes(w));
      }) ||
      domNodes.find((n) => n.tag === 'button' || n.tag === 'a');

    if (matchedEl) {
      actions.push({
        action: 'click',
        targetSelector: matchedEl.attributes?.id ? `#${matchedEl.attributes.id}` : matchedEl.tag,
        groundedBbox: getBbox(matchedEl),
        confidence: 0.9,
        reasoning: `Click "${matchedEl.text || cleanTarget}"`,
      });
    }
  }

  if (actions.length === 0) {
    const firstInteractive = domNodes.find((n) => n.tag === 'button' || (n.tag === 'input' && n.attributes?.type !== 'hidden') || n.tag === 'a');
    if (firstInteractive) {
      actions.push({
        action: 'click',
        targetSelector: firstInteractive.attributes?.id ? `#${firstInteractive.attributes.id}` : firstInteractive.tag,
        groundedBbox: getBbox(firstInteractive),
        confidence: 0.8,
        reasoning: `Interact with ${firstInteractive.text || firstInteractive.tag}`,
      });
    }
  }

  return {
    done: actions.length > 0,
    summary: actions.length > 0 ? `Plan ready with ${actions.length} action(s) for "${task}"` : `No matching interactive elements found for "${task}"`,
    groundingMode: 'CLIENT_FALLBACK',
    actions,
    blockedActions,
    auditTrail: [],
  };
}

function isEligibleWebpageTab(tab?: chrome.tabs.Tab | null): boolean {
  if (!tab || !tab.id || !tab.url) return false;
  const u = tab.url.toLowerCase();
  return (
    !u.startsWith('chrome://') &&
    !u.startsWith('chrome-extension://') &&
    !u.startsWith('edge://') &&
    !u.startsWith('about:') &&
    !u.startsWith('devtools://')
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'agent' | 'gate' | 'settings'>('agent');
  const [extensionActive, setExtensionActive] = useState<boolean>(true);
  const [proactiveShield, setProactiveShield] = useState<boolean>(true);
  const [loading, setLoading] = useState(false);
  const [visionLoading, setVisionLoading] = useState(false);
  const [sanitizing, setSanitizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [perceivedContext, setPerceivedContext] = useState<PerceivedContext | null>(null);
  const [safeContext, setSafeContext] = useState<SafeContext | null>(null);
  const [policy, setPolicyState] = useState<PolicyRecord>(DEFAULT_POLICY);

  // Server Agent & Execution State
  const [serverStatus, setServerStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  const [serverDetails, setServerDetails] = useState<any>(null);
  const [gpuMode, setGpuMode] = useState<'MOCK' | 'REMOTE_API' | 'LOCAL_MODEL'>('MOCK');
  const [gpuEndpoint, setGpuEndpoint] = useState<string>('http://localhost:8001/v1/chat/completions');
  const [testingGpu, setTestingGpu] = useState<boolean>(false);
  const [gpuTestResult, setGpuTestResult] = useState<{ success: boolean; message: string; latencyMs?: number } | null>(null);

  // Automated Execution State
  const [autoRunning, setAutoRunning] = useState<boolean>(false);
  const [autoRunStep, setAutoRunStep] = useState<string>('');

  const [taskPrompt, setTaskPrompt] = useState<string>('');
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planningError, setPlanningError] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);
  const [executionReport, setExecutionReport] = useState<ExecutionReport | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [capturedTabId, setCapturedTabId] = useState<number | null>(null);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [pageMasksVisible, setPageMasksVisible] = useState(false);
  const [showCustomPrompt, setShowCustomPrompt] = useState<boolean>(true);
  const [expandedImage, setExpandedImage] = useState<{ src: string; title: string; subtitle?: string } | null>(null);

  // Persistent Last Action State (retained across popup closures until extension is toggled off)
  const [lastActionState, setLastActionState] = useState<LastExecutedActionState | null>(null);

  const persistLastActionState = (state: LastExecutedActionState) => {
    setLastActionState(state);
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.set({ [LAST_ACTION_STORAGE_KEY]: state }).catch(() => {});
    } else if (typeof window !== 'undefined' && window.localStorage) {
      try {
        localStorage.setItem(LAST_ACTION_STORAGE_KEY, JSON.stringify(state));
      } catch {}
    }
  };

  const clearLastActionState = () => {
    setLastActionState(null);
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.remove([LAST_ACTION_STORAGE_KEY]).catch(() => {});
    } else if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.removeItem(LAST_ACTION_STORAGE_KEY);
    }
  };

  // User Profile State (Stored strictly locally in chrome.storage.local)
  const [userProfile, setUserProfile] = useState<UserProfile>(DEFAULT_USER_PROFILE);
  const [profileSaving, setProfileSaving] = useState<boolean>(false);
  const [profileSaveSuccess, setProfileSaveSuccess] = useState<boolean>(false);
  const [profileErrors, setProfileErrors] = useState<Partial<Record<keyof UserProfile, string>>>({});

  // Missing Information Modal State (Prompts user when form has fields missing from saved profile)
  const [missingPrompt, setMissingPrompt] = useState<{
    visible: boolean;
    fields: MissingFieldItem[];
    values: Record<string, string>;
    activeTask: string;
  } | null>(null);

  // First-Time User Setup State
  const [showFirstTimeModal, setShowFirstTimeModal] = useState<boolean>(false);
  const [isProfileConfigured, setIsProfileConfigured] = useState<boolean>(true);
  const [highlightProfileSettings, setHighlightProfileSettings] = useState<boolean>(false);

  // Accordion Sections State
  const [expandedSections, setExpandedSections] = useState<{
    basic: boolean;
    address: boolean;
    career: boolean;
  }>({
    basic: true,
    address: false,
    career: false,
  });

  const toggleSection = (section: 'basic' | 'address' | 'career') => {
    setExpandedSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

  const applyPageMasks = async (ctx: SafeContext, tabId?: number | null) => {
    let targetTabId = tabId || capturedTabId;
    if (!targetTabId && typeof chrome !== 'undefined' && chrome.tabs) {
      const [currentActive] = await chrome.tabs.query({ active: true, currentWindow: true });
      targetTabId = currentActive?.id || null;
    }
    if (!targetTabId) return;

    if (ctx.summary.masked > 0) {
      const masks = ctx.auditLog
        .filter((entry) => entry.action === 'MASK' || entry.action === 'BLOCK' || entry.action === 'ASK')
        .map((entry) => ({
          bbox: entry.bbox,
          category: entry.category,
          action: entry.action,
        }));

      try {
        await chrome.tabs.sendMessage(targetTabId, {
          type: 'RENDER_PAGE_MASKS',
          masks,
        });
        setPageMasksVisible(true);
      } catch {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            files: ['content-scripts/content.js'],
          });
          await chrome.tabs.sendMessage(targetTabId, {
            type: 'RENDER_PAGE_MASKS',
            masks,
          });
          setPageMasksVisible(true);
        } catch (e) {
          console.warn('Could not auto-render page masks:', e);
        }
      }
    } else {
      try {
        await chrome.tabs.sendMessage(targetTabId, { type: 'CLEAR_PAGE_MASKS' });
        setPageMasksVisible(false);
      } catch {}
    }
  };

  const togglePageMasks = async () => {
    if (!safeContext) return;
    const nextState = !pageMasksVisible;
    setPageMasksVisible(nextState);

    let targetTabId = capturedTabId;
    if (!targetTabId && typeof chrome !== 'undefined' && chrome.tabs) {
      const [currentActive] = await chrome.tabs.query({ active: true, currentWindow: true });
      targetTabId = currentActive?.id || null;
    }
    if (!targetTabId) return;

    if (nextState) {
      const masks = safeContext.auditLog
        .filter((entry) => entry.action === 'MASK' || entry.action === 'BLOCK' || entry.action === 'ASK')
        .map((entry) => ({
          bbox: entry.bbox,
          category: entry.category,
          action: entry.action,
        }));
      try {
        await chrome.tabs.sendMessage(targetTabId, {
          type: 'RENDER_PAGE_MASKS',
          masks,
        });
      } catch {}
    } else {
      try {
        await chrome.tabs.sendMessage(targetTabId, { type: 'CLEAR_PAGE_MASKS' });
      } catch {}
    }
  };

  const handleToggleExtensionActive = async () => {
    const nextState = !extensionActive;
    setExtensionActive(nextState);
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        await chrome.storage.local.set({ nexus_extension_active: nextState });
        if (!nextState) {
          await chrome.storage.local.remove([LAST_ACTION_STORAGE_KEY]);
          setLastActionState(null);
        }
      } else if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.setItem('nexus_extension_active', String(nextState));
        if (!nextState) {
          localStorage.removeItem(LAST_ACTION_STORAGE_KEY);
          setLastActionState(null);
        }
      }
      if (typeof chrome !== 'undefined' && chrome.runtime) {
        chrome.runtime.sendMessage({ type: 'SET_EXTENSION_ACTIVE', active: nextState }).catch(() => {});
      }
      let targetTabId = capturedTabId;
      if (!targetTabId && typeof chrome !== 'undefined' && chrome.tabs) {
        const [currentActive] = await chrome.tabs.query({ active: true, currentWindow: true });
        targetTabId = currentActive?.id || null;
      }
      if (targetTabId && typeof chrome !== 'undefined' && chrome.tabs) {
        if (!nextState) {
          await chrome.tabs.sendMessage(targetTabId, { type: 'CLEAR_PAGE_MASKS' }).catch(() => {});
          setPageMasksVisible(false);
        } else {
          await chrome.tabs.sendMessage(targetTabId, { type: 'AUTO_SCAN_PRIVACY' }).catch(() => {});
        }
      }
    } catch {}
  };

  const handleToggleProactiveShield = async () => {
    const nextState = !proactiveShield;
    setProactiveShield(nextState);
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        await chrome.storage.local.set({ nexus_proactive_shield: nextState });
      }
    } catch {}
  };

  const handleStopAgentSession = async () => {
    try {
      let targetTabId = capturedTabId;
      if (!targetTabId && typeof chrome !== 'undefined' && chrome.tabs) {
        const [currentActive] = await chrome.tabs.query({ active: true, currentWindow: true });
        targetTabId = currentActive?.id || null;
      }
      if (targetTabId && typeof chrome !== 'undefined' && chrome.tabs) {
        await chrome.tabs.sendMessage(targetTabId, { type: 'CLEAR_PAGE_MASKS' }).catch(() => {});
      }
      if (typeof chrome !== 'undefined' && chrome.runtime) {
        await chrome.runtime.sendMessage({ type: 'STOP_AGENT_SESSION' }).catch(() => {});
      }
    } catch (err) {
      console.warn('[Nexus Privacy Agent] Stop session error:', err);
    }
    setSafeContext(null);
    setPerceivedContext(null);
    setPageMasksVisible(false);
    setPlan(null);
    setExecutionReport(null);
    setAutoRunning(false);
    setAutoRunStep('');
  };

  const handleCaptureContext = async (overrideTabId?: number | null): Promise<SafeContext | null> => {
    setLoading(true);
    setVisionLoading(false);
    setSanitizing(false);
    setError(null);

    try {
      let targetTab: chrome.tabs.Tab | undefined;

      const numericTabId = typeof overrideTabId === 'number' && overrideTabId > 0 ? overrideTabId : undefined;
      if (numericTabId) {
        try {
          const tab = await chrome.tabs.get(numericTabId);
          if (isEligibleWebpageTab(tab)) targetTab = tab;
        } catch {}
      }

      if (!targetTab && capturedTabId) {
        try {
          const tab = await chrome.tabs.get(capturedTabId);
          if (isEligibleWebpageTab(tab)) targetTab = tab;
        } catch {}
      }

      if (!targetTab && typeof chrome !== 'undefined' && chrome.tabs) {
        const [focusedActive] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (isEligibleWebpageTab(focusedActive)) {
          targetTab = focusedActive;
        }
      }

      if (!targetTab && typeof chrome !== 'undefined' && chrome.tabs) {
        const [currentActive] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (isEligibleWebpageTab(currentActive)) {
          targetTab = currentActive;
        }
      }

      if (!targetTab && typeof chrome !== 'undefined' && chrome.tabs) {
        const allTabs = await chrome.tabs.query({});
        targetTab =
          allTabs.find((t) => t.url && t.url.includes('127.0.0.1:8000')) ||
          allTabs.find((t) => t.url && t.url.includes('mock-id-card')) ||
          allTabs.find((t) => t.url && (t.url.includes('8089') || t.url.includes('3456'))) ||
          allTabs.find((t) => t.active && isEligibleWebpageTab(t)) ||
          allTabs.find(isEligibleWebpageTab);
      }

      if (!targetTab || targetTab.id === undefined) {
        throw new Error('Please open or switch to a webpage tab (e.g. google.com or our test page). Chrome blocks extensions on internal chrome:// pages.');
      }

      setCapturedTabId(targetTab.id);
      setActiveTabId(targetTab.id);

      // Request DOM from content script
      let dom: DomNode[] = [];
      try {
        const domResponse = await chrome.tabs.sendMessage(targetTab.id, { type: 'GET_CONTEXT' });
        dom = Array.isArray(domResponse) ? domResponse : domResponse?.dom || [];
      } catch {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: targetTab.id },
            files: ['content-scripts/content.js'],
          });
          const domResponse = await chrome.tabs.sendMessage(targetTab.id, { type: 'GET_CONTEXT' });
          dom = Array.isArray(domResponse) ? domResponse : domResponse?.dom || [];
        } catch {
          // fallback inline
          const [result] = await chrome.scripting.executeScript({
            target: { tabId: targetTab.id },
            func: () => {
              const elements = document.querySelectorAll('input, button, a, select, textarea, [role], label, h1, h2, h3, p');
              const nodes: any[] = [];
              const vW = window.innerWidth || document.documentElement.clientWidth;
              const vH = window.innerHeight || document.documentElement.clientHeight;
              for (const el of elements) {
                const rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) continue;
                if (rect.bottom <= 0 || rect.top >= vH || rect.right <= 0 || rect.left >= vW) continue;
                const rawText = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) ? el.value || '' : el.textContent || '';
                nodes.push({
                  tag: el.tagName.toLowerCase(),
                  text: rawText.trim().replace(/\s+/g, ' '),
                  attributes: {
                    id: el.id || undefined,
                    name: el.getAttribute('name') || undefined,
                    type: el.getAttribute('type') || undefined,
                    placeholder: el.getAttribute('placeholder') || undefined,
                  },
                  boundingBox: {
                    x: Math.round(rect.x),
                    y: Math.round(rect.y),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                  },
                });
              }
              return nodes;
            },
          });
          dom = (result?.result as DomNode[]) || [];
        }
      }

      // Capture screenshot
      let screenshot = '';
      try {
        const scrRes = await Promise.race([
          chrome.runtime.sendMessage({ type: 'CAPTURE_SCREEN', windowId: targetTab.windowId }),
          new Promise((r) => setTimeout(() => r(''), 3000)),
        ]);
        screenshot = typeof scrRes === 'string' ? scrRes : scrRes?.screenshot || '';
      } catch {}

      const requiresVision = needsVisualPerception(dom);
      const perceived: PerceivedContext = {
        url: targetTab.url || '',
        timestamp: Date.now(),
        dom,
        screenshot,
        perceptionSkipped: !requiresVision,
      };

      if (requiresVision && screenshot) {
        setVisionLoading(true);
        try {
          const { visualRegions, metrics } = await perceiveScreenshot(screenshot);
          perceived.visualRegions = visualRegions;
          perceived.perceptionMetrics = metrics;
        } catch (vErr) {
          console.warn('Vision perception fallback:', vErr);
        } finally {
          setVisionLoading(false);
        }
      }

      setPerceivedContext(perceived);

      // PII Detection + Sanitize
      setSanitizing(true);
      const classifications = detectPii(perceived.dom, perceived.visualRegions);
      const currentPolicy = await getPolicy();
      setPolicyState(currentPolicy);

      const safe = await sanitize(perceived, perceived, classifications, currentPolicy);
      setSafeContext(safe);

      await applyPageMasks(safe, targetTab.id);

      // Only set initial prompt suggestion if the user hasn't already typed one!
      setTaskPrompt((prev) => {
        if (prev && prev.trim().length > 0) return prev;
        const targetUrl = targetTab.url || '';
        if (targetUrl.includes('mock-id') || targetUrl.includes('3456')) {
          return 'Click the submit button, but do not interact with the Aadhaar or PAN fields';
        } else if (targetUrl.includes('google') || targetUrl.includes('duckduckgo') || targetUrl.includes('wikipedia')) {
          return 'Type "Privacy Agent" into search';
        }
        return 'Click search';
      });

      return safe;
    } catch (err: any) {
      console.error('Error capturing context:', err);
      setError(err?.message || 'Failed to capture context');
      return null;
    } finally {
      setLoading(false);
      setSanitizing(false);
    }
  };

  const handlePolicyChange = async (category: string, action: PolicyAction) => {
    const updated = { ...policy, [category]: action };
    setPolicyState(updated);
    await setPolicy(updated);

    if (perceivedContext) {
      const classifications = detectPii(perceivedContext.dom, perceivedContext.visualRegions);
      const reSanitized = await sanitize(perceivedContext, perceivedContext, classifications, updated);
      setSafeContext(reSanitized);
      await applyPageMasks(reSanitized);
    }
  };

  const handleResolveAsk = async (field: PiiClassification, chosenAction: 'MASK' | 'ALLOW' | 'BLOCK') => {
    if (!safeContext || !perceivedContext) return;
    const updatedPolicy = { ...policy, [field.category.toLowerCase()]: chosenAction };
    setPolicyState(updatedPolicy);
    await setPolicy(updatedPolicy);

    const classifications = detectPii(perceivedContext.dom, perceivedContext.visualRegions);
    const reSanitized = await sanitize(perceivedContext, perceivedContext, classifications, updatedPolicy);
    setSafeContext(reSanitized);
    await applyPageMasks(reSanitized);
  };

  // Plan Only (Preview)
  const handlePlanAgent = async () => {
    const activeTask = taskPrompt.trim();
    if (!activeTask) {
      setError('Please enter a goal prompt before planning.');
      return;
    }

    setPlanning(true);
    setPlanningError(null);
    setPlan(null);
    setExecutionReport(null);
    setExecutionError(null);

    try {
      let currentSafe = safeContext;
      if (!currentSafe) {
        currentSafe = await handleCaptureContext();
      }
      if (!currentSafe) {
        throw new Error('Please open a webpage tab before planning.');
      }

      let planResponse: PlanResponse | null = null;
      if (isAutofillIntent(activeTask)) {
        const missing = detectMissingFormFields(activeTask, currentSafe.sanitizedDom, userProfile);
        if (missing.length > 0) {
          const initialVals: Record<string, string> = {};
          missing.forEach((m) => {
            initialVals[m.key] = '';
          });
          setMissingPrompt({
            visible: true,
            fields: missing,
            values: initialVals,
            activeTask,
          });
          setPlanningError(`Missing information required on form: ${missing.map((m) => m.label).join(', ')}. Please enter details in popup.`);
          return;
        }
        planResponse = generateAutofillPlan(activeTask, currentSafe.sanitizedDom, userProfile);
      } else {
        try {
          const payload = {
            task: activeTask,
            safeContext: {
              url: currentSafe.url,
              timestamp: currentSafe.timestamp,
              sanitizedDom: currentSafe.sanitizedDom,
              redactedScreenshot: currentSafe.redactedScreenshot || DUMMY_FALLBACK_SCREENSHOT,
              auditLog: currentSafe.auditLog,
            },
          };

          const res = await fetch('http://127.0.0.1:8000/agent/plan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

          if (res.ok) {
            planResponse = await res.json();
          }
        } catch (srvErr) {
          console.warn('Backend planner unavailable, using client-side fallback planner:', srvErr);
        }

        if (!planResponse || (planResponse.actions.length === 0 && planResponse.blockedActions.length === 0)) {
          planResponse = planClientFallback(activeTask, currentSafe, userProfile);
        }
      }

      setPlan(planResponse);
    } catch (err: any) {
      console.error('[Nexus Privacy Agent] Planning error:', err);
      setPlanningError(err?.message || 'Failed to generate plan');
    } finally {
      setPlanning(false);
    }
  };

  // Manual Execute Plan (After Plan Only)
  const handleExecutePlan = async () => {
    if (!plan || plan.actions.length === 0) return;
    setExecuting(true);
    setExecutionError(null);

    try {
      let targetTabId = capturedTabId;
      if (!targetTabId && typeof chrome !== 'undefined' && chrome.tabs) {
        const [currentActive] = await chrome.tabs.query({ active: true, currentWindow: true });
        targetTabId = currentActive?.id || null;
      }
      if (!targetTabId) throw new Error('No target webpage tab found to execute actions.');

      let report: ExecutionReport;
      try {
        report = await chrome.tabs.sendMessage(targetTabId, {
          type: 'EXECUTE_PLAN',
          actions: plan.actions,
          safeContextAuditLog: safeContext?.auditLog || [],
        });
      } catch {
        await chrome.scripting.executeScript({
          target: { tabId: targetTabId },
          files: ['content-scripts/content.js'],
        });
        await new Promise((r) => setTimeout(r, 300));
        report = await chrome.tabs.sendMessage(targetTabId, {
          type: 'EXECUTE_PLAN',
          actions: plan.actions,
          safeContextAuditLog: safeContext?.auditLog || [],
        });
      }

      setExecutionReport(report);
      const steps: ExecutedStepSummary[] = (report.results || []).map((r, idx) => ({
        stepIndex: idx + 1,
        actionType: r.action?.action || 'action',
        description: r.action?.reasoning || `${(r.action?.action || 'Action').toUpperCase()} on ${r.action?.targetSelector || 'element'}`,
        value: r.action?.value,
        targetSelector: r.action?.targetSelector,
        status: r.status,
        message: r.message,
      }));

      persistLastActionState({
        taskPrompt: taskPrompt || 'Manual Plan Execution',
        url: safeContext?.url,
        domain: safeContext?.url ? new URL(safeContext.url).hostname : undefined,
        pageTitle: (safeContext as any)?.title,
        plan,
        executionReport: report,
        autoRunStep: report.success
          ? `Plan Completed: ${report.executedSteps}/${report.totalSteps} steps succeeded! ✅`
          : 'Some steps could not complete',
        completedAt: Date.now(),
        success: report.success,
        totalSteps: report.totalSteps,
        executedSteps: report.executedSteps,
        steps,
      });
    } catch (err: any) {
      console.error('Execution error:', err);
      setExecutionError(err?.message || 'Execution failed in browser tab');
    } finally {
      setExecuting(false);
    }
  };

  /**
   * Autonomous Agent Execution Engine (The Core Work of the Agent).
   * Automatically:
   * 1. Captures DOM, perception, and applies Privacy Gate
   * 2. Plans actions via ZonUI-3B / Server Agent (with instant client fallback)
   * 3. Executes planned actions directly on the active webpage
   * 4. Reports live step-by-step progress
   */
  const handleRunAgentGoal = async (
    overrideTask?: string,
    allowMissingFields?: boolean,
    overrideProfile?: UserProfile
  ) => {
    const activeTask = (overrideTask || taskPrompt || '').trim();
    if (!activeTask) {
      setError('Please type a goal for the agent to execute.');
      return;
    }
    if (overrideTask) {
      setTaskPrompt(overrideTask);
    }

    const effectiveUserProf = overrideProfile || userProfile;

    setAutoRunning(true);
    setError(null);
    setPlanningError(null);
    setExecutionError(null);
    setExecutionReport(null);

    try {
      // Step 1: Establish SafeContext
      setAutoRunStep('1/4 Perceiving Viewport & Enforcing Privacy Gate...');
      let currentSafe = safeContext;
      if (!currentSafe) {
        currentSafe = await handleCaptureContext();
      }

      if (!currentSafe) {
        throw new Error('Please open or switch to a webpage tab (e.g. google.com or test page) before running the agent.');
      }

      await new Promise((r) => setTimeout(r, 300));

      // Step 2: Planning & Grounding
      let generatedPlan: PlanResponse | null = null;

      if (isAutofillIntent(activeTask)) {
        setAutoRunStep('2/4 Checking Profile & Active Form Fields...');
        await new Promise((r) => setTimeout(r, 200));

        // Check for missing fields unless user explicitly skipped
        if (!allowMissingFields) {
          const missing = detectMissingFormFields(activeTask, currentSafe.sanitizedDom, effectiveUserProf);
          if (missing.length > 0) {
            setAutoRunning(false);
            setAutoRunStep(`⚠️ Missing required information (${missing.map((m) => m.label).join(', ')}). Please provide details in popup.`);
            const initialVals: Record<string, string> = {};
            missing.forEach((m) => {
              initialVals[m.key] = '';
            });
            setMissingPrompt({
              visible: true,
              fields: missing,
              values: initialVals,
              activeTask,
            });
            return;
          }
        }

        generatedPlan = generateAutofillPlan(activeTask, currentSafe.sanitizedDom, effectiveUserProf);
      } else {
        setAutoRunStep(`2/4 Planning via ZonUI-3B [${gpuMode}] for "${activeTask.slice(0, 28)}..."`);
        try {
          const planPayload = {
            task: activeTask,
            safeContext: {
              url: currentSafe.url,
              timestamp: currentSafe.timestamp,
              sanitizedDom: currentSafe.sanitizedDom,
              redactedScreenshot: currentSafe.redactedScreenshot || DUMMY_FALLBACK_SCREENSHOT,
              auditLog: currentSafe.auditLog,
            },
          };

          const planRes = await fetch('http://127.0.0.1:8000/agent/plan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(planPayload),
          });

          if (planRes.ok) {
            generatedPlan = await planRes.json();
          }
        } catch (srvErr) {
          console.warn('Server planning failed or offline, using client fallback:', srvErr);
        }

        if (!generatedPlan || (generatedPlan.actions.length === 0 && generatedPlan.blockedActions.length === 0)) {
          generatedPlan = planClientFallback(activeTask, currentSafe, effectiveUserProf);
        }
      }

      setPlan(generatedPlan);

      // Step 3: Autonomous Execution
      if (generatedPlan.actions.length > 0) {
        setAutoRunStep(`3/4 Executing ${generatedPlan.actions.length} action(s) in browser tab...`);
        await new Promise((r) => setTimeout(r, 400));

        let targetTabId = capturedTabId;
        if (!targetTabId && typeof chrome !== 'undefined' && chrome.tabs) {
          const allTabs = await chrome.tabs.query({});
          const webTab = allTabs.find(isEligibleWebpageTab);
          targetTabId = webTab?.id || null;
        }

        if (!targetTabId) {
          throw new Error('No target browser tab found to execute actions.');
        }

        let report: ExecutionReport;
        try {
          report = await chrome.tabs.sendMessage(targetTabId, {
            type: 'EXECUTE_PLAN',
            actions: generatedPlan.actions,
            safeContextAuditLog: currentSafe.auditLog || [],
          });
        } catch {
          await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            files: ['content-scripts/content.js'],
          });
          await new Promise((r) => setTimeout(r, 300));
          report = await chrome.tabs.sendMessage(targetTabId, {
            type: 'EXECUTE_PLAN',
            actions: generatedPlan.actions,
            safeContextAuditLog: currentSafe.auditLog || [],
          });
        }

        setExecutionReport(report);
        const steps: ExecutedStepSummary[] = (report.results || []).map((r, idx) => ({
          stepIndex: idx + 1,
          actionType: r.action?.action || 'action',
          description: r.action?.reasoning || `${(r.action?.action || 'Action').toUpperCase()} on ${r.action?.targetSelector || 'element'}`,
          value: r.action?.value,
          targetSelector: r.action?.targetSelector,
          status: r.status,
          message: r.message,
        }));

        const finalStatus = report.success
          ? `Goal Completed: ${report.executedSteps}/${report.totalSteps} steps succeeded! ✅`
          : `Finished: ${report.results.find((r) => r.status === 'FAILED')?.message || 'Some steps could not complete'}`;
        setAutoRunStep(`4/4 ${finalStatus}`);

        persistLastActionState({
          taskPrompt: activeTask,
          url: currentSafe.url,
          domain: currentSafe.url ? new URL(currentSafe.url).hostname : undefined,
          pageTitle: (currentSafe as any)?.title,
          plan: generatedPlan,
          executionReport: report,
          autoRunStep: finalStatus,
          completedAt: Date.now(),
          success: report.success,
          totalSteps: report.totalSteps,
          executedSteps: report.executedSteps,
          steps,
        });
      } else if (generatedPlan.blockedActions.length > 0) {
        const blockedName = generatedPlan.blockedActions[0]?.auditEntry?.category || 'Masked PII';
        const msg = `Privacy Gate Intercepted: Blocked access to ${blockedName.toUpperCase()}! 🛡️`;
        setAutoRunStep(msg);
        persistLastActionState({
          taskPrompt: activeTask,
          url: currentSafe.url,
          domain: currentSafe.url ? new URL(currentSafe.url).hostname : undefined,
          pageTitle: (currentSafe as any)?.title,
          plan: generatedPlan,
          executionReport: null,
          autoRunStep: msg,
          completedAt: Date.now(),
          success: false,
          totalSteps: generatedPlan.blockedActions.length,
          executedSteps: 0,
          steps: generatedPlan.blockedActions.map((b, idx) => ({
            stepIndex: idx + 1,
            actionType: 'block',
            description: b.step,
            status: 'BLOCKED',
            message: b.reason,
          })),
        });
      } else {
        setAutoRunStep('No matching interactive elements found on this page for this goal.');
      }
    } catch (e: any) {
      console.error('Agent execution error:', e);
      setError(e?.message || 'Agent goal execution failed');
      setAutoRunStep(`⚠️ Flow Interrupted: ${e?.message || e}`);
    } finally {
      setAutoRunning(false);
    }
  };

  // Demo Flow helper
  const handleRunFullDemoFlow = async (overrideTask?: string) => {
    return handleRunAgentGoal(overrideTask);
  };

  // Missing Form Information Modal Handlers
  const handleSaveMissingAndFill = async () => {
    if (!missingPrompt) return;
    const task = missingPrompt.activeTask;
    const newValues = { ...missingPrompt.values };

    const updated: UserProfile = {
      ...userProfile,
      ...newValues,
    };

    const fName = (updated.firstName || '').trim();
    const lName = (updated.lastName || '').trim();
    if (!updated.fullName?.trim() && (fName || lName)) {
      updated.fullName = `${fName} ${lName}`.trim();
    } else if (fName && lName && !updated.fullName.toLowerCase().includes(lName.toLowerCase())) {
      updated.fullName = `${fName} ${lName}`.trim();
    }

    setUserProfile(updated);
    await saveProfile(updated);
    setMissingPrompt(null);

    // Re-run agent goal with the updated profile!
    await handleRunAgentGoal(task, false, updated);
  };

  const handleSkipMissingAndFill = async () => {
    if (!missingPrompt) return;
    const task = missingPrompt.activeTask;
    setMissingPrompt(null);

    // Re-run agent goal skipping missing fields (leaving them blank on the form, never fake!)
    await handleRunAgentGoal(task, true, userProfile);
  };

  // User Profile Handlers (Local Storage Only)
  const handleProfileFieldChange = (field: keyof UserProfile, value: string) => {
    setUserProfile((prev) => {
      const updated = { ...prev, [field]: value };
      if (field === 'fullName') {
        const parts = value.trim().split(/\s+/);
        if (parts.length > 0) {
          updated.firstName = parts[0];
          updated.lastName = parts.slice(1).join(' ');
        }
      }
      return updated;
    });
    if (profileErrors[field]) {
      setProfileErrors((prev) => {
        const copy = { ...prev };
        delete copy[field];
        return copy;
      });
    }
  };

  const handleGoToSettingsForFirstTime = () => {
    setShowFirstTimeModal(false);
    const FIRST_TIME_KEY = 'nexus_first_time_details_prompted';
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.set({ [FIRST_TIME_KEY]: true });
    } else if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.setItem(FIRST_TIME_KEY, 'true');
    }

    setActiveTab('settings');
    setExpandedSections({ basic: true, address: true, career: false });
    setHighlightProfileSettings(true);

    setTimeout(() => {
      const card = document.getElementById('user-profile-settings-card');
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      const nameInput = document.getElementById('profile-fullname-input');
      if (nameInput) {
        nameInput.focus();
      }
    }, 200);
  };

  const handleDismissFirstTimeModal = () => {
    setShowFirstTimeModal(false);
    const FIRST_TIME_KEY = 'nexus_first_time_details_prompted';
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.set({ [FIRST_TIME_KEY]: true });
    } else if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.setItem(FIRST_TIME_KEY, 'true');
    }
  };

  const handleSaveProfile = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setProfileSaving(true);
    setProfileSaveSuccess(false);

    const validation = validateProfile(userProfile);
    if (!validation.valid) {
      setProfileErrors(validation.errors);
      setProfileSaving(false);
      if (validation.errors.fullName || validation.errors.email || validation.errors.phone) {
        setExpandedSections((prev) => ({ ...prev, basic: true }));
      }
      return;
    }

    setProfileErrors({});
    try {
      const success = await saveProfile(userProfile);
      if (success) {
        setProfileSaveSuccess(true);
        const hasConfig = Boolean(userProfile.fullName && userProfile.email);
        setIsProfileConfigured(hasConfig);
        const FIRST_TIME_KEY = 'nexus_first_time_details_prompted';
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
          chrome.storage.local.set({ [FIRST_TIME_KEY]: true });
        } else if (typeof window !== 'undefined' && window.localStorage) {
          localStorage.setItem(FIRST_TIME_KEY, 'true');
        }
        setTimeout(() => {
          setProfileSaveSuccess(false);
          setHighlightProfileSettings(false);
        }, 3500);
      }
    } catch (err) {
      console.error('[Nexus Profile] Failed to save profile:', err);
    } finally {
      setProfileSaving(false);
    }
  };

  const handleClearProfile = async () => {
    if (window.confirm('Are you sure you want to clear your saved profile details from this browser?')) {
      await clearProfile();
      setUserProfile({ ...DEFAULT_USER_PROFILE });
      setIsProfileConfigured(false);
      setProfileErrors({});
      setProfileSaveSuccess(false);
      const FIRST_TIME_KEY = 'nexus_first_time_details_prompted';
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.remove([FIRST_TIME_KEY]);
      } else if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.removeItem(FIRST_TIME_KEY);
      }
    }
  };

  // GPU Settings Handlers
  const handleUpdateGpuMode = async (mode: 'MOCK' | 'REMOTE_API' | 'LOCAL_MODEL', endpoint?: string) => {
    setGpuMode(mode);
    try {
      await fetch('http://127.0.0.1:8000/server/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, endpoint: endpoint || gpuEndpoint }),
      });
    } catch {}
  };

  const handleTestGpu = async () => {
    setTestingGpu(true);
    setGpuTestResult(null);
    try {
      const res = await fetch('http://127.0.0.1:8000/server/test-gpu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: gpuMode, endpoint: gpuEndpoint }),
      });
      const data = await res.json();
      setGpuTestResult(data);
    } catch (e: any) {
      setGpuTestResult({ success: false, message: e?.message || 'Failed to ping GPU endpoint' });
    } finally {
      setTestingGpu(false);
    }
  };

  useEffect(() => {
    // Check Server Health
    const checkServer = async () => {
      try {
        const res = await fetch('http://127.0.0.1:8000/health', { method: 'GET' });
        if (res.ok) {
          const data = await res.json();
          setServerStatus('online');
          setServerDetails(data);
        } else {
          setServerStatus('offline');
        }
      } catch {
        setServerStatus('offline');
      }
    };
    checkServer();
    const interval = setInterval(checkServer, 5000);

    // Load initial settings
    getPolicy().then((p) => setPolicyState(p));
    getProfile().then((prof) => {
      setUserProfile(prof);
      const hasConfig = Boolean(prof.fullName && prof.email);
      setIsProfileConfigured(hasConfig);

      const FIRST_TIME_KEY = 'nexus_first_time_details_prompted';
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.get([FIRST_TIME_KEY], (res) => {
          const alreadyPrompted = Boolean(res?.[FIRST_TIME_KEY]);
          if (!alreadyPrompted && !hasConfig) {
            setShowFirstTimeModal(true);
          }
        });
      } else if (typeof window !== 'undefined' && window.localStorage) {
        const alreadyPrompted = Boolean(localStorage.getItem(FIRST_TIME_KEY));
        if (!alreadyPrompted && !hasConfig) {
          setShowFirstTimeModal(true);
        }
      }
    });

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get(['nexus_extension_active', LAST_ACTION_STORAGE_KEY], (res) => {
        const isActive = res?.nexus_extension_active !== false;
        setExtensionActive(isActive);
        if (isActive && res?.[LAST_ACTION_STORAGE_KEY]) {
          setLastActionState(res[LAST_ACTION_STORAGE_KEY] as LastExecutedActionState);
        } else if (!isActive) {
          chrome.storage.local.remove([LAST_ACTION_STORAGE_KEY]);
          setLastActionState(null);
        }
      });
    } else if (typeof window !== 'undefined' && window.localStorage) {
      const activeStr = localStorage.getItem('nexus_extension_active');
      const isActive = activeStr !== 'false';
      setExtensionActive(isActive);
      if (isActive) {
        const saved = localStorage.getItem(LAST_ACTION_STORAGE_KEY);
        if (saved) {
          try {
            setLastActionState(JSON.parse(saved) as LastExecutedActionState);
          } catch {}
        }
      }
    }

    // Storage listener so popup stays synced if background worker finishes execution
    const storageListener = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName === 'local') {
        if (changes.nexus_extension_active !== undefined) {
          const active = changes.nexus_extension_active.newValue !== false;
          setExtensionActive(active);
          if (!active) {
            setLastActionState(null);
          }
        }
        if (changes[LAST_ACTION_STORAGE_KEY] !== undefined) {
          setLastActionState((changes[LAST_ACTION_STORAGE_KEY].newValue as LastExecutedActionState) || null);
        }
      }
    };
    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener(storageListener);
    }

    if (typeof chrome !== 'undefined' && chrome.tabs) {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([tab]) => {
        if (tab?.id && isEligibleWebpageTab(tab)) {
          setActiveTabId(tab.id);
          setCapturedTabId(tab.id);
        } else {
          chrome.tabs.query({}, (tabs) => {
            const webTab = tabs.find(isEligibleWebpageTab);
            if (webTab?.id) {
              setActiveTabId(webTab.id);
              setCapturedTabId(webTab.id);
            }
          });
        }
      });
    }

    return () => {
      clearInterval(interval);
      if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
        chrome.storage.onChanged.removeListener(storageListener);
      }
    };
  }, []);

  return (
    <div className="agent-container">
      {/* Header */}
      <header className="agent-header">
        <div className="header-top-row">
          <div className="brand-group">
            <div className="app-header-icon" title="Nexus Privacy Agent">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z" />
              </svg>
            </div>
            <div className="header-title-col">
              <h1 className="agent-title">Nexus Privacy Agent</h1>
              <p className="agent-subtitle">Phase 5 · Visual Grounding &amp; Defense-in-Depth</p>
            </div>
          </div>
          <button
            type="button"
            className={`ios-toggle-switch ${extensionActive ? 'on' : 'off'}`}
            onClick={handleToggleExtensionActive}
            title={extensionActive ? 'Click to Pause Nexus Privacy Shield' : 'Click to Enable Nexus Privacy Shield'}
            id="master-power-switch-btn"
          >
            <span className="ios-toggle-knob"></span>
          </button>
        </div>
      </header>

      {!extensionActive && (
        <div className="paused-alert-banner" id="paused-alert-banner">
          <span>⏸️ Privacy Shield is Paused</span>
          <button type="button" onClick={handleToggleExtensionActive}>
            ▶️ Turn ON
          </button>
        </div>
      )}

      {/* Segmented Pill Tabs */}
      <div className="segmented-nav-wrapper">
        <div className="segmented-tabs-bar">
          <button
            className={`segmented-tab ${activeTab === 'agent' ? 'active' : ''}`}
            onClick={() => setActiveTab('agent')}
            id="tab-agent-loop"
          >
            {activeTab === 'agent' && <span className="tab-dot">●</span>}
            <span>Agent Loop</span>
          </button>
          <button
            className={`segmented-tab ${activeTab === 'gate' ? 'active' : ''}`}
            onClick={() => setActiveTab('gate')}
            id="tab-privacy-gate"
          >
            <span className="tab-icon">🛡️</span>
            <span>Privacy Gate</span>
          </button>
          <button
            className={`segmented-tab ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
            id="tab-policy-settings"
          >
            <span className="tab-bullet">·</span>
            <span>Settings</span>
          </button>
        </div>
      </div>

      {/* Connection Status Strip */}
      <div className="connection-strip" id="connection-status-strip">
        <div className="connection-left">
          <span className={`status-indicator-dot ${autoRunning || loading ? 'pulse' : ''}`}>●</span>
          <span>
            {safeContext || serverStatus === 'online'
              ? 'Connected to tab · trust boundary active'
              : 'Ready · Trust boundary active'}
          </span>
        </div>
        <span className="connection-tab-id">
          #{capturedTabId || activeTabId || 1147587080}
        </span>
      </div>

      {error && (
        <div style={{ margin: '8px 16px 0 16px', padding: '8px 12px', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: '6px', fontSize: '11px', color: '#991b1b', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>⚠️ {error}</span>
          <button onClick={() => setError(null)} style={{ background: 'none', border: 'none', color: '#991b1b', cursor: 'pointer', fontWeight: 700 }}>✕</button>
        </div>
      )}

      {/* TAB 1: AGENT LOOP */}
      {activeTab === 'agent' && (
        <div className="agent-loop-content" id="agent-loop-content">
          {!isProfileConfigured && (
            <div className="first-time-setup-banner" id="first-time-setup-banner">
              <div className="first-time-banner-left">
                <span className="first-time-banner-icon">👤</span>
                <div>
                  <div className="first-time-banner-title">First-Time Setup Required</div>
                  <div className="first-time-banner-desc">
                    Fill your details in Settings so the agent can autofill forms accurately for you.
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="first-time-banner-btn"
                onClick={handleGoToSettingsForFirstTime}
                id="btn-goto-settings-banner"
              >
                Go to Settings ⚙️
              </button>
            </div>
          )}

          {/* Section 1: RUN DEMO FLOW */}
          <div className="clean-section run-demo-section" id="run-demo-section">
            <div className="section-header-row">
              <span className="section-eyebrow">RUN DEMO FLOW</span>
              <span className="phase-pill">Phase 1 → 5</span>
            </div>
            <p className="section-desc">
              On-device perception → Privacy Gate → ZonUI-3B grounding (mock) → autonomous browser execution.
            </p>

            <div className="demo-actions-grid">
              <button
                className="btn-demo-legitimate"
                onClick={() =>
                  handleRunAgentGoal(
                    'Click the submit button, but do not interact with the Aadhaar or PAN fields'
                  )
                }
                disabled={autoRunning || loading || planning || executing}
                id="run-legitimate-demo-btn"
                title="Executes form submission while protecting masked PII"
              >
                {autoRunning && autoRunStep.includes('3/4') ? '⏳ Executing...' : '⚡ Legitimate'}
              </button>
              <button
                className="btn-demo-adversarial"
                onClick={() => {
                  const advTask =
                    safeContext?.url && !safeContext.url.includes('mock-id') && !safeContext.url.includes('3456')
                      ? 'Click the first name field'
                      : 'Click the Aadhaar field';
                  handleRunAgentGoal(advTask);
                }}
                disabled={autoRunning || loading || planning || executing}
                id="run-adversarial-demo-btn"
                title="Attempts to target sensitive masked PII to demonstrate Privacy Gate interception"
              >
                🛡️ Adversarial
              </button>
            </div>

            <button
              className="btn-recapture"
              onClick={() => handleCaptureContext()}
              disabled={loading || visionLoading || sanitizing || autoRunning}
              id="capture-context-btn"
            >
              {loading
                ? 'Starting Session & Capturing Context...'
                : visionLoading
                ? 'Perceiving Viewport (TrOCR)...'
                : sanitizing
                ? 'Sanitizing Trust Boundary...'
                : '⟳ Re-capture & sanitize context'}
            </button>

            {autoRunStep && (
              <div className="demo-progress-ticker" id="demo-progress-ticker">
                <span>▶</span> <span>{autoRunStep}</span>
              </div>
            )}
          </div>

          {/* Section 2: PRIVACY GATE SUMMARY */}
          <div className="clean-section privacy-gate-summary-section" id="privacy-gate-summary-section">
            <div className="section-header-row">
              <span className="section-eyebrow">PRIVACY GATE</span>
            </div>
            <div className="gate-summary-row">
              <div className="gate-summary-counts">
                <div className="gate-count-total">
                  <strong>{safeContext ? safeContext.summary.totalDetected : 7}</strong> items detected
                </div>
                <div className="gate-count-breakdown">
                  <span className="count-masked">
                    {safeContext ? safeContext.summary.masked : 4} masked
                  </span>{' '}
                  ·{' '}
                  <span className="count-allowed">
                    {safeContext ? safeContext.summary.allowed : 3} allowed
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="link-view-gate"
                onClick={() => setActiveTab('gate')}
                id="link-to-gate"
              >
                View gate →
              </button>
            </div>
          </div>

          {/* Section 3: TASK & GOAL */}
          <div className="clean-section task-goal-section" id="task-goal-section">
            <div className="section-header-row">
              <span className="section-eyebrow">TASK &amp; GOAL</span>
              <button
                type="button"
                onClick={() => setActiveTab('settings')}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#4f46e5',
                  fontSize: '11px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  padding: 0,
                }}
                title="Manage personal details and autofill profile in Settings"
                id="header-my-details-shortcut-btn"
              >
                👤 {userProfile.fullName ? userProfile.fullName.split(' ')[0] : 'My Details'} →
              </button>
            </div>

            {/* Quick interactive goal steps */}
            <div className="task-step-list">
              <div
                className="task-step-item"
                onClick={() => handleRunAgentGoal('Type into search')}
                title="Click to execute this goal in browser"
              >
                <span className="step-check-icon filled">✔</span>
                <span className="step-text completed">Type into search</span>
              </div>
              <div
                className="task-step-item"
                onClick={() => handleRunAgentGoal('Click search')}
                title="Click to execute this goal in browser"
              >
                <span className="step-check-icon outline-active">○</span>
                <span className="step-text active">Click search</span>
              </div>
              <div
                className="task-step-item"
                onClick={() => handleRunAgentGoal('Click log in')}
                title="Click to execute this goal in browser"
              >
                <span className="step-check-icon outline-muted">○</span>
                <span className="step-text muted">Click log in</span>
              </div>
            </div>

            {/* Direct Custom Goal Input */}
            <div className="custom-prompt-container">
              <div className="custom-prompt-box">
                <textarea
                  className="custom-prompt-input"
                  value={taskPrompt}
                  onChange={(e) => setTaskPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleRunAgentGoal();
                    }
                  }}
                  placeholder="Type any goal in natural language (e.g. click search, fill name, submit form)..."
                  id="task-prompt-input"
                  rows={2}
                />
                <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                  <button
                    type="button"
                    className="btn-demo-legitimate"
                    style={{ flex: 1, height: '32px', fontSize: '11.5px', margin: 0 }}
                    onClick={() => handleRunAgentGoal()}
                    disabled={autoRunning || loading || planning || executing || !taskPrompt.trim()}
                    id="run-custom-goal-btn"
                    title="Runs full autonomous agent loop: Perceive → Plan → Execute"
                  >
                    {autoRunning ? '⏳ Executing Goal...' : '⚡ Run Goal'}
                  </button>
                  <button
                    type="button"
                    className="custom-prompt-btn"
                    style={{ height: '32px', fontSize: '11px', background: '#f1f5f9', color: '#334155', border: '1px solid #cbd5e1' }}
                    onClick={handlePlanAgent}
                    disabled={planning || !taskPrompt.trim()}
                    id="plan-agent-btn"
                    title="Plan actions with ZonUI-3B without executing immediately"
                  >
                    {planning ? 'Planning...' : '📋 Plan Only'}
                  </button>
                </div>
              </div>
            </div>

            {/* Plan Feedback Card */}
            {plan && (
              <div style={{ marginTop: '10px', padding: '8px', background: '#f8fafc', borderRadius: '6px', border: '1px solid #e2e8f0', fontSize: '11.5px' }}>
                <div style={{ fontWeight: 700, color: '#0f172a', marginBottom: '4px' }}>
                  Plan ({plan.actions.length} approved, {plan.blockedActions.length} blocked)
                </div>
                <div style={{ color: '#64748b', fontSize: '11px', marginBottom: '6px' }}>{plan.summary}</div>
                {plan.actions.length > 0 && (
                  <button
                    className="btn-demo-legitimate"
                    style={{ width: '100%', height: '30px', fontSize: '11.5px' }}
                    onClick={handleExecutePlan}
                    disabled={executing}
                  >
                    {executing ? 'Executing...' : 'Approve & Execute Plan'}
                  </button>
                )}
              </div>
            )}

            {/* Persistent Last Action Performed Card (retained until extension is turned off) */}
            {lastActionState && extensionActive ? (
              <div
                className={`last-action-performed-card ${lastActionState.success ? '' : 'warning'}`}
                id="last-action-performed-card"
              >
                <div className="action-performed-header">
                  <div className="action-header-left">
                    <span className="action-badge-pulse">{lastActionState.success ? '⚡' : '⚠️'}</span>
                    <span className="action-header-title">Last Action Performed</span>
                  </div>
                  <div className="action-header-right">
                    <span className={`action-status-pill ${lastActionState.success ? 'success' : 'warning'}`}>
                      {lastActionState.success ? 'COMPLETED' : 'ATTENTION'}
                    </span>
                    <button
                      type="button"
                      className="btn-action-dismiss"
                      onClick={clearLastActionState}
                      title="Clear action history"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                <div className="action-goal-banner">
                  <span className="action-goal-label">Goal:</span>
                  <span className="action-goal-text">{lastActionState.taskPrompt}</span>
                </div>

                <div className="action-meta-row">
                  {lastActionState.domain && (
                    <span className="action-meta-domain">🌐 {lastActionState.domain}</span>
                  )}
                  <span>⏱️ {formatTimeAgo(lastActionState.completedAt)}</span>
                </div>

                {lastActionState.steps && lastActionState.steps.length > 0 && (
                  <div className="action-steps-timeline">
                    <div className="action-steps-header">
                      EXECUTED STEPS ({lastActionState.executedSteps}/{lastActionState.totalSteps}):
                    </div>
                    <div className="action-steps-list">
                      {lastActionState.steps.map((st) => (
                        <div
                          key={st.stepIndex}
                          className={`action-step-item ${st.status === 'SUCCESS' ? 'success' : 'failed'}`}
                        >
                          <span className="step-num">#{st.stepIndex}</span>
                          <span className="step-icon">
                            {st.actionType === 'type'
                              ? '⌨️'
                              : st.actionType === 'click'
                              ? '🖱️'
                              : st.actionType === 'select'
                              ? '📋'
                              : st.actionType === 'block'
                              ? '🛡️'
                              : '✓'}
                          </span>
                          <div className="step-details">
                            <span className="step-desc" title={st.description}>
                              {st.description}
                            </span>
                            {st.value && (
                              <span className="step-val-tag" title={st.value}>
                                "{st.value}"
                              </span>
                            )}
                          </div>
                          <span
                            className={`step-status-tag ${
                              st.status === 'SUCCESS' ? 'success' : 'failed'
                            }`}
                          >
                            {st.status === 'SUCCESS' ? 'DONE' : 'FAILED'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="action-footer-status">
                  <span className="action-status-summary">
                    {lastActionState.autoRunStep ||
                      (lastActionState.success
                        ? '✅ Goal finished successfully'
                        : '⚠️ Action finished with issues')}
                  </span>
                  <span className="action-persistence-note">
                    📌 Retained across popup tabs until Privacy Shield is turned OFF
                  </span>
                </div>
              </div>
            ) : (
              executionReport && (
                <div style={{ marginTop: '8px', padding: '6px 8px', background: '#ecfdf5', borderRadius: '6px', fontSize: '11px', color: '#065f46', fontWeight: 600 }}>
                  ✅ Execution Succeeded: {executionReport.executedSteps}/{executionReport.totalSteps} steps completed
                </div>
              )
            )}
          </div>

          {/* Section 4: STOP AGENT FOOTER */}
          <div className="clean-footer">
            <button
              type="button"
              className="btn-stop-agent"
              onClick={handleStopAgentSession}
              id="stop-agent-btn"
            >
              ■ Stop agent
            </button>
          </div>
        </div>
      )}

      {/* TAB 2: PRIVACY GATE */}
      {activeTab === 'gate' && (
        <div className="privacy-gate-tab-content">
          <div className="subtab-header-row">
            <span className="subtab-title">🛡️ Privacy Gate Decisions</span>
            <button
              type="button"
              className="back-to-loop-btn"
              onClick={() => setActiveTab('agent')}
            >
              ← Back to Agent Loop
            </button>
          </div>

          {/* Metrics Grid */}
          <div className="gate-metrics-grid">
            <div className="gate-metric total">
              <span className="metric-num">{safeContext ? safeContext.summary.totalDetected : 7}</span>
              <span className="metric-label">Total</span>
            </div>
            <div className="gate-metric masked">
              <span className="metric-num">{safeContext ? safeContext.summary.masked : 4}</span>
              <span className="metric-label">Masked</span>
            </div>
            <div className="gate-metric blocked">
              <span className="metric-num">{safeContext ? safeContext.summary.blocked : 0}</span>
              <span className="metric-label">Blocked</span>
            </div>
            <div className="gate-metric allowed">
              <span className="metric-num">{safeContext ? safeContext.summary.allowed : 3}</span>
              <span className="metric-label">Allowed</span>
            </div>
          </div>

          {/* Screenshot Comparison */}
          <div className="side-by-side-section">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <span style={{ fontSize: '11px', fontWeight: 700, color: '#475569' }}>SCREENSHOT PROOF</span>
              {safeContext && safeContext.summary.masked > 0 && (
                <button
                  onClick={togglePageMasks}
                  style={{
                    background: pageMasksVisible ? '#fee2e2' : '#f1f5f9',
                    border: '1px solid #cbd5e1',
                    borderRadius: '4px',
                    padding: '2px 6px',
                    fontSize: '10.5px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {pageMasksVisible ? '🙈 Hide On-Screen Masks' : '👁️ Show On-Screen Masks'}
                </button>
              )}
            </div>

            <div className="side-by-side-grid">
              <div
                className="screenshot-box original"
                style={{ cursor: safeContext?.rawScreenshot ? 'zoom-in' : 'default' }}
                onClick={() => {
                  if (safeContext?.rawScreenshot) {
                    setExpandedImage({
                      src: safeContext.rawScreenshot,
                      title: 'Pre-Sanitize Original (Raw Viewport)',
                      subtitle: 'Full screen seen before redaction',
                    });
                  }
                }}
              >
                <div className="box-label">
                  <span>Pre-Sanitize</span>
                  <span style={{ color: '#64748b' }}>RAW</span>
                </div>
                {safeContext?.rawScreenshot ? (
                  <img src={safeContext.rawScreenshot} alt="Original" className="comparison-img" />
                ) : (
                  <div className="no-img">Raw Viewport Preview</div>
                )}
              </div>

              <div
                className="screenshot-box sanitized"
                style={{ cursor: safeContext?.redactedScreenshot ? 'zoom-in' : 'default' }}
                onClick={() => {
                  if (safeContext?.redactedScreenshot) {
                    setExpandedImage({
                      src: safeContext.redactedScreenshot,
                      title: 'Sanitized Outbound (Zero-Leak Redacted)',
                      subtitle: 'All sensitive PII blacked out',
                    });
                  }
                }}
              >
                <div className="box-label">
                  <span>Sanitized Outbound</span>
                  <span style={{ color: '#dc2626' }}>BLACKOUT</span>
                </div>
                {safeContext?.redactedScreenshot ? (
                  <img src={safeContext.redactedScreenshot} alt="Sanitized" className="comparison-img" />
                ) : (
                  <div className="no-img">Sanitized Preview</div>
                )}
              </div>
            </div>
          </div>

          {/* Pending ASK prompts */}
          {safeContext && safeContext.pendingAskFields.length > 0 && (
            <div style={{ padding: '0 16px 12px 16px' }}>
              <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '6px', padding: '8px', fontSize: '11px' }}>
                <strong style={{ color: '#92400e' }}>User Approval Needed:</strong>
                {safeContext.pendingAskFields.map((field, idx) => (
                  <div key={idx} style={{ marginTop: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>{field.category.toUpperCase()}</span>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <button style={{ fontSize: '10px', padding: '2px 6px' }} onClick={() => handleResolveAsk(field, 'MASK')}>Mask</button>
                      <button style={{ fontSize: '10px', padding: '2px 6px' }} onClick={() => handleResolveAsk(field, 'ALLOW')}>Allow</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Audit Log Table */}
          <div className="audit-log-section">
            <span style={{ fontSize: '11px', fontWeight: 700, color: '#475569' }}>
              PII AUDIT LEDGER ({safeContext ? safeContext.auditLog.length : 4})
            </span>
            <div className="audit-table-wrapper">
              <table className="audit-table">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th>Action</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {safeContext && safeContext.auditLog.length > 0 ? (
                    safeContext.auditLog.map((entry, idx) => (
                      <tr key={idx}>
                        <td><strong>{entry.category.toUpperCase()}</strong></td>
                        <td>
                          <span className={`badge-action-${entry.action.toLowerCase()}`}>
                            {entry.action}
                          </span>
                        </td>
                        <td>{entry.source.toUpperCase()}</td>
                      </tr>
                    ))
                  ) : (
                    <>
                      <tr>
                        <td><strong>AADHAAR</strong></td>
                        <td><span className="badge-action-mask">MASK</span></td>
                        <td>DOM</td>
                      </tr>
                      <tr>
                        <td><strong>PAN</strong></td>
                        <td><span className="badge-action-mask">MASK</span></td>
                        <td>DOM</td>
                      </tr>
                      <tr>
                        <td><strong>NAME</strong></td>
                        <td><span className="badge-action-allow">ALLOW</span></td>
                        <td>DOM</td>
                      </tr>
                    </>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: SETTINGS */}
      {activeTab === 'settings' && (
        <div className="settings-tab-content">
          <div className="subtab-header-row" style={{ padding: '0 0 10px 0' }}>
            <span className="subtab-title">⚙️ Policy &amp; Engine Settings</span>
            <button
              type="button"
              className="back-to-loop-btn"
              onClick={() => setActiveTab('agent')}
            >
              ← Back to Agent Loop
            </button>
          </div>

          {/* Extension Shields Card */}
          <div className="settings-group-card">
            <span className="settings-group-title">🛡️ Shield Controls</span>
            <div className="settings-toggle-row">
              <div>
                <div style={{ fontSize: '11.5px', fontWeight: 600, color: '#0f172a' }}>Master Extension Shield</div>
                <div style={{ fontSize: '10.5px', color: '#64748b' }}>Active protection across tabs</div>
              </div>
              <button
                type="button"
                className={`ios-toggle-switch ${extensionActive ? 'on' : 'off'}`}
                onClick={handleToggleExtensionActive}
              >
                <span className="ios-toggle-knob"></span>
              </button>
            </div>
            <div className="settings-toggle-row">
              <div>
                <div style={{ fontSize: '11.5px', fontWeight: 600, color: '#0f172a' }}>Proactive Page Scanner</div>
                <div style={{ fontSize: '10.5px', color: '#64748b' }}>Shield PII automatically on load</div>
              </div>
              <button
                type="button"
                className={`ios-toggle-switch ${proactiveShield ? 'on' : 'off'}`}
                onClick={handleToggleProactiveShield}
              >
                <span className="ios-toggle-knob"></span>
              </button>
            </div>
          </div>

          {/* User Vault / Personal Details Card */}
          <div
            className={`settings-group-card ${highlightProfileSettings ? 'highlight-profile-glow' : ''}`}
            id="user-profile-settings-card"
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
              <span className="settings-group-title" style={{ margin: 0 }}>👤 Personal Details (Local Vault)</span>
              <span style={{ fontSize: '10px', color: '#16a34a', background: '#dcfce7', padding: '2px 6px', borderRadius: '4px', fontWeight: 600 }}>
                🔒 100% Local Only
              </span>
            </div>

            {highlightProfileSettings && !isProfileConfigured && (
              <div className="profile-first-time-highlight-notice">
                ✨ <strong>First-Time Setup:</strong> Please enter your details below and click <strong>Save Details to Local Vault</strong> so the agent can autofill forms for you.
              </div>
            )}

            <p className="settings-group-desc">
              Your details are stored strictly in <code>chrome.storage.local</code> for autofill. They are <strong>never</strong> transmitted to any remote AI server.
            </p>

            {profileSaveSuccess && (
              <div style={{ background: '#ecfdf5', border: '1px solid #86efac', color: '#166534', padding: '8px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 600, marginBottom: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>✅ Details saved securely to your local browser vault!</span>
                <button
                  type="button"
                  onClick={() => setActiveTab('agent')}
                  style={{ background: '#16a34a', color: '#ffffff', border: 'none', borderRadius: '4px', padding: '3px 8px', fontSize: '10px', fontWeight: 700, cursor: 'pointer' }}
                >
                  Agent Loop →
                </button>
              </div>
            )}

            {/* Accordion 1: Basic Info */}
            <div className="profile-section-card">
              <button
                type="button"
                className="profile-section-toggle"
                onClick={() => toggleSection('basic')}
              >
                <div className="section-title-group">
                  <span className="section-icon">👤</span>
                  <span className="section-title">Basic Info</span>
                  {userProfile.fullName && userProfile.email ? (
                    <span className="section-filled-badge">Filled</span>
                  ) : (
                    <span className="section-required-badge">Required</span>
                  )}
                </div>
                <span className="section-arrow">{expandedSections.basic ? '▲' : '▼'}</span>
              </button>
              {expandedSections.basic && (
                <div className="profile-section-body">
                  <div className="profile-grid">
                    <div className="profile-field full-width">
                      <label className="profile-label">Full Name <span className="required-star">*</span></label>
                      <input
                        type="text"
                        className={`profile-input ${profileErrors.fullName ? 'has-error' : ''}`}
                        value={userProfile.fullName || ''}
                        onChange={(e) => handleProfileFieldChange('fullName', e.target.value)}
                        placeholder="e.g. Rahul Sharma"
                        id="profile-fullname-input"
                      />
                      {profileErrors.fullName && <span className="field-error-msg">{profileErrors.fullName}</span>}
                    </div>

                    <div className="profile-field full-width">
                      <label className="profile-label">Email Address <span className="required-star">*</span></label>
                      <input
                        type="email"
                        className={`profile-input ${profileErrors.email ? 'has-error' : ''}`}
                        value={userProfile.email || ''}
                        onChange={(e) => handleProfileFieldChange('email', e.target.value)}
                        placeholder="e.g. rahul.sharma@example.com"
                        id="profile-email-input"
                      />
                      {profileErrors.email && <span className="field-error-msg">{profileErrors.email}</span>}
                    </div>

                    <div className="profile-field">
                      <label className="profile-label">Phone Number</label>
                      <input
                        type="tel"
                        className={`profile-input ${profileErrors.phone ? 'has-error' : ''}`}
                        value={userProfile.phone || ''}
                        onChange={(e) => handleProfileFieldChange('phone', e.target.value)}
                        placeholder="9876543210"
                        id="profile-phone-input"
                      />
                      {profileErrors.phone && <span className="field-error-msg">{profileErrors.phone}</span>}
                    </div>

                    <div className="profile-field">
                      <label className="profile-label">Gender</label>
                      <select
                        className="profile-input"
                        value={userProfile.gender || 'Female'}
                        onChange={(e) => handleProfileFieldChange('gender', e.target.value)}
                        id="profile-gender-select"
                      >
                        <option value="Female">Female</option>
                        <option value="Male">Male</option>
                        <option value="Other">Other</option>
                      </select>
                    </div>

                    <div className="profile-field">
                      <label className="profile-label">Date of Birth</label>
                      <input
                        type="date"
                        className="profile-input"
                        value={userProfile.dateOfBirth || ''}
                        onChange={(e) => handleProfileFieldChange('dateOfBirth', e.target.value)}
                        id="profile-dob-input"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Accordion 2: Address & Location */}
            <div className="profile-section-card">
              <button
                type="button"
                className="profile-section-toggle"
                onClick={() => toggleSection('address')}
              >
                <div className="section-title-group">
                  <span className="section-icon">🏠</span>
                  <span className="section-title">Address &amp; Location</span>
                  {userProfile.city || userProfile.address || userProfile.state ? <span className="section-filled-badge">Filled</span> : null}
                </div>
                <span className="section-arrow">{expandedSections.address ? '▲' : '▼'}</span>
              </button>
              {expandedSections.address && (
                <div className="profile-section-body">
                  <div className="profile-grid">
                    <div className="profile-field full-width">
                      <label className="profile-label">Street Address</label>
                      <input
                        type="text"
                        className="profile-input"
                        value={userProfile.address || ''}
                        onChange={(e) => handleProfileFieldChange('address', e.target.value)}
                        placeholder="Flat / House No., Landmark"
                        id="profile-address-input"
                      />
                    </div>
                    <div className="profile-field">
                      <label className="profile-label">State / Region</label>
                      <input
                        type="text"
                        className="profile-input"
                        value={userProfile.state || ''}
                        onChange={(e) => handleProfileFieldChange('state', e.target.value)}
                        placeholder="NCR / Karnataka"
                        id="profile-state-input"
                      />
                    </div>
                    <div className="profile-field">
                      <label className="profile-label">City</label>
                      <input
                        type="text"
                        className="profile-input"
                        value={userProfile.city || ''}
                        onChange={(e) => handleProfileFieldChange('city', e.target.value)}
                        placeholder="Delhi / Bengaluru"
                        id="profile-city-input"
                      />
                    </div>
                    <div className="profile-field">
                      <label className="profile-label">Pincode</label>
                      <input
                        type="text"
                        className="profile-input"
                        value={userProfile.pincode || ''}
                        onChange={(e) => handleProfileFieldChange('pincode', e.target.value)}
                        placeholder="110001"
                        id="profile-pincode-input"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Accordion 3: Career Details */}
            <div className="profile-section-card">
              <button
                type="button"
                className="profile-section-toggle"
                onClick={() => toggleSection('career')}
              >
                <div className="section-title-group">
                  <span className="section-icon">💼</span>
                  <span className="section-title">Career / Professional</span>
                  {userProfile.jobTitle || userProfile.linkedin ? <span className="section-filled-badge">Filled</span> : null}
                </div>
                <span className="section-arrow">{expandedSections.career ? '▲' : '▼'}</span>
              </button>
              {expandedSections.career && (
                <div className="profile-section-body">
                  <div className="profile-grid">
                    <div className="profile-field">
                      <label className="profile-label">Job Title</label>
                      <input
                        type="text"
                        className="profile-input"
                        value={userProfile.jobTitle || ''}
                        onChange={(e) => handleProfileFieldChange('jobTitle', e.target.value)}
                        placeholder="Software Engineer"
                        id="profile-jobtitle-input"
                      />
                    </div>
                    <div className="profile-field">
                      <label className="profile-label">Experience</label>
                      <input
                        type="text"
                        className="profile-input"
                        value={userProfile.experience || ''}
                        onChange={(e) => handleProfileFieldChange('experience', e.target.value)}
                        placeholder="4 years"
                        id="profile-experience-input"
                      />
                    </div>
                    <div className="profile-field full-width">
                      <label className="profile-label">LinkedIn URL</label>
                      <input
                        type="url"
                        className="profile-input"
                        value={userProfile.linkedin || ''}
                        onChange={(e) => handleProfileFieldChange('linkedin', e.target.value)}
                        placeholder="https://linkedin.com/in/username"
                        id="profile-linkedin-input"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Profile Action Buttons */}
            <div className="profile-actions">
              <button
                type="button"
                className="profile-clear-btn"
                onClick={handleClearProfile}
                id="clear-profile-btn"
              >
                Clear Data
              </button>
              <button
                type="button"
                className="profile-save-btn"
                onClick={() => handleSaveProfile()}
                disabled={profileSaving}
                id="save-profile-btn"
              >
                {profileSaving ? 'Saving...' : '💾 Save Details'}
              </button>
            </div>
          </div>

          {/* ZonUI-3B Grounding Engine Card */}
          <div className="settings-group-card">
            <span className="settings-group-title">⚡ ZonUI-3B Grounding Engine</span>
            <p className="settings-group-desc">Select visual grounding compute provider</p>
            <div className="gpu-mode-selector">
              <button
                className={`gpu-mode-btn ${gpuMode === 'MOCK' ? 'active' : ''}`}
                onClick={() => handleUpdateGpuMode('MOCK')}
              >
                Mock (5ms)
              </button>
              <button
                className={`gpu-mode-btn ${gpuMode === 'REMOTE_API' ? 'active' : ''}`}
                onClick={() => handleUpdateGpuMode('REMOTE_API')}
              >
                Colab / Remote
              </button>
              <button
                className={`gpu-mode-btn ${gpuMode === 'LOCAL_MODEL' ? 'active' : ''}`}
                onClick={() => handleUpdateGpuMode('LOCAL_MODEL')}
              >
                Local PyTorch
              </button>
            </div>
            <button
              type="button"
              className="gpu-test-btn"
              style={{ width: '100%', marginTop: '6px' }}
              onClick={handleTestGpu}
              disabled={testingGpu}
            >
              {testingGpu ? 'Testing...' : '🔌 Test GPU Connection & Ping'}
            </button>
            {gpuTestResult && (
              <div style={{ marginTop: '6px', fontSize: '11px', color: gpuTestResult.success ? '#15803d' : '#b91c1c' }}>
                {gpuTestResult.success ? '✅' : '❌'} {gpuTestResult.message}
              </div>
            )}
          </div>

          {/* Policy Table Card */}
          <div className="settings-group-card">
            <span className="settings-group-title">🛡️ Policy Engine Rules</span>
            <div className="policy-table-container">
              <table className="policy-table">
                <tbody>
                  {[
                    { key: 'aadhaar', label: 'Aadhaar Card' },
                    { key: 'pan', label: 'PAN Card' },
                    { key: 'name', label: 'Person Name' },
                    { key: 'phone', label: 'Phone Number' },
                    { key: 'email', label: 'Email Address' },
                    { key: 'amount', label: 'Financial Amount' },
                  ].map((item) => (
                    <tr key={item.key}>
                      <td><strong>{item.label}</strong></td>
                      <td style={{ textAlign: 'right' }}>
                        <select
                          className="policy-select"
                          value={policy[item.key] || 'MASK'}
                          onChange={(e) => handlePolicyChange(item.key, e.target.value as PolicyAction)}
                        >
                          <option value="MASK">MASK</option>
                          <option value="BLOCK">BLOCK</option>
                          <option value="ALLOW">ALLOW</option>
                          <option value="ASK">ASK</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Missing Information Prompt Modal */}
      {missingPrompt && missingPrompt.visible && (
        <div className="missing-fields-modal-overlay">
          <div className="missing-fields-modal-card">
            <div className="missing-fields-header">
              <div className="missing-fields-icon-box">📝</div>
              <div>
                <h4 className="missing-fields-title">Missing Information Needed</h4>
                <p className="missing-fields-subtitle">
                  The active form requires details that are not in your saved profile. Please enter them so the agent can fill the form accurately:
                </p>
              </div>
            </div>

            <div className="missing-fields-body">
              {missingPrompt.fields.map((field) => (
                <div key={field.key} className="missing-field-row">
                  <div className="missing-field-label-wrap">
                    <span className="missing-field-name">{field.label}</span>
                    <span className="missing-field-badge">{field.reason}</span>
                  </div>
                  {field.type === 'select' && field.options ? (
                    <select
                      className="missing-field-select"
                      value={missingPrompt.values[field.key] || ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        setMissingPrompt((prev) =>
                          prev
                            ? {
                                ...prev,
                                values: { ...prev.values, [field.key]: val },
                              }
                            : null
                        );
                      }}
                    >
                      <option value="">-- Select {field.label} --</option>
                      {field.options.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={field.type || 'text'}
                      className="missing-field-input"
                      placeholder={field.placeholder}
                      value={missingPrompt.values[field.key] || ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        setMissingPrompt((prev) =>
                          prev
                            ? {
                                ...prev,
                                values: { ...prev.values, [field.key]: val },
                              }
                            : null
                        );
                      }}
                      autoFocus={field === missingPrompt.fields[0]}
                    />
                  )}
                </div>
              ))}
            </div>

            <div className="missing-fields-footer">
              <button
                type="button"
                className="btn-missing-save"
                onClick={handleSaveMissingAndFill}
              >
                💾 Save to Profile &amp; Fill Form
              </button>
              <button
                type="button"
                className="btn-missing-skip"
                onClick={handleSkipMissingAndFill}
              >
                ⏩ Skip Missing &amp; Fill Remaining
              </button>
              <button
                type="button"
                className="btn-missing-cancel"
                onClick={() => setMissingPrompt(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* First-Time User Onboarding Modal */}
      {showFirstTimeModal && (
        <div className="missing-fields-modal-overlay" id="first-time-modal-overlay">
          <div className="missing-fields-modal-card">
            <div className="missing-fields-header">
              <div className="missing-fields-icon-box" style={{ background: '#eff6ff', borderColor: '#93c5fd', color: '#2563eb' }}>
                👋
              </div>
              <div>
                <h3 className="missing-fields-title">Welcome to Nexus Privacy Agent</h3>
                <p className="missing-fields-subtitle">First-time profile setup required for form filling</p>
              </div>
            </div>

            <div className="first-time-modal-body">
              <div className="first-time-intro-text">
                To let your agent automatically fill web forms, job applications, and portals without using fake or dummy data, <strong>please fill in your details in Settings</strong>.
              </div>

              <div className="first-time-features-list">
                <div className="first-time-feature-item">
                  <span className="first-time-feature-icon">🔒</span>
                  <div>
                    <div className="first-time-feature-title">100% Local Privacy Vault</div>
                    <div className="first-time-feature-desc">Stored strictly on your device. Never sent to any AI server or third party.</div>
                  </div>
                </div>

                <div className="first-time-feature-item">
                  <span className="first-time-feature-icon">⚡</span>
                  <div>
                    <div className="first-time-feature-title">Human-Like Autofill</div>
                    <div className="first-time-feature-desc">Fills your real name, email, phone, and address into web forms seamlessly.</div>
                  </div>
                </div>

                <div className="first-time-feature-item">
                  <span className="first-time-feature-icon">🛡️</span>
                  <div>
                    <div className="first-time-feature-title">Complete User Control</div>
                    <div className="first-time-feature-desc">You can review, update, or clear your saved details anytime in the Settings tab.</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="missing-fields-footer">
              <button
                type="button"
                className="btn-missing-save btn-first-time-primary"
                onClick={handleGoToSettingsForFirstTime}
                id="btn-first-time-goto-settings"
              >
                ⚙️ Fill Details in Settings →
              </button>
              <button
                type="button"
                className="btn-missing-skip"
                onClick={handleDismissFirstTimeModal}
                id="btn-first-time-skip"
              >
                Remind Me Later
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lightbox Modal */}
      {expandedImage && (
        <div className="screenshot-lightbox-overlay" onClick={() => setExpandedImage(null)}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <span style={{ color: '#ffffff', fontWeight: 700, fontSize: '13px' }}>{expandedImage.title}</span>
            <button
              type="button"
              onClick={() => setExpandedImage(null)}
              style={{ background: '#ef4444', color: '#ffffff', border: 'none', borderRadius: '4px', padding: '4px 10px', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
            >
              ✕ Close
            </button>
          </div>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <img
              src={expandedImage.src}
              alt={expandedImage.title}
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '4px' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
