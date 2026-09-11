import type {
  PlanAction,
  AuditLogEntry,
  ExecutionStepResult,
  ExecutionReport,
} from '@/types';

/**
 * Checks if target coordinates or bounding box overlap with any MASK or BLOCK
 * regions recorded in the SafeContext audit log.
 */
export function checkSpatialPrivacyViolation(
  bbox: { x: number; y: number; w: number; h: number },
  auditLog?: AuditLogEntry[]
): { violated: boolean; reason?: string } {
  if (!auditLog || !Array.isArray(auditLog)) {
    return { violated: false };
  }

  const cx = bbox.x + bbox.w / 2;
  const cy = bbox.y + bbox.h / 2;
  const boxArea = Math.max(bbox.w * bbox.h, 1.0);

  for (const entry of auditLog) {
    if (entry.action === 'MASK' || entry.action === 'BLOCK') {
      const eBbox = entry.bbox;
      // Bbox overlap check with margin
      const overlapX = Math.max(0, Math.min(bbox.x + bbox.w, eBbox.x + eBbox.width) - Math.max(bbox.x, eBbox.x));
      const overlapY = Math.max(0, Math.min(bbox.y + bbox.h, eBbox.y + eBbox.height) - Math.max(bbox.y, eBbox.y));
      const overlapArea = overlapX * overlapY;
      const overlapRatio = overlapArea / boxArea;

      const pointInside =
        cx >= eBbox.x &&
        cx <= eBbox.x + eBbox.width &&
        cy >= eBbox.y &&
        cy <= eBbox.y + eBbox.height;

      if (pointInside || overlapRatio > 0.15) {
        return {
          violated: true,
          reason: `Defense-in-Depth Block: Target overlaps client-redacted ${entry.category.toUpperCase()} region [${eBbox.width}x${eBbox.height} at ${eBbox.x},${eBbox.y}]. Execution aborted.`,
        };
      }
    }
  }

  return { violated: false };
}

/**
 * Displays a non-intrusive, prominent visual execution cue over the target element.
 */
export function showVisualHighlight(
  bbox: { x: number; y: number; w: number; h: number },
  label: string,
  actionType: string
): () => void {
  // Remove existing highlight if any
  const existing = document.getElementById('nexus-agent-execution-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'nexus-agent-execution-overlay';
  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100vw';
  overlay.style.height = '100vh';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '2147483647';
  overlay.style.fontFamily = 'system-ui, -apple-system, sans-serif';

  // Highlight Box
  const box = document.createElement('div');
  box.style.position = 'absolute';
  box.style.left = `${Math.max(0, bbox.x - 4)}px`;
  box.style.top = `${Math.max(0, bbox.y - 4)}px`;
  box.style.width = `${Math.max(16, bbox.w + 8)}px`;
  box.style.height = `${Math.max(16, bbox.h + 8)}px`;
  box.style.border = '2px solid #2563eb';
  box.style.borderRadius = '6px';
  box.style.boxShadow = '0 0 0 3px rgba(37, 99, 235, 0.35), 0 4px 14px rgba(37, 99, 235, 0.5)';
  box.style.background = 'rgba(37, 99, 235, 0.08)';
  box.style.transition = 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)';
  box.style.boxSizing = 'border-box';

  // Floating Action Tag
  const tag = document.createElement('div');
  tag.style.position = 'absolute';
  tag.style.top = '-28px';
  tag.style.left = '0';
  tag.style.background = '#1e3a8a';
  tag.style.color = '#ffffff';
  tag.style.fontSize = '11px';
  tag.style.fontWeight = '700';
  tag.style.padding = '3px 8px';
  tag.style.borderRadius = '4px';
  tag.style.whiteSpace = 'nowrap';
  tag.style.boxShadow = '0 2px 6px rgba(0,0,0,0.3)';
  tag.style.display = 'flex';
  tag.style.alignItems = 'center';
  tag.style.gap = '5px';
  tag.innerHTML = `<span>🤖</span> <span>${actionType.toUpperCase()}: ${label}</span>`;

  // Ripple / Pulse indicator at center
  const ripple = document.createElement('div');
  const cx = bbox.w / 2;
  const cy = bbox.h / 2;
  ripple.style.position = 'absolute';
  ripple.style.left = `${cx - 15}px`;
  ripple.style.top = `${cy - 15}px`;
  ripple.style.width = '30px';
  ripple.style.height = '30px';
  ripple.style.borderRadius = '50%';
  ripple.style.border = '2px solid #3b82f6';
  ripple.style.background = 'rgba(59, 130, 246, 0.25)';
  ripple.style.animation = 'nexusRipple 0.8s ease-out infinite';

  // Inject keyframe animation if not already present
  if (!document.getElementById('nexus-agent-styles')) {
    const style = document.createElement('style');
    style.id = 'nexus-agent-styles';
    style.textContent = `
      @keyframes nexusRipple {
        0% { transform: scale(0.6); opacity: 1; }
        100% { transform: scale(2.2); opacity: 0; }
      }
    `;
    document.head.appendChild(style);
  }

  box.appendChild(tag);
  box.appendChild(ripple);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  return () => {
    try {
      overlay.remove();
    } catch {
      // ignore
    }
  };
}

/**
 * Executes a single plan action on the current page.
 */
export async function executeAction(
  action: PlanAction,
  stepIndex: number,
  auditLog?: AuditLogEntry[]
): Promise<ExecutionStepResult> {
  const timestamp = Date.now();
  console.log(`[Nexus Privacy Agent] Executing Step [${stepIndex + 1}]:`, action);

  // 1. Locate target element
  let targetElement: Element | null = null;
  if (action.targetSelector && action.targetSelector !== 'body' && action.targetSelector !== 'html') {
    try {
      targetElement = document.querySelector(action.targetSelector);
    } catch {
      // invalid selector syntax
    }
  }

  // Fallback to grounded coordinates center if selector not found
  const centerX = action.groundedBbox.x + action.groundedBbox.w / 2;
  const centerY = action.groundedBbox.y + action.groundedBbox.h / 2;

  if (!targetElement) {
    targetElement = document.elementFromPoint(centerX, centerY);
  }

  // Calculate actual bounding box for visual feedback and accurate spatial verification
  let effectiveBbox = action.groundedBbox;
  if (targetElement) {
    const rect = targetElement.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      effectiveBbox = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      };
    }
  }

  // 2. Defense-in-depth safety check on BOTH effective bounds AND model-grounded coordinates
  // Even if the server hallucinated, was compromised, or returned coordinates near sensitive elements,
  // the client-side executor independently intercepts before any mouse event or keystroke can fire.
  const isUserProfileAutofill = Boolean(action.reasoning?.includes('saved profile') || action.reasoning?.includes('Autofill'));
  const privacyCheckEffective = !isUserProfileAutofill ? checkSpatialPrivacyViolation(effectiveBbox, auditLog) : { violated: false };
  const privacyCheckGrounded = !isUserProfileAutofill ? checkSpatialPrivacyViolation(action.groundedBbox, auditLog) : { violated: false };
  const privacyCheck = privacyCheckEffective.violated ? privacyCheckEffective : privacyCheckGrounded;

  if (privacyCheck.violated) {
    console.error(`[Nexus Privacy Agent] 🚨 SECURITY VIOLATION (Client-Side Defense-in-Depth):`, privacyCheck.reason);
    return {
      stepIndex,
      action,
      status: 'BLOCKED',
      message: privacyCheck.reason || 'Blocked by client-side privacy gate',
      timestamp,
    };
  }

  // 3. Show visual highlight for feedback
  const targetLabel = action.targetSelector || `<${targetElement?.tagName?.toLowerCase() || 'element'}>`;
  const removeHighlight = showVisualHighlight(effectiveBbox, targetLabel, action.action);

  // Allow human and video/screenshot visual perception of highlight
  await new Promise((resolve) => setTimeout(resolve, 600));

  try {
    if (targetElement) {
      if (action.action === 'click') {
        // Scroll into view if needed (using 'auto' to avoid delayed animations)
        targetElement.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' });
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Native click sequence
        if (typeof (targetElement as HTMLElement).focus === 'function') {
          (targetElement as HTMLElement).focus();
        }

        const freshRect = targetElement.getBoundingClientRect();
        const pointX = Math.round(freshRect.left + (freshRect.width > 0 ? freshRect.width / 2 : effectiveBbox.w / 2));
        const pointY = Math.round(freshRect.top + (freshRect.height > 0 ? freshRect.height / 2 : effectiveBbox.h / 2));

        const eventInit: PointerEventInit = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: pointX,
          clientY: pointY,
          screenX: window.screenX + pointX,
          screenY: window.screenY + pointY,
          button: 0,
          buttons: 1,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
        };

        const mouseInit: MouseEventInit = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: pointX,
          clientY: pointY,
          screenX: window.screenX + pointX,
          screenY: window.screenY + pointY,
          button: 0,
          buttons: 1,
        };

        // Hover & Focus
        targetElement.dispatchEvent(new PointerEvent('pointerover', { ...eventInit, buttons: 0 }));
        targetElement.dispatchEvent(new MouseEvent('mouseover', { ...mouseInit, buttons: 0 }));

        // Down
        targetElement.dispatchEvent(new PointerEvent('pointerdown', eventInit));
        targetElement.dispatchEvent(new MouseEvent('mousedown', mouseInit));

        // Up
        const upEventInit: PointerEventInit = { ...eventInit, buttons: 0 };
        const upMouseInit: MouseEventInit = { ...mouseInit, buttons: 0 };
        targetElement.dispatchEvent(new PointerEvent('pointerup', upEventInit));
        targetElement.dispatchEvent(new MouseEvent('mouseup', upMouseInit));

        // Dispatch full MouseEvent 'click' for framework listeners (React, Vue, etc.)
        targetElement.dispatchEvent(new MouseEvent('click', upMouseInit));

        // Trigger native element click method
        if (typeof (targetElement as HTMLElement).click === 'function') {
          (targetElement as HTMLElement).click();
        }

        // Guarantee checked state for radio buttons and checkboxes (including React controlled and Bootstrap/Tailwind custom radios)
        const applyChecked = (input: HTMLInputElement) => {
          const proto = Object.getPrototypeOf(input);
          const setter = Object.getOwnPropertyDescriptor(proto, 'checked')?.set;
          if (setter) {
            setter.call(input, true);
          } else {
            input.checked = true;
          }
          input.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        };

        if (targetElement instanceof HTMLInputElement && (targetElement.type === 'radio' || targetElement.type === 'checkbox')) {
          applyChecked(targetElement);
        } else if (targetElement instanceof HTMLLabelElement) {
          const forId = targetElement.getAttribute('for') || targetElement.htmlFor;
          if (forId) {
            const linkedInput = document.getElementById(forId) as HTMLInputElement | null;
            if (linkedInput && (linkedInput.type === 'radio' || linkedInput.type === 'checkbox')) {
              applyChecked(linkedInput);
            }
          }
        }

        console.log(`[Nexus Privacy Agent] ✅ Successfully clicked: ${targetLabel}`);
      } else if (action.action === 'type') {
        // Handle input typing
        if (typeof (targetElement as HTMLElement).focus === 'function') {
          (targetElement as HTMLElement).focus();
        }

        const textToType = action.value || '';
        const inputElem =
          targetElement instanceof HTMLInputElement || targetElement instanceof HTMLTextAreaElement
            ? targetElement
            : (targetElement.querySelector?.('input, textarea') as HTMLInputElement | HTMLTextAreaElement | null);

        if (inputElem) {
          if (typeof inputElem.focus === 'function') {
            inputElem.focus();
          }
          try {
            document.execCommand('insertText', false, textToType);
          } catch {}
          if (typeof (inputElem as HTMLInputElement).select === 'function') {
            try {
              (inputElem as HTMLInputElement).select();
            } catch {}
          }
          // React synthetic event compatibility
          const proto = Object.getPrototypeOf(inputElem);
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) {
            setter.call(inputElem, textToType);
          } else {
            inputElem.value = textToType;
          }

          inputElem.dispatchEvent(new Event('input', { bubbles: true }));
          try {
            inputElem.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: textToType }));
          } catch {}
          inputElem.dispatchEvent(new Event('change', { bubbles: true }));

          // For custom components (React-Select, React Datepicker), commit with Enter and close popups with Escape
          try {
            inputElem.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            inputElem.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            inputElem.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
          } catch {}
        } else if ((targetElement as HTMLElement).isContentEditable) {
          targetElement.textContent = textToType;
        } else {
          console.warn(`[Nexus Privacy Agent] Target element is neither an input nor contentEditable; skipped setting textContent to prevent overwriting label/UI elements.`);
        }

        console.log(`[Nexus Privacy Agent] ✅ Successfully typed "${textToType}" into ${targetLabel}`);
      } else if (action.action === 'scroll') {
        window.scrollBy({
          top: effectiveBbox.y,
          left: effectiveBbox.x,
          behavior: 'smooth',
        });
        console.log(`[Nexus Privacy Agent] ✅ Scrolled to:`, effectiveBbox);
      } else if (action.action === 'select') {
        const preferredValue = (action.value || '').trim();

        // 1. Native <select> element
        if (targetElement instanceof HTMLSelectElement) {
          const valLower = preferredValue.toLowerCase();
          const options = Array.from(targetElement.options);
          const matched = options.find((o) =>
            o.text.toLowerCase().trim() === valLower ||
            o.value.toLowerCase().trim() === valLower ||
            o.text.toLowerCase().includes(valLower)
          ) || options[1] || options[0];

          if (matched) {
            targetElement.value = matched.value;
            targetElement.dispatchEvent(new Event('input', { bubbles: true }));
            targetElement.dispatchEvent(new Event('change', { bubbles: true }));
            console.log(`[Nexus Privacy Agent] ✅ Selected "${matched.text}" in native select`);
          }
        } else {
          // 2. Custom dropdown component (React-Select, ARIA combobox, Bootstrap/MUI dropdown, etc.)
          const clickableControl =
            (targetElement.querySelector?.('[class*="-control"]') as HTMLElement | null) ||
            (targetElement as HTMLElement);

          if (typeof clickableControl.scrollIntoView === 'function') {
            clickableControl.scrollIntoView({ behavior: 'auto', block: 'nearest' });
          }

          // Trigger dropdown open via realistic mouse events on the control
          const cRect = clickableControl.getBoundingClientRect();
          const ptX = Math.round(cRect.left + (cRect.width > 0 ? cRect.width / 2 : 10));
          const ptY = Math.round(cRect.top + (cRect.height > 0 ? cRect.height / 2 : 10));
          clickableControl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: ptX, clientY: ptY, button: 0, buttons: 1 }));
          clickableControl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: ptX, clientY: ptY, button: 0, buttons: 0 }));
          clickableControl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: ptX, clientY: ptY, button: 0, buttons: 0 }));
          if (typeof clickableControl.click === 'function') {
            clickableControl.click();
          }

          // Wait for options menu to render in DOM
          await new Promise((r) => setTimeout(r, 350));

          const valLower = preferredValue.toLowerCase();
          const optionElements = Array.from(
            document.querySelectorAll<HTMLElement>('[id*="-option-"], [role="option"], [class*="-option"], .dropdown-item, .select-option')
          ).filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });

          const matchedOption = optionElements.find((opt) => {
            const txt = (opt.textContent || '').toLowerCase().trim();
            return txt === valLower || txt.includes(valLower) || (valLower.length > 2 && valLower.includes(txt));
          }) || optionElements[0]; // fallback to first valid option if preferred value not in menu

          if (matchedOption) {
            matchedOption.scrollIntoView?.({ behavior: 'auto', block: 'nearest' });
            matchedOption.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            matchedOption.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
            matchedOption.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            if (typeof matchedOption.click === 'function') matchedOption.click();
            console.log(`[Nexus Privacy Agent] ✅ Selected custom dropdown option: "${matchedOption.textContent?.trim()}"`);
          } else {
            // Fallback: if there is an inner input, type the value and hit Enter
            const innerInput = targetElement.querySelector?.('input') as HTMLInputElement | null;
            if (innerInput && preferredValue) {
              innerInput.focus();
              const proto = Object.getPrototypeOf(innerInput);
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (setter) setter.call(innerInput, preferredValue);
              else innerInput.value = preferredValue;
              innerInput.dispatchEvent(new Event('input', { bubbles: true }));
              innerInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
              innerInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            }
          }
        }
      }
    } else {
      // Fallback coordinate click if no element was returned by elementFromPoint
      const eventInit = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: centerX,
        clientY: centerY,
      };
      document.dispatchEvent(new MouseEvent('click', eventInit));
      console.log(`[Nexus Privacy Agent] ✅ Coordinate fallback click dispatched at (${centerX}, ${centerY})`);
    }

    // Brief dwell to view completed action
    await new Promise((resolve) => setTimeout(resolve, 300));

    return {
      stepIndex,
      action,
      status: 'SUCCESS',
      message: `Executed '${action.action}' on ${targetLabel} successfully.`,
      timestamp: Date.now(),
    };
  } catch (err: any) {
    console.error(`[Nexus Privacy Agent] Execution error on step ${stepIndex}:`, err);
    return {
      stepIndex,
      action,
      status: 'FAILED',
      message: `Execution failed: ${err?.message || err}`,
      timestamp: Date.now(),
    };
  } finally {
    removeHighlight();
  }
}

/**
 * Executes a full plan array step-by-step.
 */
export async function executePlan(
  actions: PlanAction[],
  auditLog?: AuditLogEntry[]
): Promise<ExecutionReport> {
  const results: ExecutionStepResult[] = [];
  let success = true;

  console.log(`[Nexus Privacy Agent] Starting plan execution (${actions.length} action(s))...`);

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (!action) continue;
    const result = await executeAction(action, i, auditLog);
    results.push(result);

    if (result.status === 'FAILED' || result.status === 'BLOCKED') {
      success = false;
      console.warn(`[Nexus Privacy Agent] Plan execution interrupted at step ${i + 1}: ${result.message}`);
      break;
    }

    // Inter-step delay for realistic interaction pacing
    if (i < actions.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  return {
    totalSteps: actions.length,
    executedSteps: results.length,
    results,
    completedAt: Date.now(),
    success,
  };
}

export default defineUnlistedScript(() => {});
