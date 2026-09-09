import type { DomNode, PlanAction, AuditLogEntry, PolicyRecord } from '@/types';
import { executePlan } from './executor';
import { detectPii } from './pii-detect';
import { getPolicy, resolvePolicyAction, DEFAULT_POLICY } from './policy';

export function extractDom(): DomNode[] {
  const selector = 'input, button, a, select, textarea, [role], label, h1, h2, h3, p, canvas';
  const elements = document.querySelectorAll(selector);
  const nodes: DomNode[] = [];

  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

  for (const el of elements) {
    // Ignore internal privacy overlays
    if (el.closest('#nexus-page-privacy-container') || el.closest('#nexus-privacy-badge')) {
      continue;
    }

    const rect = el.getBoundingClientRect();
    // Skip elements with zero width or zero height (hidden elements)
    if (rect.width <= 0 || rect.height <= 0) {
      continue;
    }

    // Skip elements outside the current viewport bounds
    if (
      rect.bottom <= 0 ||
      rect.top >= viewportHeight ||
      rect.right <= 0 ||
      rect.left >= viewportWidth
    ) {
      continue;
    }

    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');

    // Trimmed text content (max 200 chars)
    let rawText = '';
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      rawText = el.value || el.placeholder || el.getAttribute('aria-label') || '';
    } else {
      rawText = el.textContent || '';
    }
    const text = rawText.trim().replace(/\s+/g, ' ').slice(0, 200);

    // Relevant attrs (id, name, type)
    const attributes: DomNode['attributes'] = {};
    const id = el.getAttribute('id');
    if (id) attributes.id = id;

    const name = el.getAttribute('name');
    if (name) attributes.name = name;

    const type = el.getAttribute('type');
    if (type) attributes.type = type;

    const placeholder = el.getAttribute('placeholder');
    if (placeholder) attributes.placeholder = placeholder;

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) attributes['aria-label'] = ariaLabel;

    const title = el.getAttribute('title');
    if (title) attributes['title'] = title;

    const className = el.getAttribute('class');
    if (className) attributes['class'] = className;

    nodes.push({
      tag,
      role,
      text,
      attributes,
      boundingBox: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    });
  }

  return nodes;
}

export function injectPrivacyStyles() {
  if (!document.getElementById('nexus-privacy-injected-styles')) {
    const style = document.createElement('style');
    style.id = 'nexus-privacy-injected-styles';
    style.textContent = `
      .nexus-privacy-shielded {
        filter: blur(7px) !important;
        background-color: #090d16 !important;
        color: transparent !important;
        caret-color: transparent !important;
        text-shadow: 0 0 8px rgba(255, 255, 255, 0.3) !important;
        border: 2px solid #ef4444 !important;
        border-radius: 4px !important;
        transition: filter 0.2s ease !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }
}

export function renderPagePrivacyMasks(
  masks: Array<{ bbox: { x: number; y: number; width: number; height: number }; category: string; action: string; elementSelector?: string }>
) {
  injectPrivacyStyles();

  let container = document.getElementById('nexus-page-privacy-container');
  if (container) {
    container.remove();
  }

  let badge = document.getElementById('nexus-privacy-badge');
  if (badge) {
    badge.remove();
  }

  if (!masks || masks.length === 0) return;

  container = document.createElement('div');
  container.id = 'nexus-page-privacy-container';
  container.style.position = 'fixed';
  container.style.top = '0';
  container.style.left = '0';
  container.style.width = '100vw';
  container.style.height = '100vh';
  container.style.pointerEvents = 'none';
  container.style.zIndex = '2147483640';
  container.style.fontFamily = 'system-ui, -apple-system, sans-serif';

  for (const item of masks) {
    const box = document.createElement('div');
    box.style.position = 'fixed';
    box.style.left = `${Math.max(0, item.bbox.x)}px`;
    box.style.top = `${Math.max(0, item.bbox.y)}px`;
    box.style.width = `${Math.max(20, item.bbox.width)}px`;
    box.style.height = `${Math.max(16, item.bbox.height)}px`;
    box.style.backgroundColor = '#05070e';
    box.style.border = item.action === 'BLOCK' ? '2px solid #991b1b' : '2px solid #ef4444';
    box.style.borderRadius = '4px';
    box.style.boxShadow = '0 2px 10px rgba(239, 68, 68, 0.5)';
    box.style.boxSizing = 'border-box';
    box.style.display = 'flex';
    box.style.alignItems = 'center';
    box.style.justifyContent = 'flex-start';
    box.style.padding = '0 6px';
    box.style.overflow = 'hidden';

    const label = document.createElement('span');
    label.style.color = '#ffffff';
    label.style.fontSize = '11px';
    label.style.fontWeight = 'bold';
    label.style.letterSpacing = '0.5px';
    label.style.whiteSpace = 'nowrap';
    label.innerText = `🛡️ [REDACTED: ${item.category.toUpperCase()}]`;

    box.appendChild(label);
    container.appendChild(box);
  }

  (document.body || document.documentElement).appendChild(container);

  // Render floating status badge in bottom-right corner
  badge = document.createElement('div');
  badge.id = 'nexus-privacy-badge';
  badge.style.position = 'fixed';
  badge.style.bottom = '16px';
  badge.style.right = '16px';
  badge.style.background = 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)';
  badge.style.color = '#38bdf8';
  badge.style.border = '1px solid #38bdf8';
  badge.style.borderRadius = '20px';
  badge.style.padding = '6px 14px';
  badge.style.fontSize = '12px';
  badge.style.fontWeight = 'bold';
  badge.style.boxShadow = '0 4px 14px rgba(0,0,0,0.3)';
  badge.style.zIndex = '2147483645';
  badge.style.fontFamily = 'system-ui, -apple-system, sans-serif';
  badge.style.display = 'flex';
  badge.style.alignItems = 'center';
  badge.style.gap = '6px';
  badge.style.pointerEvents = 'auto';
  badge.style.cursor = 'default';
  badge.innerHTML = `<span>🛡️</span> <span>Privacy Guard Active: <strong>${masks.length} Field(s) Masked</strong></span>`;
  (document.body || document.documentElement).appendChild(badge);
}

export function clearPagePrivacyMasks() {
  const container = document.getElementById('nexus-page-privacy-container');
  if (container) {
    container.remove();
  }
  const badge = document.getElementById('nexus-privacy-badge');
  if (badge) {
    badge.remove();
  }
}

let isShieldActive = true;
let isProactiveAutoScanEnabled = true;

/**
 * Proactively scans the webpage for sensitive PII and applies on-screen redaction masks directly.
 */
export async function autoScanAndMask() {
  if (!isShieldActive || !isProactiveAutoScanEnabled) {
    clearPagePrivacyMasks();
    return;
  }

  try {
    const dom = extractDom();
    if (!dom || dom.length === 0) return;

    // Detect PII via client-side regex & heuristics
    const classifications = detectPii(dom, []);
    if (!classifications || classifications.length === 0) {
      clearPagePrivacyMasks();
      return;
    }

    const policy = await getPolicy();
    const masks: Array<{ bbox: { x: number; y: number; width: number; height: number }; category: string; action: string }> = [];

    for (const c of classifications) {
      const action = resolvePolicyAction(policy, c.category);
      if (action === 'MASK' || action === 'BLOCK' || action === 'ASK') {
        masks.push({
          bbox: c.bbox,
          category: c.category,
          action,
        });
      }
    }

    if (masks.length > 0 && isShieldActive) {
      renderPagePrivacyMasks(masks);
      console.log(`[Nexus Privacy Agent] 🛡️ Proactive Auto-Masking applied: ${masks.length} sensitive element(s) shielded from agent vision.`);
    } else {
      clearPagePrivacyMasks();
    }
  } catch (err) {
    console.warn('[Nexus Privacy Agent] autoScanAndMask error:', err);
  }
}

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    console.log('[Nexus Privacy Agent] Proactive Content script initialized on:', window.location.href);
    try {
      document.documentElement.dataset.nexusExtensionId = chrome.runtime.id;
    } catch {
      // ignore
    }

    // 0. Sync power and proactive shield state from storage
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.get(['nexus_extension_active', 'nexus_proactive_shield'], (res) => {
          if (res && res.nexus_extension_active !== undefined) {
            isShieldActive = Boolean(res.nexus_extension_active);
          }
          if (res && res.nexus_proactive_shield !== undefined) {
            isProactiveAutoScanEnabled = Boolean(res.nexus_proactive_shield);
          }
          if (isShieldActive && isProactiveAutoScanEnabled) {
            setTimeout(autoScanAndMask, 300);
          } else {
            clearPagePrivacyMasks();
          }
        });

        // Listen for user toggle events across all open browser tabs
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'local') {
            if (changes.nexus_extension_active !== undefined) {
              isShieldActive = Boolean(changes.nexus_extension_active.newValue);
              if (!isShieldActive) {
                clearPagePrivacyMasks();
                console.log('[Nexus Privacy Agent] 🛑 Privacy Shield paused by user.');
              } else if (isProactiveAutoScanEnabled) {
                console.log('[Nexus Privacy Agent] ▶️ Privacy Shield activated by user.');
                autoScanAndMask();
              }
            }
            if (changes.nexus_proactive_shield !== undefined) {
              isProactiveAutoScanEnabled = Boolean(changes.nexus_proactive_shield.newValue);
              if (!isProactiveAutoScanEnabled) {
                clearPagePrivacyMasks();
              } else if (isShieldActive) {
                autoScanAndMask();
              }
            }
          }
        });
      }
    } catch {
      // fallback
    }

    // 1. Proactive auto-scan when page loads
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        if (isShieldActive && isProactiveAutoScanEnabled) setTimeout(autoScanAndMask, 300);
      });
    } else {
      if (isShieldActive && isProactiveAutoScanEnabled) setTimeout(autoScanAndMask, 300);
    }
    window.addEventListener('load', () => {
      if (isShieldActive && isProactiveAutoScanEnabled) setTimeout(autoScanAndMask, 500);
    });

    // 2. Watch for dynamic form inputs or DOM additions (debounced)
    let mutationTimer: any = null;
    const observer = new MutationObserver((mutations) => {
      if (!isShieldActive || !isProactiveAutoScanEnabled) return;

      let isOurSelf = false;
      for (const m of mutations) {
        if (
          (m.target as HTMLElement)?.id === 'nexus-page-privacy-container' ||
          (m.target as HTMLElement)?.id === 'nexus-privacy-badge'
        ) {
          isOurSelf = true;
          break;
        }
      }
      if (isOurSelf) return;

      clearTimeout(mutationTimer);
      mutationTimer = setTimeout(autoScanAndMask, 400);
    });

    try {
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    } catch {
      // ignore
    }

    document.addEventListener('input', () => {
      if (!isShieldActive || !isProactiveAutoScanEnabled) return;
      clearTimeout(mutationTimer);
      mutationTimer = setTimeout(autoScanAndMask, 300);
    });

    window.addEventListener('scroll', () => {
      if (!isShieldActive || !isProactiveAutoScanEnabled) return;
      clearTimeout(mutationTimer);
      mutationTimer = setTimeout(autoScanAndMask, 80);
    }, { passive: true });

    window.addEventListener('resize', () => {
      if (!isShieldActive || !isProactiveAutoScanEnabled) return;
      clearTimeout(mutationTimer);
      mutationTimer = setTimeout(autoScanAndMask, 100);
    }, { passive: true });

    // 3. Message handlers for extension popup and background worker
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message && message.type === 'SET_SHIELD_ACTIVE') {
        isShieldActive = Boolean(message.active);
        if (!isShieldActive) {
          clearPagePrivacyMasks();
        } else if (isProactiveAutoScanEnabled) {
          autoScanAndMask();
        }
        sendResponse({ success: true, active: isShieldActive });
        return true;
      }

      if (message && message.type === 'GET_SHIELD_STATUS') {
        sendResponse({ active: isShieldActive, proactive: isProactiveAutoScanEnabled });
        return true;
      }

      if (message && message.type === 'AUTO_SCAN_PRIVACY') {
        autoScanAndMask().then(() => sendResponse({ success: true }));
        return true;
      }

      if (message && message.type === 'GET_CONTEXT') {
        const dom = extractDom();
        console.log(`[Nexus Privacy Agent] ✅ Extracted ${dom.length} DOM elements from page:`, dom);
        sendResponse(dom);
        return true;
      }

      if (message && message.type === 'RENDER_PAGE_MASKS') {
        if (isShieldActive) {
          renderPagePrivacyMasks(message.masks || []);
          sendResponse({ success: true, count: (message.masks || []).length });
        } else {
          clearPagePrivacyMasks();
          sendResponse({ success: false, reason: 'Shield paused' });
        }
        return true;
      }

      if (message && message.type === 'CLEAR_PAGE_MASKS') {
        clearPagePrivacyMasks();
        sendResponse({ success: true });
        return true;
      }

      if (message && message.type === 'EXECUTE_PLAN') {
        const actions: PlanAction[] = message.actions || [];
        const auditLog: AuditLogEntry[] = message.safeContextAuditLog || [];
        console.log(`[Nexus Privacy Agent] 📥 Received EXECUTE_PLAN with ${actions.length} action(s).`);

        executePlan(actions, auditLog)
          .then((report) => {
            console.log('[Nexus Privacy Agent] 🏁 Execution completed:', report);
            sendResponse(report);
          })
          .catch((err) => {
            console.error('[Nexus Privacy Agent] ❌ Execution error:', err);
            sendResponse({
              totalSteps: actions.length,
              executedSteps: 0,
              results: [],
              completedAt: Date.now(),
              success: false,
              error: err?.message || String(err),
            });
          });

        return true; // Keep message port open for async response
      }
    });
  },
});
