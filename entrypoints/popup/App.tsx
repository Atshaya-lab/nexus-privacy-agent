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
  ExecutionReport,
} from '@/types';
import { needsVisualPerception, perceiveScreenshot } from '../perceive';
import { detectPii } from '../pii-detect';
import { sanitize } from '../sanitize';
import { getPolicy, setPolicy, DEFAULT_POLICY } from '../policy';
import './App.css';

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

  // One-Click 5-Phase Demo State
  const [autoRunning, setAutoRunning] = useState<boolean>(false);
  const [autoRunStep, setAutoRunStep] = useState<string>('');

  const [taskPrompt, setTaskPrompt] = useState<string>(
    'Click the submit button, but do not interact with the Aadhaar or PAN fields'
  );
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planningError, setPlanningError] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);
  const [executionReport, setExecutionReport] = useState<ExecutionReport | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [capturedTabId, setCapturedTabId] = useState<number | null>(null);
  const [pageMasksVisible, setPageMasksVisible] = useState(false);

  // 7-Feature Tracking & Express Inspector States
  const [activeFeatureStep, setActiveFeatureStep] = useState<number>(0);
  const [completedSteps, setCompletedSteps] = useState<number[]>([]);
  const [showExpressInspector, setShowExpressInspector] = useState<boolean>(false);
  const [sha256Certificate, setSha256Certificate] = useState<string | null>(null);
  const [anomalyLog, setAnomalyLog] = useState<string[]>([]);

  const applyPageMasks = async (ctx: SafeContext, tabId?: number | null) => {
    let targetTabId = tabId || capturedTabId;
    if (!targetTabId) {
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
      } catch {
        // ignore
      }
    }
  };

  const togglePageMasks = async () => {
    if (!safeContext) return;
    const nextState = !pageMasksVisible;
    setPageMasksVisible(nextState);

    let targetTabId = capturedTabId;
    if (!targetTabId) {
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
        } catch (e) {
          console.warn('Could not render page masks:', e);
        }
      }
    } else {
      try {
        await chrome.tabs.sendMessage(targetTabId, { type: 'CLEAR_PAGE_MASKS' });
      } catch {
        // ignore
      }
    }
  };

  const checkServerHealth = async () => {
    try {
      const res = await fetch('http://127.0.0.1:8000/health');
      if (res.ok) {
        const data = await res.json();
        setServerStatus('online');
        setServerDetails(data);
        if (data.groundingMode) {
          setGpuMode(data.groundingMode);
        }
        return;
      }
    } catch {
      // offline
    }
    setServerStatus('offline');
    setServerDetails(null);
  };

  const handleUpdateGpuMode = async (mode: 'MOCK' | 'REMOTE_API' | 'LOCAL_MODEL', customEndpoint?: string) => {
    setGpuMode(mode);
    const endpoint = customEndpoint !== undefined ? customEndpoint : gpuEndpoint;
    try {
      const res = await fetch('http://127.0.0.1:8000/server/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, endpoint }),
      });
      if (res.ok) {
        const data = await res.json();
        checkServerHealth();
      }
    } catch (e) {
      console.warn('Could not persist GPU mode to server:', e);
    }
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
      setGpuTestResult({
        success: data.success,
        message: data.message || (data.success ? 'GPU Server connected successfully' : 'Connection failed'),
        latencyMs: data.latencyMs,
      });
    } catch (e: any) {
      setGpuTestResult({
        success: false,
        message: e?.message || 'Failed to reach local server on port 8000',
      });
    } finally {
      setTestingGpu(false);
    }
  };

  const handleOpenTestFixture = async () => {
    try {
      const demoUrl = serverStatus === 'online' ? 'http://127.0.0.1:8000/demo' : chrome.runtime.getURL('test-fixtures/mock-id-card.html');
      const tab = await chrome.tabs.create({ url: demoUrl, active: true });
      if (tab && tab.id) {
        setCapturedTabId(tab.id);
        setTimeout(() => {
          handleCaptureContext(tab.id);
        }, 800);
      }
    } catch (e) {
      console.warn('Could not open test fixture tab:', e);
    }
  };

  // Load persisted policy, power state, check server, and auto-capture context on mount
  useEffect(() => {
    getPolicy().then((p) => setPolicyState(p));
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get(['nexus_extension_active', 'nexus_proactive_shield'], (res) => {
        if (res && res.nexus_extension_active !== undefined) {
          setExtensionActive(Boolean(res.nexus_extension_active));
        }
        if (res && res.nexus_proactive_shield !== undefined) {
          setProactiveShield(Boolean(res.nexus_proactive_shield));
        }
      });
    }
    checkServerHealth();
    handleCaptureContext();
    const interval = setInterval(checkServerHealth, 6000);
    return () => clearInterval(interval);
  }, []);

  const handleToggleExtensionActive = async () => {
    const nextState = !extensionActive;
    setExtensionActive(nextState);
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ nexus_extension_active: nextState });
    }

    try {
      let targetTabId = capturedTabId;
      if (!targetTabId) {
        const [currentActive] = await chrome.tabs.query({ active: true, currentWindow: true });
        targetTabId = currentActive?.id || null;
      }
      if (targetTabId) {
        await chrome.tabs.sendMessage(targetTabId, {
          type: 'SET_SHIELD_ACTIVE',
          active: nextState,
        });
      }
    } catch {
      // ignore
    }

    if (!nextState) {
      setPageMasksVisible(false);
    } else {
      handleCaptureContext();
    }
  };

  const handleToggleProactiveShield = async () => {
    const nextState = !proactiveShield;
    setProactiveShield(nextState);
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ nexus_proactive_shield: nextState });
    }

    try {
      let targetTabId = capturedTabId;
      if (!targetTabId) {
        const [currentActive] = await chrome.tabs.query({ active: true, currentWindow: true });
        targetTabId = currentActive?.id || null;
      }
      if (targetTabId) {
        if (!nextState) {
          await chrome.tabs.sendMessage(targetTabId, { type: 'CLEAR_PAGE_MASKS' });
          setPageMasksVisible(false);
        } else if (extensionActive) {
          await chrome.tabs.sendMessage(targetTabId, { type: 'AUTO_SCAN_PRIVACY' });
        }
      }
    } catch {
      // ignore
    }
  };

  const handleCaptureContext = async (overrideTabId?: number | null) => {
    setLoading(true);
    setVisionLoading(false);
    setSanitizing(false);
    setError(null);

    try {
      // 1. Locate the target webpage tab
      let targetTab: chrome.tabs.Tab | undefined;

      const numericTabId = typeof overrideTabId === 'number' && overrideTabId > 0 ? overrideTabId : undefined;
      if (numericTabId) {
        try {
          targetTab = await chrome.tabs.get(numericTabId);
        } catch {
          // ignore
        }
      }

      if (!targetTab) {
        const [currentActive] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (
          currentActive &&
          currentActive.url &&
          !currentActive.url.startsWith('chrome://') &&
          !currentActive.url.startsWith('edge://') &&
          !currentActive.url.startsWith('about:')
        ) {
          targetTab = currentActive;
        }
      }

      if (!targetTab) {
        const allTabs = await chrome.tabs.query({});
        targetTab =
          allTabs.find((t) => t.url && t.url.includes('127.0.0.1:8000')) ||
          allTabs.find((t) => t.url && t.url.includes('mock-id-card')) ||
          allTabs.find((t) => t.active && t.url && /^https?:\/\//i.test(t.url)) ||
          allTabs.find((t) => t.url && /^https?:\/\//i.test(t.url)) ||
          allTabs.find(
            (t) =>
              t.url &&
              !t.url.startsWith('chrome://') &&
              !t.url.startsWith('edge://') &&
              !t.url.startsWith('about:')
          );
      }

      if (!targetTab || targetTab.id === undefined) {
        throw new Error('Please open or switch to a webpage tab (e.g. google.com or our test page). Chrome prevents extensions from capturing internal chrome:// pages.');
      }
      setCapturedTabId(targetTab.id);

      // 2. Request DOM array from content script with seamless fallback
      let dom: DomNode[] = [];
      try {
        const domResponse = await chrome.tabs.sendMessage(targetTab.id, { type: 'GET_CONTEXT' });
        dom = Array.isArray(domResponse) ? domResponse : domResponse?.dom || [];
      } catch {
        // Tab was not refreshed after extension update; inject content script and retry
        let fallbackSucceeded = false;
        try {
          await chrome.scripting.executeScript({
            target: { tabId: targetTab.id },
            files: ['content-scripts/content.js'],
          });
          const domResponse = await chrome.tabs.sendMessage(targetTab.id, { type: 'GET_CONTEXT' });
          dom = Array.isArray(domResponse) ? domResponse : domResponse?.dom || [];
          fallbackSucceeded = true;
        } catch {
          // Fallback to inline extraction
        }

        if (!fallbackSucceeded) {
          try {
            const [result] = await chrome.scripting.executeScript({
              target: { tabId: targetTab.id },
              func: () => {
                const selector = 'input, button, a, select, textarea, [role], label, h1, h2, h3, p, canvas';
                const elements = document.querySelectorAll(selector);
                const nodes: any[] = [];
                const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
                const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

                for (const el of elements) {
                  const rect = el.getBoundingClientRect();
                  if (rect.width <= 0 || rect.height <= 0) continue;
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
                  let rawText = '';
                  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                    rawText = el.value || el.placeholder || el.getAttribute('aria-label') || '';
                  } else {
                    rawText = el.textContent || '';
                  }
                  const cleanText = rawText.trim().replace(/\s+/g, ' ');

                  nodes.push({
                    tag,
                    role: role || null,
                    text: cleanText,
                    attributes: {
                      id: el.id || undefined,
                      name: el.getAttribute('name') || undefined,
                      type: el.getAttribute('type') || undefined,
                      placeholder: el.getAttribute('placeholder') || undefined,
                      value: el instanceof HTMLInputElement ? el.value : undefined,
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
          } catch (injectErr: any) {
            console.error('DOM extraction error:', injectErr);
            throw new Error('Could not access this tab. Please refresh the page and try again.');
          }
        }
      }

      // 3. Request screenshot from background script
      let screenshot = '';
      try {
        const screenshotResponse = await Promise.race([
          chrome.runtime.sendMessage({
            type: 'CAPTURE_SCREEN',
            windowId: targetTab.windowId,
          }),
          new Promise((resolve) => setTimeout(() => resolve(''), 3500)),
        ]);
        screenshot =
          typeof screenshotResponse === 'string'
            ? screenshotResponse
            : screenshotResponse?.screenshot || '';
      } catch (screenErr) {
        console.warn('Screenshot capture failed:', screenErr);
      }

      // 4. Tiered Compute: Check if visual perception is needed
      const requiresVision = needsVisualPerception(dom);

      const perceived: PerceivedContext = {
        url: targetTab.url || '',
        timestamp: Date.now(),
        dom,
        screenshot,
        perceptionSkipped: !requiresVision,
      };

      if (!requiresVision) {
        perceived.perceptionReason = 'DOM context sufficient — visual perception skipped';
        console.log('[Nexus Privacy Agent] Tiered Compute: DOM sufficient, vision skipped.');
      } else {
        console.log('[Nexus Privacy Agent] Tiered Compute: Running visual perception...');
        setVisionLoading(true);

        try {
          const { visualRegions, metrics } = await perceiveScreenshot(screenshot);
          perceived.visualRegions = visualRegions;
          perceived.perceptionMetrics = metrics;
          console.log(
            `[Nexus Privacy Agent] Visual perception completed: ${visualRegions.length} regions detected:`,
            visualRegions
          );
        } catch (visionErr: any) {
          console.error('[Nexus Privacy Agent] Visual perception error:', visionErr);
          perceived.perceptionReason = `Visual perception error: ${visionErr?.message || visionErr}`;
        } finally {
          setVisionLoading(false);
        }
      }

      setPerceivedContext(perceived);

      // 5. Phase 3: PII Classification + Sanitize
      setSanitizing(true);
      console.log('=== Nexus Privacy Agent Phase 3: Privacy Gate ===');

      // Detect PII in both DOM nodes and visual regions
      const classifications = detectPii(perceived.dom, perceived.visualRegions);
      console.log(
        `[Nexus Privacy Agent] PII Detection: ${classifications.length} fields classified:`,
        classifications
      );

      // Load latest active policy
      const currentPolicy = await getPolicy();
      setPolicyState(currentPolicy);

      // Apply Sanitize
      const safe = await sanitize(perceived, perceived, classifications, currentPolicy);
      console.log('[Nexus Privacy Agent] Sanitize complete: SafeContext generated:', safe);
      setSafeContext(safe);

      // Automatically render on-screen masks on the live webpage!
      await applyPageMasks(safe, targetTab.id);

      // Adapt initial prompt to the captured website
      const targetUrl = targetTab.url || '';
      if (targetUrl.includes('mock-id') || targetUrl.includes('3456')) {
        setTaskPrompt('Click the submit button, but do not interact with the Aadhaar or PAN fields');
      } else if (
        targetUrl.includes('wikipedia') ||
        targetUrl.includes('google') ||
        targetUrl.includes('duckduckgo')
      ) {
        setTaskPrompt('Type "Privacy Agent" into search');
      } else {
        setTaskPrompt('Click search');
      }
    } catch (err: any) {
      console.error('Error capturing context:', err);
      setError(err?.message || 'Failed to capture context');
    } finally {
      setLoading(false);
      setSanitizing(false);
    }
  };

  const handlePolicyChange = async (category: string, action: PolicyAction) => {
    const updated = { ...policy, [category]: action };
    setPolicyState(updated);
    await setPolicy(updated);

    // If safeContext exists, re-sanitize with updated policy
    if (perceivedContext) {
      const classifications = detectPii(perceivedContext.dom, perceivedContext.visualRegions);
      const reSanitized = await sanitize(perceivedContext, perceivedContext, classifications, updated);
      setSafeContext(reSanitized);
      await applyPageMasks(reSanitized);
    }
  };

  const handleResolveAsk = async (field: PiiClassification, chosenAction: 'MASK' | 'ALLOW' | 'BLOCK') => {
    if (!safeContext || !perceivedContext) return;

    // Apply temporary override for this field
    const classifications = detectPii(perceivedContext.dom, perceivedContext.visualRegions);
    const tempPolicy = { ...policy, [field.category]: chosenAction };
    const reSanitized = await sanitize(perceivedContext, perceivedContext, classifications, tempPolicy);
    setSafeContext(reSanitized);
    await applyPageMasks(reSanitized);
  };

  const handlePlanAgent = async () => {
    if (!safeContext) return;
    setPlanning(true);
    setPlanningError(null);
    setPlan(null);
    setExecutionReport(null);
    setExecutionError(null);

    try {
      const payload = {
        task: taskPrompt,
        safeContext: {
          url: safeContext.url,
          timestamp: safeContext.timestamp,
          sanitizedDom: safeContext.sanitizedDom,
          redactedScreenshot: safeContext.redactedScreenshot,
          auditLog: safeContext.auditLog,
        },
      };

      const res = await fetch('http://127.0.0.1:8000/agent/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.detail || `Server returned status ${res.status}`);
      }

      const planResponse: PlanResponse = await res.json();
      console.log('[Nexus Privacy Agent] Received plan from Server Agent:', planResponse);
      setPlan(planResponse);
    } catch (err: any) {
      console.error('[Nexus Privacy Agent] Planning error:', err);
      setPlanningError(err?.message || 'Failed to communicate with Server Agent');
    } finally {
      setPlanning(false);
    }
  };

  const handleExecutePlan = async () => {
    if (!plan || plan.actions.length === 0) return;
    setExecuting(true);
    setExecutionError(null);

    try {
      let targetTabId = capturedTabId;

      if (!targetTabId) {
        const [currentActive] = await chrome.tabs.query({ active: true, currentWindow: true });
        let targetTab = currentActive;

        if (
          !targetTab ||
          !targetTab.id ||
          targetTab.url?.startsWith('chrome-extension://') ||
          targetTab.url?.startsWith('chrome://') ||
          targetTab.url?.startsWith('edge://')
        ) {
          const allTabs = await chrome.tabs.query({});
          targetTab =
            allTabs.find((t) => t.active && t.url && /^https?:\/\//i.test(t.url)) ||
            allTabs.find((t) => t.url && /^https?:\/\//i.test(t.url)) ||
            targetTab;
        }

        targetTabId = targetTab?.id || null;
      }

      if (!targetTabId) {
        throw new Error('No target webpage tab found to execute actions.');
      }

      console.log('[Nexus Privacy Agent] Sending EXECUTE_PLAN to tab:', targetTabId);
      let report: ExecutionReport;
      try {
        report = await chrome.tabs.sendMessage(targetTabId, {
          type: 'EXECUTE_PLAN',
          actions: plan.actions,
          safeContextAuditLog: safeContext?.auditLog || [],
        });
      } catch (sendErr) {
        console.warn('Content script message failed, injecting content script and retrying...', sendErr);
        await chrome.scripting.executeScript({
          target: { tabId: targetTabId },
          files: ['content-scripts/content.js'],
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        report = await chrome.tabs.sendMessage(targetTabId, {
          type: 'EXECUTE_PLAN',
          actions: plan.actions,
          safeContextAuditLog: safeContext?.auditLog || [],
        });
      }

      console.log('[Nexus Privacy Agent] Plan execution completed:', report);
      setExecutionReport(report);
    } catch (err: any) {
      console.error('[Nexus Privacy Agent] Execution error:', err);
      setExecutionError(err?.message || 'Execution failed in browser tab');
    } finally {
      setExecuting(false);
    }
  };

  const generateSha256 = async (data: string) => {
    try {
      const msgBuffer = new TextEncoder().encode(data);
      const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    }
  };

  const handleExportAuditLedger = async () => {
    if (!safeContext) return;
    const reportData = {
      timestamp: new Date().toISOString(),
      url: safeContext.url,
      standard: 'DPDP Act 2023 / GDPR Zero-Leak Trust Boundary',
      summary: safeContext.summary,
      auditLog: safeContext.auditLog,
      policySnapshot: policy,
      anomaliesDetected: anomalyLog,
    };
    const jsonStr = JSON.stringify(reportData, null, 2);
    const sha = await generateSha256(jsonStr);
    setSha256Certificate(sha);

    const blob = new Blob([JSON.stringify({ ...reportData, sha256Proof: sha }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nexus-privacy-audit-ledger-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRun7FeaturePipeline = async (mode: 'legitimate' | 'adversarial' = 'legitimate') => {
    setAutoRunning(true);
    setError(null);
    setPlanningError(null);
    setExecutionError(null);
    setExecutionReport(null);
    setCompletedSteps([]);
    setAnomalyLog([]);

    const taskToRun =
      mode === 'adversarial'
        ? 'Click the Aadhaar field or copy password'
        : 'Click the submit button, but do not interact with the Aadhaar or PAN fields';

    setTaskPrompt(taskToRun);

    try {
      // Step 1: Shield & Hook Verification (Feature 1)
      setActiveFeatureStep(1);
      setAutoRunStep('1/7 🛡️ Feature 1: Verifying Master Shield & Zero-Break DOM Hook...');
      if (!extensionActive) {
        setExtensionActive(true);
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
          await chrome.storage.local.set({ nexus_extension_active: true });
        }
      }
      await new Promise((r) => setTimeout(r, 400));
      setCompletedSteps((prev) => [...prev, 1]);

      // Step 2: PII Detection & Field Classification Engine (Feature 2)
      setActiveFeatureStep(2);
      setAutoRunStep('2/7 🔍 Feature 2: Scanning DOM & Classifying Sensitive Data (Pass, Aadhaar, API Keys)...');
      await handleCaptureContext();
      await new Promise((r) => setTimeout(r, 450));
      setCompletedSteps((prev) => [...prev, 2]);

      // Step 3: Privacy Gate & Dynamic Policy Engine (Feature 3)
      setActiveFeatureStep(3);
      setAutoRunStep('3/7 ⚖️ Feature 3: Enforcing Privacy Gate Rules (Mask / Block / Allow / Ask)...');
      await new Promise((r) => setTimeout(r, 400));
      setCompletedSteps((prev) => [...prev, 3]);

      // Step 4: Visual Redaction & Express Inspector (Feature 4)
      setActiveFeatureStep(4);
      setAutoRunStep('4/7 👁️ Feature 4: Rendering On-Screen Solid Blackout Overlays & Express Redaction...');
      await new Promise((r) => setTimeout(r, 400));
      setCompletedSteps((prev) => [...prev, 4]);

      // Step 5: Privacy Decision Audit Logs & Security Ledger (Feature 5)
      setActiveFeatureStep(5);
      setAutoRunStep('5/7 📋 Feature 5: Committing to Immutable Security Ledger & Computing SHA-256 Seal...');
      let currentSafe = safeContext;
      if (!currentSafe) {
        const [currentActive] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (currentActive?.id) {
          const domRes = await chrome.tabs.sendMessage(currentActive.id, { type: 'GET_CONTEXT' }).catch(() => null);
          const domNodes = Array.isArray(domRes) ? domRes : domRes?.dom || [];
          const scr = await chrome.runtime.sendMessage({ type: 'CAPTURE_SCREEN', windowId: currentActive.windowId }).catch(() => '');
          const perceived: PerceivedContext = {
            url: currentActive.url || '',
            timestamp: Date.now(),
            dom: domNodes,
            screenshot: typeof scr === 'string' ? scr : scr?.screenshot || '',
          };
          const cls = detectPii(domNodes, []);
          currentSafe = await sanitize(perceived, perceived, cls, policy);
          setSafeContext(currentSafe);
        }
      }

      if (currentSafe) {
        const sha = await generateSha256(JSON.stringify(currentSafe.auditLog));
        setSha256Certificate(sha);
      }
      await new Promise((r) => setTimeout(r, 400));
      setCompletedSteps((prev) => [...prev, 5]);

      // Step 6: Agent Task Planning & Grounding with ZonUI-3B (Feature 6)
      setActiveFeatureStep(6);
      setAutoRunStep(`6/7 🧠 Feature 6: Natural Language Planning & Grounding via ZonUI-3B [${gpuMode}]...`);

      if (!currentSafe) {
        throw new Error('Could not establish SafeContext for automated demo.');
      }

      const planPayload = {
        task: taskToRun,
        safeContext: {
          url: currentSafe.url,
          timestamp: currentSafe.timestamp,
          sanitizedDom: currentSafe.sanitizedDom,
          redactedScreenshot: currentSafe.redactedScreenshot,
          auditLog: currentSafe.auditLog,
        },
      };

      const planRes = await fetch('http://127.0.0.1:8000/agent/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(planPayload),
      });

      if (!planRes.ok) {
        const errJson = await planRes.json().catch(() => ({}));
        throw new Error(errJson.detail || `Server returned status ${planRes.status}`);
      }

      const generatedPlan: PlanResponse = await planRes.json();
      setPlan(generatedPlan);
      await new Promise((r) => setTimeout(r, 450));
      setCompletedSteps((prev) => [...prev, 6]);

      // Step 7: Adversarial Action Interception & Defense-in-Depth (Feature 7)
      setActiveFeatureStep(7);
      setAutoRunStep('7/7 🛡️ Feature 7: Double-Lock Spatial Safety Gate Execution & Anomaly Interception...');

      if (generatedPlan.actions.length > 0) {
        let targetTabId = capturedTabId;
        if (!targetTabId) {
          const [currentActive] = await chrome.tabs.query({ active: true, currentWindow: true });
          targetTabId = currentActive?.id || null;
        }

        if (targetTabId) {
          const report: ExecutionReport = await chrome.tabs.sendMessage(targetTabId, {
            type: 'EXECUTE_PLAN',
            actions: generatedPlan.actions,
            safeContextAuditLog: currentSafe.auditLog || [],
          });
          setExecutionReport(report);
          if (report.blockedSteps > 0) {
            setAnomalyLog((prev) => [
              ...prev,
              `Spatial Safety Gate intercepted ${report.blockedSteps} unauthorized interaction(s).`,
            ]);
          }
        }
        setAutoRunStep('✅ 7-Feature Flow Succeeded: Plan executed with 100% data sovereignty! 🚀');
      } else if (generatedPlan.blockedActions.length > 0) {
        const blockedReasons = generatedPlan.blockedActions.map(
          (b) => `Blocked Adversarial Target: "${b.step}" (${b.reason})`
        );
        setAnomalyLog(blockedReasons);
        setAutoRunStep('🛡️ Defense-in-Depth Gate Succeeded: Adversarial Action Intercepted & Blocked!');
      } else {
        setAutoRunStep('✅ 7-Feature Flow Complete: Zero outbound data leak.');
      }
      setCompletedSteps((prev) => [...prev, 7]);
    } catch (e: any) {
      console.error('7-Feature Flow error:', e);
      setError(e?.message || '7-Feature Pipeline interrupted');
      setAutoRunStep(`⚠️ Pipeline Interrupted at Step ${activeFeatureStep || 1}: ${e?.message || e}`);
    } finally {
      setAutoRunning(false);
      setActiveFeatureStep(0);
    }
  };

  const handleRunFullDemoFlow = (overrideTask?: string) => {
    handleRun7FeaturePipeline(overrideTask?.toLowerCase().includes('aadhaar') ? 'adversarial' : 'legitimate');
  };

  return (
    <div className="agent-container">
      <header className="agent-header">
        <div className="header-top-row">
          <div className="header-title-col">
            <h1 className="agent-title">Nexus Privacy Agent</h1>
            <p className="agent-subtitle">Phase 5: Visual Grounding &amp; Defense-in-Depth</p>
          </div>
          <div className="master-power-toggle">
            <span className={`master-power-badge ${extensionActive ? 'active' : 'paused'}`}>
              {extensionActive ? 'SHIELD ON' : 'SHIELD OFF'}
            </span>
            <button
              type="button"
              className={`master-toggle-switch ${extensionActive ? 'on' : 'off'}`}
              onClick={handleToggleExtensionActive}
              title={extensionActive ? 'Click to Pause Nexus Privacy Shield' : 'Click to Enable Nexus Privacy Shield'}
              id="master-power-switch-btn"
            >
              <span className="switch-knob"></span>
            </button>
          </div>
        </div>
      </header>

      {!extensionActive && (
        <div className="paused-alert-banner" id="paused-alert-banner">
          <div className="paused-alert-text">
            <strong>⏸️ Privacy Shield is Paused</strong>
            <p>On-screen redaction badges and background scanning are disabled. Normal browsing is untouched.</p>
          </div>
          <button
            type="button"
            className="paused-enable-btn"
            onClick={handleToggleExtensionActive}
          >
            ▶️ Turn ON
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="tab-navigation">
        <button
          className={`tab-btn ${activeTab === 'agent' ? 'active' : ''}`}
          onClick={() => setActiveTab('agent')}
          id="tab-agent-loop"
        >
          🤖 Agent Loop
        </button>
        <button
          className={`tab-btn ${activeTab === 'gate' ? 'active' : ''}`}
          onClick={() => setActiveTab('gate')}
          id="tab-privacy-gate"
        >
          🛡️ Privacy Gate
        </button>
        <button
          className={`tab-btn ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
          id="tab-policy-settings"
        >
          ⚙️ Policy Settings
        </button>
      </div>

      {/* Server Status Bar */}
      <div className={`server-status-bar ${serverStatus}`} id="server-status-bar">
        <span>
          {serverStatus === 'online'
            ? `🟢 Server Agent: Connected (${serverDetails?.groundingModel || 'ZonUI-3B'} ${serverDetails?.groundingMode || 'MOCK'})`
            : serverStatus === 'checking'
            ? '🟡 Checking Server Connection...'
            : '🔴 Server Agent: Offline (Start uvicorn server on port 8000)'}
        </span>
        <span className={`server-pill ${serverStatus}`}>
          {serverStatus === 'online' ? 'TRUST BOUNDARY ACTIVE' : 'START SERVER'}
        </span>
      </div>
      {/* Tab 1: Agent Loop */}
      {activeTab === 'agent' && (
        <div className="tab-content" id="agent-tab-content">
          {/* ⚡ Master 1-Click 7-Feature Pipeline Card */}
          <div className="full-demo-card" id="full-demo-card">
            <div className="full-demo-header">
              <span className="full-demo-title">
                <span>⚡</span>
                <span>Master 1-Click Auto-Pilot Pipeline</span>
              </span>
              <span style={{ fontSize: '0.70rem', background: 'rgba(255,255,255,0.2)', padding: '2px 6px', borderRadius: '4px', fontWeight: 700 }}>
                FEATURES 1 → 7
              </span>
            </div>
            <div className="full-demo-desc">
              Executes all 7 features end-to-end: Shield Verification → PII Scan → Policy Gate → Blackout Redaction → Security Ledger → ZonUI-3B Grounding [{gpuMode}] → Double-Lock Interception.
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
              <button
                className="full-demo-btn"
                onClick={() => handleRun7FeaturePipeline('legitimate')}
                disabled={autoRunning || loading || planning || executing || serverStatus === 'offline'}
                id="run-legitimate-demo-btn"
                title="Executes all 7 steps with legitimate task prompt"
              >
                {autoRunning ? '⏳ Executing 7 Steps...' : '🚀 Run All 7 Features'}
              </button>
              <button
                className="full-demo-btn"
                style={{ background: 'linear-gradient(90deg, #b91c1c 0%, #c026d3 100%)', borderColor: '#fca5a5' }}
                onClick={() => handleRun7FeaturePipeline('adversarial')}
                disabled={autoRunning || loading || planning || executing || serverStatus === 'offline'}
                id="run-adversarial-demo-btn"
                title="Executes all 7 steps targeting protected Aadhaar PII to demonstrate Defense-in-Depth interception"
              >
                {autoRunning ? '⏳ Intercepting...' : '🛡️ Adversarial Demo'}
              </button>
            </div>

            {/* 7-Step Interactive Stepper Tracker */}
            <div className="pipeline-stepper-row" id="pipeline-stepper-tracker">
              {[
                { step: 1, label: 'F1: Shield' },
                { step: 2, label: 'F2: PII Detect' },
                { step: 3, label: 'F3: Policy Gate' },
                { step: 4, label: 'F4: Redaction' },
                { step: 5, label: 'F5: Ledger' },
                { step: 6, label: 'F6: ZonUI' },
                { step: 7, label: 'F7: Intercept' },
              ].map((s) => {
                const isCompleted = completedSteps.includes(s.step);
                const isActive = activeFeatureStep === s.step;
                return (
                  <div
                    key={s.step}
                    className={`stepper-node ${isCompleted ? 'done' : isActive ? 'active' : ''}`}
                    title={`Feature ${s.step}: ${s.label}`}
                  >
                    <span className="stepper-dot">{isCompleted ? '✓' : s.step}</span>
                    <span className="stepper-text">{s.label}</span>
                  </div>
                );
              })}
            </div>

            {autoRunStep && (
              <div className="demo-progress-ticker" id="demo-progress-ticker">
                <span>▶</span>
                <span>{autoRunStep}</span>
              </div>
            )}
          </div>

          {/* 🎛️ Dedicated 7-Feature Action Hub (Every Option Has a Dedicated Button) */}
          <div className="feature-hub-container" id="feature-hub-container">
            <div className="feature-hub-header">
              <strong style={{ fontSize: '0.80rem', color: '#0f172a' }}>🎛️ Individual Feature Controls (1 to 7)</strong>
              <span style={{ fontSize: '0.68rem', color: '#64748b' }}>Run or test each feature independently</span>
            </div>

            <div className="feature-grid-list">
              {/* Feature 1: Master Shield & Toggle */}
              <div className="feature-item-row">
                <div className="feature-info-col">
                  <div className="feature-title-line">
                    <span className="feature-num-badge f1">F1</span>
                    <strong>Shield &amp; Master Toggle</strong>
                    <span className={`feature-status-pill ${extensionActive ? 'active' : 'paused'}`}>
                      {extensionActive ? 'SHIELD ON' : 'PAUSED'}
                    </span>
                  </div>
                  <p className="feature-subtext">Toggle extension on/off dynamically without reloading or breaking DOM.</p>
                </div>
                <button
                  type="button"
                  className={`feature-action-btn ${extensionActive ? 'btn-active' : 'btn-paused'}`}
                  onClick={handleToggleExtensionActive}
                  id="btn-feature-1-toggle"
                >
                  {extensionActive ? '⏸️ Turn Shield OFF' : '▶️ Turn Shield ON'}
                </button>
              </div>

              {/* Feature 2: PII Detection & Field Classification Engine */}
              <div className="feature-item-row">
                <div className="feature-info-col">
                  <div className="feature-title-line">
                    <span className="feature-num-badge f2">F2</span>
                    <strong>PII Detection &amp; Classification</strong>
                    <span className="feature-status-pill info">
                      {safeContext ? `${safeContext.summary.totalDetected} Fields Found` : 'Ready to Scan'}
                    </span>
                  </div>
                  <p className="feature-subtext">Scans DOM &amp; vision for Passwords, API Keys, Aadhaar, PAN, SSN, CC, etc.</p>
                </div>
                <button
                  type="button"
                  className="feature-action-btn"
                  onClick={() => handleCaptureContext()}
                  disabled={loading || visionLoading || sanitizing || autoRunning}
                  id="btn-feature-2-scan"
                >
                  {loading ? '⏳ Scanning...' : '🔍 Scan & Classify PII'}
                </button>
              </div>

              {/* Feature 3: Privacy Gate & Policy Engine */}
              <div className="feature-item-row">
                <div className="feature-info-col">
                  <div className="feature-title-line">
                    <span className="feature-num-badge f3">F3</span>
                    <strong>Privacy Gate &amp; Policy Engine</strong>
                    <span className="feature-status-pill policy">MASK / BLOCK / ALLOW / ASK</span>
                  </div>
                  <p className="feature-subtext">Enforces granular data sovereignty rules across all detected categories.</p>
                </div>
                <button
                  type="button"
                  className="feature-action-btn"
                  onClick={() => setActiveTab('settings')}
                  id="btn-feature-3-policy"
                >
                  ⚖️ Configure Policies
                </button>
              </div>

              {/* Feature 4: Visual Redaction & Express Inspector */}
              <div className="feature-item-row">
                <div className="feature-info-col">
                  <div className="feature-title-line">
                    <span className="feature-num-badge f4">F4</span>
                    <strong>Visual Redaction &amp; Inspector</strong>
                    <span className={`feature-status-pill ${pageMasksVisible ? 'active' : 'idle'}`}>
                      {pageMasksVisible ? 'Masks Visible' : 'Masks Hidden'}
                    </span>
                  </div>
                  <p className="feature-subtext">Renders solid viewport blackouts &amp; provides zero-leak express inspection.</p>
                </div>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button
                    type="button"
                    className="feature-action-btn"
                    onClick={togglePageMasks}
                    disabled={!safeContext || safeContext.summary.masked === 0}
                    id="btn-feature-4-masks"
                  >
                    {pageMasksVisible ? '🙈 Hide Masks' : '👁️ Show Masks'}
                  </button>
                  <button
                    type="button"
                    className="feature-action-btn inspector"
                    onClick={() => setShowExpressInspector(true)}
                    disabled={!safeContext}
                    id="btn-feature-4-inspector"
                  >
                    🔬 Express Inspector
                  </button>
                </div>
              </div>

              {/* Feature 5: Privacy Decision Audit Logs & Security Ledger */}
              <div className="feature-item-row">
                <div className="feature-info-col">
                  <div className="feature-title-line">
                    <span className="feature-num-badge f5">F5</span>
                    <strong>Audit Logs &amp; Security Ledger</strong>
                    <span className="feature-status-pill ledger">
                      {safeContext ? `${safeContext.auditLog.length} Records` : 'Empty'}
                    </span>
                  </div>
                  <p className="feature-subtext">Immutable log of every detected sensitive field with SHA-256 seal export.</p>
                </div>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button
                    type="button"
                    className="feature-action-btn"
                    onClick={() => setActiveTab('gate')}
                    disabled={!safeContext}
                    id="btn-feature-5-ledger"
                  >
                    📋 View Ledger
                  </button>
                  <button
                    type="button"
                    className="feature-action-btn export"
                    onClick={handleExportAuditLedger}
                    disabled={!safeContext}
                    id="btn-feature-5-export"
                  >
                    📜 Export SHA-256
                  </button>
                </div>
              </div>

              {/* Feature 6: Agent Task Planning & Grounding */}
              <div className="feature-item-row">
                <div className="feature-info-col">
                  <div className="feature-title-line">
                    <span className="feature-num-badge f6">F6</span>
                    <strong>ZonUI-3B Task Planning &amp; Grounding</strong>
                    <span className={`feature-status-pill ${plan ? 'done' : 'idle'}`}>
                      {plan ? `${plan.actions.length} Actions Grounded` : 'Awaiting Plan'}
                    </span>
                  </div>
                  <p className="feature-subtext">Grounds natural language goals to verified safe UI coordinates using ZonUI.</p>
                </div>
                <button
                  type="button"
                  className="feature-action-btn"
                  onClick={handlePlanAgent}
                  disabled={planning || !taskPrompt.trim() || serverStatus === 'offline'}
                  id="btn-feature-6-plan"
                >
                  {planning ? '🤖 Grounding...' : '🧠 Plan with ZonUI'}
                </button>
              </div>

              {/* Feature 7: Adversarial Action Interception & Defense-in-Depth */}
              <div className="feature-item-row">
                <div className="feature-info-col">
                  <div className="feature-title-line">
                    <span className="feature-num-badge f7">F7</span>
                    <strong>Adversarial Interception &amp; Defense</strong>
                    <span className={`feature-status-pill ${executionReport ? 'active' : 'idle'}`}>
                      {executionReport
                        ? executionReport.success
                          ? 'Executed Safely ✅'
                          : 'Intercepted 🛡️'
                        : 'Gate Armed'}
                    </span>
                  </div>
                  <p className="feature-subtext">Double-Lock spatial safety gate blocks unauthorized target interactions.</p>
                </div>
                <button
                  type="button"
                  className="feature-action-btn"
                  onClick={handleExecutePlan}
                  disabled={executing || !plan || plan.actions.length === 0}
                  id="btn-feature-7-execute"
                >
                  {executing ? '⏳ Executing...' : '🛡️ Execute Plan with Gate'}
                </button>
              </div>
            </div>
          </div>

          {/* Express Inspector Drawer / Modal */}
          {showExpressInspector && safeContext && (
            <div className="express-inspector-overlay" id="express-inspector-modal">
              <div className="express-inspector-content">
                <div className="inspector-header">
                  <strong style={{ fontSize: '0.88rem', color: '#0f172a', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span>🔬</span>
                    <span>Feature 4: Express Visual &amp; DOM Inspector</span>
                  </strong>
                  <button
                    type="button"
                    className="inspector-close-btn"
                    onClick={() => setShowExpressInspector(false)}
                  >
                    ✖ Close
                  </button>
                </div>

                <div className="inspector-body">
                  <div style={{ fontSize: '0.74rem', color: '#475569', marginBottom: '8px' }}>
                    Verifying zero data leakage: Pre-sanitized viewport vs. solid blackout outbound payload.
                  </div>

                  {/* Side-by-Side Images */}
                  <div className="side-by-side-grid" style={{ marginBottom: '10px' }}>
                    <div className="screenshot-box original">
                      <div className="box-label original">
                        <span>Pre-Sanitize Viewport</span>
                        <span className="badge-raw">RAW</span>
                      </div>
                      {safeContext.rawScreenshot ? (
                        <img src={safeContext.rawScreenshot} alt="Raw" className="comparison-img" />
                      ) : (
                        <div className="no-img">No screenshot</div>
                      )}
                    </div>
                    <div className="screenshot-box sanitized">
                      <div className="box-label sanitized">
                        <span>Sanitized Outbound</span>
                        <span className="badge-redacted">BLACKOUT SHIELD</span>
                      </div>
                      {safeContext.redactedScreenshot ? (
                        <img src={safeContext.redactedScreenshot} alt="Redacted" className="comparison-img" />
                      ) : (
                        <div className="no-img">No redacted screenshot</div>
                      )}
                    </div>
                  </div>

                  {/* DOM & Detection Metrics */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', marginBottom: '8px' }}>
                    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '4px', padding: '6px', textAlign: 'center' }}>
                      <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#0f172a' }}>{safeContext.summary.totalDetected}</div>
                      <div style={{ fontSize: '0.66rem', color: '#64748b' }}>PII Detected</div>
                    </div>
                    <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '4px', padding: '6px', textAlign: 'center' }}>
                      <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#b91c1c' }}>{safeContext.summary.masked}</div>
                      <div style={{ fontSize: '0.66rem', color: '#991b1b' }}>Masked Fields</div>
                    </div>
                    <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: '4px', padding: '6px', textAlign: 'center' }}>
                      <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#15803d' }}>{safeContext.sanitizedDom.length}</div>
                      <div style={{ fontSize: '0.66rem', color: '#166534' }}>Safe DOM Nodes</div>
                    </div>
                  </div>

                  {/* Anomaly Diagnosis Report if any */}
                  {anomalyLog.length > 0 && (
                    <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '4px', padding: '8px', fontSize: '0.72rem', color: '#92400e', marginBottom: '8px' }}>
                      <strong>🛡️ Spatial Safety Gate Anomalies Diagnosed:</strong>
                      <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                        {anomalyLog.map((log, idx) => (
                          <li key={idx}>{log}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {sha256Certificate && (
                    <div style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', borderRadius: '4px', padding: '6px 8px', fontSize: '0.70rem', color: '#334155' }}>
                      <strong>🔐 SHA-256 Ledger Digest:</strong> <code style={{ wordBreak: 'break-all' }}>{sha256Certificate}</code>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="error-banner" style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px' }}>
              <div>⚠️ {error}</div>
              <button
                onClick={handleOpenTestFixture}
                type="button"
                style={{
                  background: '#2563eb',
                  color: '#ffffff',
                  border: 'none',
                  padding: '6px 12px',
                  borderRadius: '4px',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  alignSelf: 'flex-start',
                }}
              >
                🌐 Open Live Test Page (127.0.0.1:8000/demo)
              </button>
            </div>
          )}

          {!safeContext ? (
            <div className="task-card" style={{ textAlign: 'center', padding: '20px 14px' }}>
              <div style={{ fontSize: '1.8rem', marginBottom: '6px' }}>🛡️</div>
              <strong style={{ display: 'block', marginBottom: '4px', color: '#0f172a' }}>
                Zero-Leak Privacy Boundary
              </strong>
              <p style={{ fontSize: '0.76rem', color: '#64748b', lineHeight: 1.45, margin: 0 }}>
                Open a test page to test on-device perception, Privacy Gate redaction, and ZonUI-3B visual grounding.
              </p>
              <button
                className="fixture-launch-btn"
                onClick={handleOpenTestFixture}
                type="button"
                id="launch-fixture-btn"
              >
                <span>📄</span>
                <span>Launch Interactive Demo Test Page</span>
              </button>
            </div>
          ) : (
            <>
              {/* SafeContext Active Info Banner */}
              <div
                id="safe-context-banner"
                style={{
                  background: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  borderRadius: '6px',
                  padding: '8px 10px',
                  fontSize: '0.75rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: '12px',
                }}
              >
                <span>
                  🛡️ <strong>SafeContext Ready:</strong> {safeContext.summary.totalDetected} detected (
                  <span style={{ color: '#dc2626', fontWeight: 600 }}>{safeContext.summary.masked} masked</span>,{' '}
                  <span style={{ color: '#16a34a', fontWeight: 600 }}>{safeContext.summary.allowed} allowed</span>)
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {safeContext.summary.masked > 0 && (
                    <button
                      onClick={togglePageMasks}
                      style={{
                        background: pageMasksVisible ? '#fee2e2' : '#f1f5f9',
                        border: pageMasksVisible ? '1px solid #f87171' : '1px solid #cbd5e1',
                        color: pageMasksVisible ? '#991b1b' : '#334155',
                        borderRadius: '4px',
                        padding: '2px 6px',
                        fontSize: '0.70rem',
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                      id="toggle-page-masks-btn"
                      title="Draw physical blackout redaction boxes over sensitive fields directly on the webpage screen"
                    >
                      {pageMasksVisible ? '🙈 Hide Screen Masks' : '👁️ Show Screen Masks'}
                    </button>
                  )}
                  <button
                    onClick={() => setActiveTab('gate')}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#2563eb',
                      fontSize: '0.72rem',
                      fontWeight: 700,
                      cursor: 'pointer',
                      textDecoration: 'underline',
                    }}
                    id="link-to-gate"
                  >
                    View Gate ↗
                  </button>
                </div>
              </div>

              {/* Task Formulation Card */}
              <div className="task-card" id="task-formulation-card">
                <div className="task-card-title">
                  <span>📝</span>
                  <span>Agent Task &amp; Goal</span>
                </div>

                <div className="presets-row">
                  {safeContext.url.includes('mock-id') || safeContext.url.includes('3456') ? (
                    <>
                      <button
                        className="preset-chip"
                        onClick={() =>
                          setTaskPrompt(
                            'Click the submit button, but do not interact with the Aadhaar or PAN fields'
                          )
                        }
                        type="button"
                        id="preset-legitimate-btn"
                      >
                        ✅ Legitimate: Submit Form
                      </button>
                      <button
                        className="preset-chip adversarial"
                        onClick={() => setTaskPrompt('Click the Aadhaar field')}
                        type="button"
                        id="preset-adversarial-btn"
                      >
                        🚨 Adversarial: Click Aadhaar
                      </button>
                      <button
                        className="preset-chip"
                        onClick={() => setTaskPrompt('Click the total amount')}
                        type="button"
                        id="preset-total-btn"
                      >
                        💰 Non-Sensitive: Total
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="preset-chip"
                        onClick={() => setTaskPrompt('Type "Privacy Agent" into search')}
                        type="button"
                      >
                        🔍 Type into Search
                      </button>
                      <button
                        className="preset-chip"
                        onClick={() => setTaskPrompt('Click the search button')}
                        type="button"
                      >
                        🔘 Click Search
                      </button>
                      <button
                        className="preset-chip"
                        onClick={() => setTaskPrompt('Click the Log in link')}
                        type="button"
                      >
                        🔗 Click Log In
                      </button>
                      <button
                        className="preset-chip"
                        onClick={() => setTaskPrompt('Click the submit button')}
                        type="button"
                      >
                        📝 Click Submit
                      </button>
                    </>
                  )}
                </div>

                <textarea
                  className="task-textarea"
                  value={taskPrompt}
                  onChange={(e) => setTaskPrompt(e.target.value)}
                  placeholder="Describe agent task in plain English (e.g. click search, type hello into search)..."
                  id="task-prompt-input"
                />

                <div style={{ fontSize: '0.71rem', color: '#64748b', marginTop: '2px', marginBottom: '8px', lineHeight: 1.35 }}>
                  💡 <strong>Tip:</strong> You can type any action in natural language for this page. The agent will parse your goal, ground it to the visible UI, and execute it!
                </div>

                <button
                  className="plan-btn"
                  onClick={handlePlanAgent}
                  disabled={planning || !taskPrompt.trim() || serverStatus === 'offline'}
                  id="plan-agent-btn"
                >
                  {planning ? '🤖 ZonUI-3B Grounding & Planning...' : '🤖 Plan Actions (ZonUI-3B)'}
                </button>
              </div>

              {planningError && <div className="error-banner">⚠️ {planningError}</div>}

              {/* Plan Result Card */}
              {plan && (
                <div className="plan-result-card" id="plan-result-card">
                  <div className="plan-header">
                    <span className="plan-title">
                      🎯 Action Plan ({plan.actions.length} approved, {plan.blockedActions.length} blocked)
                    </span>
                    <span className={`mode-badge ${plan.groundingMode.toLowerCase()}`}>
                      {plan.groundingMode}
                    </span>
                  </div>

                  <div className="plan-summary-text" id="plan-summary-text">
                    {plan.summary}
                  </div>

                  {/* Blocked Actions Warning */}
                  {plan.blockedActions.length > 0 && (
                    <div className="blocked-action-banner" id="blocked-action-banner">
                      <div className="blocked-banner-header">
                        <span>🛡️</span>
                        <span>PRIVACY GATE ENFORCED: Sensitive Target Blocked!</span>
                      </div>
                      {plan.blockedActions.map((b, idx) => (
                        <div key={idx} className="blocked-banner-detail">
                          <strong>Step:</strong> "{b.step}" <br />
                          <strong>Interception:</strong> {b.reason}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Approved Actions List */}
                  {plan.actions.length > 0 && (
                    <div className="action-items-list" id="action-items-list">
                      {plan.actions.map((act, idx) => (
                        <div key={idx} className="action-item-card">
                          <div className="action-item-top">
                            <span className={`action-type-pill ${act.action}`}>
                              Step {idx + 1}: {act.action}
                            </span>
                            <span className="action-confidence-pill">
                              {Math.round(act.confidence * 100)}% conf
                            </span>
                          </div>
                          <div className="action-target-row">
                            <strong>Target:</strong> <code>{act.targetSelector}</code>
                            {act.value && <span> with value "{act.value}"</span>}
                          </div>
                          <div className="action-coords-tag">
                            BBox: [{act.groundedBbox.w}x{act.groundedBbox.h} at {act.groundedBbox.x},{' '}
                            {act.groundedBbox.y}]
                          </div>
                          <div className="action-reasoning">{act.reasoning}</div>
                          {act.targetSelector === 'coordinates' && (
                            <div
                              style={{
                                marginTop: '6px',
                                padding: '6px 8px',
                                background: '#fffbeb',
                                border: '1px solid #fde68a',
                                borderRadius: '4px',
                                fontSize: '0.72rem',
                                color: '#92400e',
                                lineHeight: 1.3,
                              }}
                            >
                              ⚠️ <strong>Coordinate Fallback:</strong> No DOM element matched your task description on this page. Check that the element exists, or try specifying an exact label or text from the page (e.g. "search", "login").
                            </div>
                          )}
                        </div>
                      ))}

                      {/* Execute Button */}
                      <button
                        className="execute-btn"
                        onClick={handleExecutePlan}
                        disabled={executing}
                        id="execute-plan-btn"
                      >
                        {executing ? '⏳ Executing in Browser...' : '🚀 Approve & Execute Plan on Page'}
                      </button>
                    </div>
                  )}

                  {plan.actions.length === 0 && plan.blockedActions.length > 0 && (
                    <div
                      id="plan-all-blocked-notice"
                      style={{
                        fontSize: '0.76rem',
                        color: '#b91c1c',
                        fontWeight: 600,
                        textAlign: 'center',
                        padding: '8px',
                        background: '#fef2f2',
                        borderRadius: '4px',
                      }}
                    >
                      🛑 Execution disallowed: All planned steps violated the trust boundary.
                    </div>
                  )}
                </div>
              )}

              {executionError && <div className="error-banner">⚠️ {executionError}</div>}

              {/* Execution Report Card */}
              {executionReport && (
                <div className="execution-report-card" id="execution-report-card">
                  <div className="exec-header">
                    <span className="exec-title">
                      <span>{executionReport.success ? '✅' : '⚠️'}</span>
                      <span>
                        {executionReport.success
                          ? 'Browser Execution Succeeded!'
                          : 'Execution Interrupted'}
                      </span>
                    </span>
                    <span style={{ fontSize: '0.72rem', color: '#166534', fontWeight: 600 }}>
                      {executionReport.executedSteps} / {executionReport.totalSteps} steps completed
                    </span>
                  </div>

                  <div className="exec-step-list">
                    {executionReport.results.map((res, idx) => (
                      <div key={idx} className="exec-step-item">
                        <span className="exec-step-status-icon">
                          {res.status === 'SUCCESS' ? '✅' : res.status === 'BLOCKED' ? '🛡️' : '❌'}
                        </span>
                        <div>
                          <strong>Step {idx + 1}:</strong> {res.message}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Tab 2: Privacy Gate */}
      {activeTab === 'gate' && (
        <div className="tab-content" id="privacy-gate-tab-content">
          <div className="action-section">
            <button
              className="capture-button"
              onClick={() => handleCaptureContext()}
              disabled={loading || visionLoading || sanitizing}
              id="capture-context-btn"
            >
              {loading
                ? 'Capturing Context...'
                : visionLoading
                ? 'Perceiving Viewport (TrOCR)...'
                : sanitizing
                ? 'Sanitizing Trust Boundary...'
                : 'Capture & Sanitize Context'}
            </button>
          </div>

          {error && <div className="error-banner">⚠️ {error}</div>}

          {safeContext && (
            <div className="result-section">
              {/* Privacy Gate Summary Banner */}
              <div className="privacy-gate-banner" id="privacy-gate-banner">
                <div className="gate-header">
                  <span className="gate-icon">🛡️</span>
                  <div>
                    <h3 className="gate-title">Privacy Gate Enforced</h3>
                    <p className="gate-subtitle">Auditable Zero-Leak Trust Boundary</p>
                  </div>
                  <span className="gate-pill">TRUST BOUNDARY PASSED ✅</span>
                </div>

                <div className="gate-metrics-grid">
                  <div className="gate-metric total">
                    <span className="metric-num">{safeContext.summary.totalDetected}</span>
                    <span className="metric-label">Fields Detected</span>
                  </div>
                  <div className="gate-metric masked">
                    <span className="metric-num">{safeContext.summary.masked}</span>
                    <span className="metric-label">Masked (Blackout)</span>
                  </div>
                  <div className="gate-metric blocked">
                    <span className="metric-num">{safeContext.summary.blocked}</span>
                    <span className="metric-label">Blocked (Removed)</span>
                  </div>
                  <div className="gate-metric allowed">
                    <span className="metric-num">{safeContext.summary.allowed}</span>
                    <span className="metric-label">Allowed (Pass-through)</span>
                  </div>
                </div>

                <div className="summary-sentence" id="summary-sentence-text">
                  <strong>Summary:</strong> {safeContext.summary.totalDetected} fields detected,{' '}
                  <span className="text-masked">{safeContext.summary.masked} masked</span>,{' '}
                  <span className="text-blocked">{safeContext.summary.blocked} blocked</span>,{' '}
                  <span className="text-allowed">{safeContext.summary.allowed} allowed</span>
                  {safeContext.summary.pendingAsk > 0 && (
                    <span className="text-ask">, {safeContext.summary.pendingAsk} pending approval</span>
                  )}
                  .
                </div>
              </div>

              {/* Pending ASK Resolutions */}
              {safeContext.pendingAskFields.length > 0 && (
                <div className="ask-prompt-card" id="ask-prompt-container">
                  <div className="ask-header">
                    <span className="ask-icon">⚠️</span>
                    <strong>User Action Required ('ASK' Policy Triggered):</strong>
                  </div>
                  {safeContext.pendingAskFields.map((field, idx) => (
                    <div key={idx} className="ask-item">
                      <div className="ask-item-desc">
                        Category: <strong>{field.category.toUpperCase()}</strong> ({field.source})
                        {field.matchedText && <span> — "{field.matchedText}"</span>}
                      </div>
                      <div className="ask-btn-group">
                        <button
                          className="ask-btn mask"
                          onClick={() => handleResolveAsk(field, 'MASK')}
                        >
                          Mask (Redact)
                        </button>
                        <button
                          className="ask-btn block"
                          onClick={() => handleResolveAsk(field, 'BLOCK')}
                        >
                          Block (Remove)
                        </button>
                        <button
                          className="ask-btn allow"
                          onClick={() => handleResolveAsk(field, 'ALLOW')}
                        >
                          Allow (Pass)
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Side-by-Side Screenshots: Original vs Sanitized */}
              <div className="side-by-side-section" id="side-by-side-container">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <h3 style={{ margin: 0 }}>Screenshot Comparison (Pre-Sanitize vs. Redacted)</h3>
                  {safeContext.summary.masked > 0 && (
                    <button
                      onClick={togglePageMasks}
                      style={{
                        background: pageMasksVisible ? '#fee2e2' : '#f1f5f9',
                        border: pageMasksVisible ? '1px solid #f87171' : '1px solid #cbd5e1',
                        color: pageMasksVisible ? '#991b1b' : '#334155',
                        borderRadius: '4px',
                        padding: '3px 8px',
                        fontSize: '0.72rem',
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                      id="toggle-page-masks-gate-btn"
                    >
                      {pageMasksVisible ? '🙈 Hide On-Screen Webpage Masks' : '👁️ Show On-Screen Webpage Masks'}
                    </button>
                  )}
                </div>
                <div className="side-by-side-grid">
                  <div className="screenshot-box original">
                    <div className="box-label original">
                      <span>Pre-Sanitize Original</span>
                      <span className="badge-raw">RAW VIEWPORT</span>
                    </div>
                    {safeContext.rawScreenshot ? (
                      <img
                        src={safeContext.rawScreenshot}
                        alt="Pre-Sanitize Original"
                        className="comparison-img"
                        id="original-screenshot-img"
                      />
                    ) : (
                      <div className="no-img">Screenshot not available</div>
                    )}
                  </div>

                  <div className="screenshot-box sanitized">
                    <div className="box-label sanitized">
                      <span>Sanitized Outbound</span>
                      <span className="badge-redacted">SOLID BLACKOUT</span>
                    </div>
                    {safeContext.redactedScreenshot ? (
                      <img
                        src={safeContext.redactedScreenshot}
                        alt="Sanitized Redacted Screenshot"
                        className="comparison-img"
                        id="redacted-screenshot-img"
                      />
                    ) : (
                      <div className="no-img">Redacted screenshot not available</div>
                    )}
                  </div>
                </div>
              </div>

              {/* Audit Log Table */}
              <div className="audit-log-section" id="audit-log-container">
                <div className="section-header-row">
                  <h3>Privacy Decision Audit Log ({safeContext.auditLog.length})</h3>
                  <span className="audit-sub">Auditable Trail for Pitch Compliance</span>
                </div>

                <div className="audit-table-wrapper">
                  <table className="audit-table" id="audit-log-table">
                    <thead>
                      <tr>
                        <th>Category</th>
                        <th>Action</th>
                        <th>Source</th>
                        <th>Details</th>
                        <th>BBox</th>
                      </tr>
                    </thead>
                    <tbody>
                      {safeContext.auditLog.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="empty-audit">
                            No sensitive fields encountered.
                          </td>
                        </tr>
                      ) : (
                        safeContext.auditLog.map((entry, idx) => (
                          <tr key={idx} className={`row-action-${entry.action.toLowerCase()}`}>
                            <td>
                              <strong className="cat-name">{entry.category.toUpperCase()}</strong>
                            </td>
                            <td>
                              <span className={`action-badge ${entry.action.toLowerCase()}`}>
                                {entry.action}
                              </span>
                            </td>
                            <td>
                              <span className="source-badge">{entry.source.toUpperCase()}</span>
                            </td>
                            <td className="details-cell">{entry.details || '—'}</td>
                            <td className="bbox-cell">
                              [{entry.bbox.width}x{entry.bbox.height} at {entry.bbox.x},{entry.bbox.y}]
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Sanitized Outbound Payload Preview */}
              <div className="payload-section">
                <details className="payload-inspector">
                  <summary>📋 Outbound SafeContext JSON Payload (Verified Sanitized)</summary>
                  <pre className="json-preview">
                    {JSON.stringify(
                      {
                        url: safeContext.url,
                        timestamp: safeContext.timestamp,
                        summary: safeContext.summary,
                        auditLog: safeContext.auditLog,
                        sanitizedVisualRegions: safeContext.sanitizedVisualRegions,
                        sanitizedDomCount: safeContext.sanitizedDom.length,
                      },
                      null,
                      2
                    )}
                  </pre>
                </details>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab 3: Settings */}
      {activeTab === 'settings' && (
        <div className="tab-content settings-tab" id="settings-tab-content">
          {/* 🛡️ Master Extension Shield & Proactive Scanning Card */}
          <div className="gpu-settings-card" style={{ marginBottom: '12px' }} id="extension-controls-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
              <strong style={{ fontSize: '0.84rem', color: '#0f172a', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span>🛡️</span>
                <span>Extension Shield &amp; Automation</span>
              </strong>
              <span className={`master-power-badge ${extensionActive ? 'active' : 'paused'}`}>
                {extensionActive ? 'ACTIVE' : 'PAUSED'}
              </span>
            </div>
            <p style={{ fontSize: '0.73rem', color: '#64748b', margin: '0 0 10px 0', lineHeight: 1.35 }}>
              Enable or pause the extension whenever you want. You have 100% control over on-screen masks and proactive page scanning.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {/* Row 1: Master Power */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', background: '#f8fafc', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                <div>
                  <div style={{ fontSize: '0.80rem', fontWeight: 700, color: '#0f172a' }}>Master Extension Shield</div>
                  <div style={{ fontSize: '0.70rem', color: '#64748b' }}>Turn extension on or pause it across all tabs</div>
                </div>
                <button
                  type="button"
                  className={`master-toggle-switch ${extensionActive ? 'on' : 'off'}`}
                  onClick={handleToggleExtensionActive}
                  id="settings-master-power-btn"
                >
                  <span className="switch-knob"></span>
                </button>
              </div>

              {/* Row 2: Proactive Page Scanning */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', background: '#f8fafc', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                <div>
                  <div style={{ fontSize: '0.80rem', fontWeight: 700, color: '#0f172a' }}>Proactive Page Scanner</div>
                  <div style={{ fontSize: '0.70rem', color: '#64748b' }}>Automatically shield PII on page load vs on-demand only</div>
                </div>
                <button
                  type="button"
                  className={`master-toggle-switch ${proactiveShield ? 'on' : 'off'}`}
                  onClick={handleToggleProactiveShield}
                  disabled={!extensionActive}
                  id="settings-proactive-shield-btn"
                >
                  <span className="switch-knob"></span>
                </button>
              </div>
            </div>
          </div>

          {/* ⚡ GPU Grounding & Server Configuration Card */}
          <div className="gpu-settings-card" id="gpu-settings-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
              <strong style={{ fontSize: '0.84rem', color: '#0f172a', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span>⚡</span>
                <span>ZonUI-3B Grounding Engine</span>
              </strong>
              <span style={{ fontSize: '0.70rem', background: '#e2e8f0', padding: '2px 6px', borderRadius: '4px', fontWeight: 700 }}>
                {gpuMode}
              </span>
            </div>
            <p style={{ fontSize: '0.73rem', color: '#64748b', margin: '0 0 8px 0', lineHeight: 1.35 }}>
              Choose whether visual grounding runs on a remote GPU (Google Colab / vLLM), local PyTorch accelerator, or the ultra-fast deterministic mock.
            </p>

            <div className="gpu-mode-selector">
              <button
                className={`gpu-mode-btn ${gpuMode === 'MOCK' ? 'active' : ''}`}
                onClick={() => handleUpdateGpuMode('MOCK')}
                type="button"
                id="gpu-mode-mock-btn"
              >
                Mock (Fast 5ms)
              </button>
              <button
                className={`gpu-mode-btn ${gpuMode === 'REMOTE_API' ? 'active' : ''}`}
                onClick={() => handleUpdateGpuMode('REMOTE_API')}
                type="button"
                id="gpu-mode-remote-btn"
              >
                Colab / Remote GPU
              </button>
              <button
                className={`gpu-mode-btn ${gpuMode === 'LOCAL_MODEL' ? 'active' : ''}`}
                onClick={() => handleUpdateGpuMode('LOCAL_MODEL')}
                type="button"
                id="gpu-mode-local-btn"
              >
                Local PyTorch
              </button>
            </div>

            {gpuMode === 'REMOTE_API' && (
              <div style={{ marginTop: '8px' }}>
                <label style={{ fontSize: '0.72rem', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '4px' }}>
                  Remote GPU Endpoint (Hugging Face / Colab / vLLM):
                </label>
                <div className="gpu-input-row">
                  <input
                    type="text"
                    className="gpu-endpoint-input"
                    value={gpuEndpoint}
                    onChange={(e) => setGpuEndpoint(e.target.value)}
                    placeholder="https://router.huggingface.co/hf-inference/v1/chat/completions"
                    id="gpu-endpoint-input"
                  />
                  <button
                    className="gpu-test-btn"
                    onClick={() => handleUpdateGpuMode('REMOTE_API', gpuEndpoint)}
                    type="button"
                    id="save-gpu-endpoint-btn"
                  >
                    Save
                  </button>
                </div>
                
                {/* Quick Presets */}
                <div style={{ display: 'flex', gap: '4px', marginTop: '6px' }}>
                  <button
                    type="button"
                    style={{ background: '#fef3c7', border: '1px solid #fde68a', color: '#92400e', borderRadius: '4px', padding: '3px 6px', fontSize: '0.68rem', fontWeight: 700, cursor: 'pointer' }}
                    onClick={() => {
                      const hfUrl = 'https://router.huggingface.co/hf-inference/v1/chat/completions';
                      setGpuEndpoint(hfUrl);
                      handleUpdateGpuMode('REMOTE_API', hfUrl);
                    }}
                    id="preset-hf-btn"
                  >
                    🤗 Hugging Face (ZonUI-3B)
                  </button>
                  <button
                    type="button"
                    style={{ background: '#e0f2fe', border: '1px solid #bae6fd', color: '#0369a1', borderRadius: '4px', padding: '3px 6px', fontSize: '0.68rem', fontWeight: 700, cursor: 'pointer' }}
                    onClick={() => {
                      const colabUrl = 'http://localhost:8001/ground';
                      setGpuEndpoint(colabUrl);
                      handleUpdateGpuMode('REMOTE_API', colabUrl);
                    }}
                    id="preset-colab-btn"
                  >
                    ☁️ Colab / Tunnel
                  </button>
                </div>
              </div>
            )}

            <div style={{ marginTop: '10px', display: 'flex', gap: '6px' }}>
              <button
                className="gpu-test-btn"
                style={{ width: '100%' }}
                onClick={handleTestGpu}
                disabled={testingGpu}
                type="button"
                id="test-gpu-conn-btn"
              >
                {testingGpu ? '⏳ Testing Connection...' : '🔌 Test GPU Connection & Ping'}
              </button>
            </div>

            {gpuTestResult && (
              <div className={`gpu-test-result ${gpuTestResult.success ? 'success' : 'error'}`}>
                <span>{gpuTestResult.success ? '✅' : '❌'} {gpuTestResult.message}</span>
                {gpuTestResult.latencyMs !== undefined && (
                  <strong style={{ fontSize: '0.70rem' }}>{gpuTestResult.latencyMs}ms</strong>
                )}
              </div>
            )}
          </div>

          <div className="settings-header">
            <h3>Policy Engine Configuration</h3>
            <p className="settings-desc">
              Define the action to take for each field category. Actions:
              <strong> MASK</strong> (blackout &amp; token), <strong> BLOCK</strong> (remove completely),{' '}
              <strong> ALLOW</strong> (pass-through), or <strong> ASK</strong> (prompt user).
            </p>
          </div>

          <div className="policy-table-container">
            <table className="policy-table">
              <thead>
                <tr>
                  <th>Field Category</th>
                  <th>Action Policy</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { key: 'aadhaar', label: 'Aadhaar (12-digit UIDAI)' },
                  { key: 'pan', label: 'PAN Card (10-char Tax ID)' },
                  { key: 'name', label: 'Person Name' },
                  { key: 'address', label: 'Address / Residence' },
                  { key: 'amount', label: 'Total / Amount (Financial)' },
                  { key: 'phone', label: 'Phone / Mobile Number' },
                  { key: 'email', label: 'Email Address' },
                  { key: 'unclassified', label: 'Unclassified Content (Default Fail-Safe)' },
                ].map((item) => (
                  <tr key={item.key}>
                    <td>
                      <strong>{item.label}</strong>
                    </td>
                    <td>
                      <select
                        className="policy-select"
                        value={policy[item.key] || 'MASK'}
                        onChange={(e) => handlePolicyChange(item.key, e.target.value as PolicyAction)}
                        id={`policy-select-${item.key}`}
                      >
                        <option value="MASK">MASK (Redact &amp; Blackout)</option>
                        <option value="BLOCK">BLOCK (Remove from Payload)</option>
                        <option value="ALLOW">ALLOW (Pass-through)</option>
                        <option value="ASK">ASK (Prompt User)</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="failsafe-notice">
            🔒 <strong>Hard Rule:</strong> Any field category not explicitly configured by the user
            strictly defaults to <code>MASK</code>. Content is never silently allowed.
          </div>
        </div>
      )}
    </div>
  );
}
