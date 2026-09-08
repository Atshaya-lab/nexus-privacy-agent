import type { DomNode, PlanAction, AuditLogEntry } from '@/types';
import { executePlan } from './executor';

export function extractDom(): DomNode[] {
  const selector = 'input, button, a, select, textarea, [role], label, h1, h2, h3, p, canvas';
  const elements = document.querySelectorAll(selector);
  const nodes: DomNode[] = [];

  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

  for (const el of elements) {
    const rect = el.getBoundingClientRect();
    // Skip elements with zero width or zero height (hidden elements)
    if (rect.width <= 0 || rect.height <= 0) {
      continue;
    }

    // Skip elements outside the current viewport bounds
    // (e.g. negative coordinates, accessibility skip links, or scrolled out of view)
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

export function renderPagePrivacyMasks(
  masks: Array<{ bbox: { x: number; y: number; width: number; height: number }; category: string; action: string }>
) {
  let container = document.getElementById('nexus-page-privacy-container');
  if (container) {
    container.remove();
  }

  if (!masks || masks.length === 0) return;

  container = document.createElement('div');
  container.id = 'nexus-page-privacy-container';
  container.style.position = 'absolute';
  container.style.top = '0';
  container.style.left = '0';
  container.style.width = '100%';
  container.style.height = `${Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)}px`;
  container.style.pointerEvents = 'none';
  container.style.zIndex = '2147483640';
  container.style.fontFamily = 'system-ui, -apple-system, sans-serif';

  const scrollX = window.scrollX || window.pageXOffset || 0;
  const scrollY = window.scrollY || window.pageYOffset || 0;

  for (const item of masks) {
    const box = document.createElement('div');
    box.style.position = 'absolute';
    box.style.left = `${Math.max(0, item.bbox.x + scrollX)}px`;
    box.style.top = `${Math.max(0, item.bbox.y + scrollY)}px`;
    box.style.width = `${Math.max(20, item.bbox.width)}px`;
    box.style.height = `${Math.max(16, item.bbox.height)}px`;
    box.style.backgroundColor = '#05070e';
    box.style.border = item.action === 'BLOCK' ? '2px solid #991b1b' : '2px solid #ef4444';
    box.style.borderRadius = '4px';
    box.style.boxShadow = '0 2px 8px rgba(239, 68, 68, 0.4)';
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

  document.body.appendChild(container);
}

export function clearPagePrivacyMasks() {
  const container = document.getElementById('nexus-page-privacy-container');
  if (container) {
    container.remove();
  }
}

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    console.log('[Nexus Privacy Agent] Content script initialized on:', window.location.href, 'ID:', chrome.runtime.id);
    try {
      document.documentElement.dataset.nexusExtensionId = chrome.runtime.id;
    } catch {
      // ignore
    }

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message && message.type === 'GET_CONTEXT') {
        const dom = extractDom();
        console.log(`[Nexus Privacy Agent] ✅ Extracted ${dom.length} DOM elements from page:`, dom);
        sendResponse(dom);
        return true;
      }

      if (message && message.type === 'RENDER_PAGE_MASKS') {
        renderPagePrivacyMasks(message.masks || []);
        sendResponse({ success: true, count: (message.masks || []).length });
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
