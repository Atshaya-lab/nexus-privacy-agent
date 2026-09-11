import type { DomNode, PlanAction, AuditLogEntry, PolicyRecord } from '@/types';
import { executePlan } from './executor';
import { detectPii } from './pii-detect';
import { getPolicy, resolvePolicyAction, DEFAULT_POLICY } from './policy';

export function extractDom(): DomNode[] {
  const selector = 'input, button, a, select, textarea, [role], label, h1, h2, h3, p, canvas, #state, #city, #subjectsContainer';
  const elements = document.querySelectorAll(selector);
  const nodes: DomNode[] = [];

  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const scrollBuffer = 400;

  let nodeCounter = 0;
  for (const el of elements) {
    // Ignore internal privacy overlays
    if (
      el.closest('#nexus-page-privacy-container') ||
      el.closest('#nexus-privacy-badge') ||
      el.closest('#nexus-agent-execution-overlay')
    ) {
      continue;
    }

    const tag = el.tagName.toLowerCase();
    const isFormControl =
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLButtonElement ||
      tag === 'label' ||
      el.id === 'state' ||
      el.id === 'city' ||
      el.id === 'subjectsContainer';

    const rect = el.getBoundingClientRect();
    // Skip non-form elements with zero dimensions
    if (!isFormControl && (rect.width <= 0 || rect.height <= 0)) {
      continue;
    }

    // Skip non-form elements outside current viewport bounds
    if (
      !isFormControl &&
      (rect.bottom < -scrollBuffer ||
      rect.top > viewportHeight + scrollBuffer ||
      rect.right < 0 ||
      rect.left > viewportWidth)
    ) {
      continue;
    }

    const role = el.getAttribute('role');

    // Assign / retrieve unique persistent ID for tracking
    let domId = (el as HTMLElement).dataset.nexusDomId;
    if (!domId) {
      domId = `nexus-node-${++nodeCounter}`;
      (el as HTMLElement).dataset.nexusDomId = domId;
    }

    // Trimmed text content (max 200 chars)
    let rawText = '';
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      rawText = el.value || '';
    } else {
      rawText = el.textContent || '';
    }
    const text = rawText.trim().replace(/\s+/g, ' ').slice(0, 200);

    // Relevant attrs (id, name, type)
    const attributes: DomNode['attributes'] = {
      'data-nexus-dom-id': domId,
    };
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

    const htmlFor = el.getAttribute('for');
    if (htmlFor) attributes['for'] = htmlFor;

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.value && el.value.trim().length > 0) {
        attributes.value = el.value;
      }
    }

    // Detect associated label for form controls so inputs inherit their label context
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ) {
      let associatedLabel = '';
      if ((el as any).labels && (el as any).labels.length > 0) {
        associatedLabel = Array.from((el as any).labels as HTMLLabelElement[])
          .map((l) => l.textContent || '')
          .join(' ')
          .trim();
      }
      if (!associatedLabel && id) {
        try {
          const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (lbl) associatedLabel = (lbl.textContent || '').trim();
        } catch {}
      }
      if (!associatedLabel) {
        // Walk up ancestors checking for container row/form-group labels
        let parent: HTMLElement | null = el.parentElement;
        let depth = 0;
        while (parent && parent !== document.body && depth < 5 && !associatedLabel) {
          const rowLbl = parent.querySelector('label');
          if (rowLbl && rowLbl !== (el as HTMLElement) && !rowLbl.contains(el)) {
            associatedLabel = (rowLbl.textContent || '').trim();
            break;
          }
          parent = parent.parentElement;
          depth++;
        }
      }
      if (!associatedLabel) {
        let prev = el.previousElementSibling;
        while (prev && !associatedLabel) {
          if (prev.tagName.toLowerCase() === 'label' || prev.getAttribute('role') === 'label') {
            associatedLabel = (prev.textContent || '').trim();
          }
          prev = prev.previousElementSibling;
        }
      }
      if (associatedLabel) {
        attributes.label = associatedLabel.replace(/\s+/g, ' ').slice(0, 100);
      }
    }

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
        filter: blur(8px) !important;
        background-color: #05070e !important;
        color: transparent !important;
        caret-color: transparent !important;
        text-shadow: 0 0 10px rgba(255, 255, 255, 0.2) !important;
        border: 2px solid #ef4444 !important;
        border-radius: 4px !important;
        user-select: none !important;
        transition: none !important;
      }
      #nexus-page-privacy-container {
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
        width: 100% !important;
        pointer-events: none !important;
        z-index: 2147483640 !important;
        overflow: visible !important;
      }
      .nexus-privacy-mask-box {
        position: absolute !important;
        background-color: #05070e !important;
        border-radius: 4px !important;
        box-shadow: 0 2px 10px rgba(239, 68, 68, 0.5) !important;
        box-sizing: border-box !important;
        display: flex !important;
        align-items: center !important;
        justify-content: flex-start !important;
        padding: 0 6px !important;
        overflow: hidden !important;
        pointer-events: none !important;
        z-index: 2147483641 !important;
        transition: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }
}

interface TrackedMaskItem {
  box: HTMLDivElement;
  targetEl?: HTMLElement | null;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  docX: number;
  docY: number;
}

let activeTrackedMasks: TrackedMaskItem[] = [];
let scrollRafId: number | null = null;
let isScrollListenerAttached = false;

function syncTrackedMaskPositions() {
  if (!activeTrackedMasks.length) return;

  const bodyEl = document.body || document.documentElement;
  const bodyRect = bodyEl.getBoundingClientRect();

  // Keep container height matched to document height
  const container = document.getElementById('nexus-page-privacy-container');
  if (container) {
    const docHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight || 0,
      document.documentElement.clientHeight
    );
    container.style.height = `${docHeight}px`;
  }

  for (const item of activeTrackedMasks) {
    if (item.targetEl && item.targetEl.isConnected) {
      const elRect = item.targetEl.getBoundingClientRect();
      const newDocX = Math.round(elRect.left - bodyRect.left + item.offsetX);
      const newDocY = Math.round(elRect.top - bodyRect.top + item.offsetY);
      item.box.style.left = `${Math.max(0, newDocX)}px`;
      item.box.style.top = `${Math.max(0, newDocY)}px`;

      if (item.targetEl.tagName.toLowerCase() !== 'canvas') {
        item.box.style.width = `${Math.max(20, Math.round(elRect.width))}px`;
        item.box.style.height = `${Math.max(16, Math.round(elRect.height))}px`;
      }
    }
  }
}

function attachScrollTracker() {
  if (isScrollListenerAttached) return;
  isScrollListenerAttached = true;

  const onScrollOrResize = () => {
    if (scrollRafId) return;
    scrollRafId = requestAnimationFrame(() => {
      scrollRafId = null;
      syncTrackedMaskPositions();
    });
  };

  window.addEventListener('scroll', onScrollOrResize, { passive: true, capture: true });
  window.addEventListener('resize', onScrollOrResize, { passive: true });
}

export function renderPagePrivacyMasks(
  masks: Array<{
    bbox: { x: number; y: number; width: number; height: number };
    category: string;
    action: string;
    elementSelector?: string;
    domId?: string;
  }>
) {
  injectPrivacyStyles();
  clearPagePrivacyMasks();

  if (!masks || masks.length === 0) return;

  const bodyEl = document.body || document.documentElement;
  const bodyRect = bodyEl.getBoundingClientRect();

  const container = document.createElement('div');
  container.id = 'nexus-page-privacy-container';
  container.style.position = 'absolute';
  container.style.top = '0';
  container.style.left = '0';
  container.style.width = '100%';
  const docHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body?.scrollHeight || 0,
    document.documentElement.clientHeight
  );
  container.style.height = `${docHeight}px`;
  container.style.pointerEvents = 'none';
  container.style.zIndex = '2147483640';
  container.style.fontFamily = 'system-ui, -apple-system, sans-serif';

  activeTrackedMasks = [];

  for (const item of masks) {
    // 1. Locate the exact DOM element (or canvas)
    let targetEl: HTMLElement | null = null;
    if (item.domId) {
      targetEl = document.querySelector(`[data-nexus-dom-id="${item.domId}"]`);
    }
    if (!targetEl && item.elementSelector) {
      try {
        targetEl = document.querySelector(item.elementSelector);
      } catch {}
    }
    if (!targetEl) {
      const midX = item.bbox.x + item.bbox.width / 2;
      const midY = item.bbox.y + item.bbox.height / 2;
      const found = document.elementFromPoint(midX, midY);
      if (found && found !== document.body && found !== document.documentElement) {
        if (!found.closest('#nexus-page-privacy-container') && !found.closest('#nexus-privacy-badge')) {
          targetEl = found as HTMLElement;
        }
      }
    }

    // 2. Direct Element Shielding: Apply blackout/blur directly to DOM node
    if (targetEl && targetEl.tagName.toLowerCase() !== 'canvas') {
      targetEl.classList.add('nexus-privacy-shielded');
    }

    // 3. Coordinate calculation in document-relative space
    let offsetX = 0;
    let offsetY = 0;
    let width = item.bbox.width;
    let height = item.bbox.height;
    let docX = item.bbox.x - bodyRect.left;
    let docY = item.bbox.y - bodyRect.top;

    if (targetEl) {
      const elRect = targetEl.getBoundingClientRect();
      if (targetEl.tagName.toLowerCase() === 'canvas') {
        offsetX = item.bbox.x - elRect.left;
        offsetY = item.bbox.y - elRect.top;
      } else {
        offsetX = 0;
        offsetY = 0;
        width = Math.max(item.bbox.width, elRect.width);
        height = Math.max(item.bbox.height, elRect.height);
      }
      docX = elRect.left - bodyRect.left + offsetX;
      docY = elRect.top - bodyRect.top + offsetY;
    }

    // 4. Create document-relative blackout box
    const box = document.createElement('div');
    box.className = 'nexus-privacy-mask-box';
    box.style.position = 'absolute';
    box.style.left = `${Math.max(0, Math.round(docX))}px`;
    box.style.top = `${Math.max(0, Math.round(docY))}px`;
    box.style.width = `${Math.max(20, Math.round(width))}px`;
    box.style.height = `${Math.max(16, Math.round(height))}px`;
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
    const displayCat = item.category.toUpperCase().replace('_', ' ');
    label.innerText = `🛡️ ${displayCat}`;

    box.appendChild(label);
    container.appendChild(box);

    activeTrackedMasks.push({
      box,
      targetEl,
      offsetX,
      offsetY,
      width,
      height,
      docX,
      docY,
    });
  }

  bodyEl.appendChild(container);

  // Status badge remains fixed in bottom-right corner of viewport
  const badge = document.createElement('div');
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
  bodyEl.appendChild(badge);

  attachScrollTracker();
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
  // Clear direct element shielding
  document.querySelectorAll('.nexus-privacy-shielded').forEach((el) => {
    el.classList.remove('nexus-privacy-shielded');
  });
  activeTrackedMasks = [];
}

let isTabSessionActive = false;
let isShieldActive = false;
let isMasksExplicitlyHidden = false;
let mutationObserverInstance: MutationObserver | null = null;
let inputListenerAttached = false;
let mutationTimer: any = null;

function isContextValid(): boolean {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
      return false;
    }
    // Fast check: getManifest throws immediately if extension context has been invalidated
    return Boolean(chrome.runtime.getManifest());
  } catch {
    return false;
  }
}

const onInputOrScroll = () => {
  if (!isContextValid() || !isTabSessionActive || isMasksExplicitlyHidden) {
    if (!isContextValid()) {
      deactivateTabSession();
    }
    return;
  }
  clearTimeout(mutationTimer);
  mutationTimer = setTimeout(autoScanAndMask, 250);
};

export function activateTabSession(session?: any) {
  if (!isContextValid()) return;
  if (isTabSessionActive) return;
  isTabSessionActive = true;
  isShieldActive = true;
  console.log('[Nexus Privacy Agent] 🛡️ Agent Session ACTIVE on this tab:', window.location.href);

  injectPrivacyStyles();

  // Attach dynamic mutation observer ONLY on this active tab
  if (!mutationObserverInstance && document.body) {
    mutationObserverInstance = new MutationObserver((mutations) => {
      if (!isContextValid() || !isTabSessionActive || isMasksExplicitlyHidden) {
        return;
      }
      let isOurSelf = false;
      for (const m of mutations) {
        if (
          (m.target as HTMLElement)?.id === 'nexus-page-privacy-container' ||
          (m.target as HTMLElement)?.id === 'nexus-privacy-badge' ||
          (m.target as HTMLElement)?.id === 'nexus-agent-execution-overlay'
        ) {
          isOurSelf = true;
          break;
        }
      }
      if (isOurSelf) return;

      clearTimeout(mutationTimer);
      mutationTimer = setTimeout(autoScanAndMask, 350);
    });

    try {
      mutationObserverInstance.observe(document.body, { childList: true, subtree: true });
    } catch {
      // ignore
    }
  }

  if (!inputListenerAttached) {
    document.addEventListener('input', onInputOrScroll);
    window.addEventListener('scroll', onInputOrScroll, { passive: true });
    window.addEventListener('resize', onInputOrScroll, { passive: true });
    inputListenerAttached = true;
  }

  // Immediately run protection scan on this active tab
  autoScanAndMask();
}

export function deactivateTabSession() {
  isTabSessionActive = false;
  isShieldActive = false;
  isMasksExplicitlyHidden = false;

  if (mutationObserverInstance) {
    try {
      mutationObserverInstance.disconnect();
    } catch {}
    mutationObserverInstance = null;
  }

  if (inputListenerAttached) {
    try {
      document.removeEventListener('input', onInputOrScroll);
      window.removeEventListener('scroll', onInputOrScroll);
      window.removeEventListener('resize', onInputOrScroll);
    } catch {}
    inputListenerAttached = false;
  }

  clearTimeout(mutationTimer);
  clearPagePrivacyMasks();
}

/**
 * Proactively scans the webpage for sensitive PII and applies on-screen redaction masks directly.
 * Strictly runs ONLY when an agent session is active on this tab.
 */
export async function autoScanAndMask() {
  if (!isContextValid() || !isTabSessionActive || !isShieldActive || isMasksExplicitlyHidden) {
    clearPagePrivacyMasks();
    if (!isContextValid()) {
      deactivateTabSession();
    }
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
    const masks: Array<{ bbox: { x: number; y: number; width: number; height: number }; category: string; action: string; domId?: string }> = [];

    for (const c of classifications) {
      const action = resolvePolicyAction(policy, c.category);
      if (action === 'MASK' || action === 'BLOCK' || action === 'ASK') {
        const domId = c.originalItem?.attributes?.['data-nexus-dom-id'];
        masks.push({
          bbox: c.bbox,
          category: c.category,
          action,
          domId,
        });
      }
    }

    if (masks.length > 0 && isTabSessionActive && isShieldActive) {
      renderPagePrivacyMasks(masks);
      console.log(`[Nexus Privacy Agent] 🛡️ Shielding active tab: ${masks.length} sensitive element(s) protected.`);
    } else {
      clearPagePrivacyMasks();
    }
  } catch (err: any) {
    const errMsg = String(err?.message || err || '').toLowerCase();
    if (errMsg.includes('context invalidated') || errMsg.includes('extension context')) {
      deactivateTabSession();
    }
  }
}

export default defineContentScript({
  matches: ['<all_urls>'],
  main(ctx) {
    // Graceful invalidation cleanup on extension reload/update
    if (ctx && typeof (ctx as any).onInvalidated === 'function') {
      (ctx as any).onInvalidated(() => {
        deactivateTabSession();
      });
    }

    // Content script starts completely idle — NO background processing until user starts agent on this tab
    try {
      if (isContextValid()) {
        document.documentElement.dataset.nexusExtensionId = chrome.runtime.id;
      }
    } catch {
      // ignore
    }

    // Message handlers for extension popup and background coordinator
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message) return;

      if (message.type === 'SESSION_ACTIVATED') {
        activateTabSession(message.session);
        sendResponse({ success: true, active: true });
        return true;
      }

      if (message.type === 'SESSION_DEACTIVATED' || message.type === 'STOP_AGENT_SESSION') {
        deactivateTabSession();
        sendResponse({ success: true, active: false });
        return true;
      }

      if (message.type === 'GET_SHIELD_STATUS') {
        sendResponse({ active: isTabSessionActive, sessionActive: isTabSessionActive });
        return true;
      }

      if (message.type === 'SET_SHIELD_ACTIVE') {
        if (message.active) {
          activateTabSession();
        } else {
          deactivateTabSession();
        }
        sendResponse({ success: true, active: isTabSessionActive });
        return true;
      }

      if (message.type === 'AUTO_SCAN_PRIVACY') {
        if (isTabSessionActive) {
          autoScanAndMask().then(() => sendResponse({ success: true }));
        } else {
          sendResponse({ success: false, reason: 'Tab session not active' });
        }
        return true;
      }

      if (message.type === 'GET_CONTEXT') {
        // Explicit user action on this tab: ensure protection session is active
        activateTabSession();
        const dom = extractDom();
        const viewport = {
          width: window.innerWidth || document.documentElement.clientWidth,
          height: window.innerHeight || document.documentElement.clientHeight,
          dpr: window.devicePixelRatio || 1,
        };
        console.log(`[Nexus Privacy Agent] ✅ Extracted ${dom.length} DOM elements from active tab:`, dom);
        sendResponse({ dom, viewport });
        return true;
      }

      if (message.type === 'RENDER_PAGE_MASKS') {
        isMasksExplicitlyHidden = false;
        activateTabSession();
        if (message.masks && message.masks.length > 0) {
          renderPagePrivacyMasks(message.masks);
        } else {
          autoScanAndMask();
        }
        sendResponse({ success: true, count: (message.masks || []).length });
        return true;
      }

      if (message.type === 'CLEAR_PAGE_MASKS') {
        isMasksExplicitlyHidden = true;
        clearTimeout(mutationTimer);
        clearPagePrivacyMasks();
        sendResponse({ success: true });
        return true;
      }

      if (message.type === 'EXECUTE_PLAN') {
        const actions: PlanAction[] = message.actions || [];
        const auditLog: AuditLogEntry[] = message.safeContextAuditLog || [];
        console.log(`[Nexus Privacy Agent] 📥 Received EXECUTE_PLAN on active tab with ${actions.length} action(s).`);

        // Notify background that execution has begun
        chrome.runtime.sendMessage({
          type: 'UPDATE_SESSION_STATUS',
          status: 'EXECUTING',
        }).catch(() => {});

        executePlan(actions, auditLog)
          .then((report) => {
            console.log('[Nexus Privacy Agent] 🏁 Execution completed on tab:', report);
            // Notify background so session status and executionReport are stored even if popup was hidden/closed!
            chrome.runtime.sendMessage({
              type: 'UPDATE_SESSION_STATUS',
              status: report.success ? 'COMPLETED' : 'ERROR',
              executionReport: report,
            }).catch(() => {});
            sendResponse(report);
          })
          .catch((err) => {
            console.error('[Nexus Privacy Agent] ❌ Execution error:', err);
            const errReport = {
              totalSteps: actions.length,
              executedSteps: 0,
              results: [],
              completedAt: Date.now(),
              success: false,
            };
            chrome.runtime.sendMessage({
              type: 'UPDATE_SESSION_STATUS',
              status: 'ERROR',
              executionReport: errReport,
            }).catch(() => {});
            sendResponse(errReport);
          });

        return true; // Keep message port open for async response
      }
    });
  },
});
