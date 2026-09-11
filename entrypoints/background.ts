import type { AgentSession, AgentSessionStatus } from '@/types';

export default defineBackground(() => {
  console.log('[Nexus Privacy Agent] Background service worker initialized.');

  let activeSession: AgentSession | null = null;

  const storageArea =
    typeof chrome !== 'undefined' && chrome.storage?.session
      ? chrome.storage.session
      : typeof chrome !== 'undefined' && chrome.storage?.local
      ? chrome.storage.local
      : null;

  // Restore session from storage if service worker woke up
  if (storageArea) {
    storageArea.get(['nexus_active_session'], (res) => {
      if (res && res.nexus_active_session) {
        activeSession = res.nexus_active_session as AgentSession;
        console.log('[Nexus Privacy Agent] Resumed active session from storage:', activeSession);
      }
    });
  }

  const saveSession = async (session: AgentSession | null) => {
    activeSession = session;
    if (storageArea) {
      if (session) {
        await storageArea.set({ nexus_active_session: session });
      } else {
        await storageArea.remove('nexus_active_session');
      }
    }
  };

  const stopActiveSession = async () => {
    if (activeSession) {
      const tabId = activeSession.tabId;
      console.log(`[Nexus Privacy Agent] ⏹️ Stopping agent session on tab ${tabId}`);
      try {
        await chrome.tabs.sendMessage(tabId, { type: 'SESSION_DEACTIVATED' });
      } catch {
        // tab might be already closed
      }
      await saveSession(null);
      if (storageArea) {
        await storageArea.remove('nexus_popup_saved_state');
      }
    }
  };

  // When active tab is closed or navigates, terminate its agent session
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (activeSession && activeSession.tabId === tabId) {
      console.log(`[Nexus Privacy Agent] Active tab ${tabId} closed. Terminating agent session.`);
      saveSession(null);
      if (storageArea) {
        storageArea.remove('nexus_popup_saved_state');
      }
    }
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (activeSession && activeSession.tabId === tabId && changeInfo.status === 'loading') {
      console.log(`[Nexus Privacy Agent] Active tab ${tabId} navigated. Resetting agent session.`);
      stopActiveSession();
    }
  });

  // Content scripts are cleanly declared in manifest.json and injected on-demand by Chrome


  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return;

    if (message.type === 'START_AGENT_SESSION') {
      const tabId = Number(message.tabId);
      if (!tabId) {
        sendResponse({ success: false, error: 'Invalid tabId' });
        return true;
      }

      // If another tab had an active session, stop it first
      if (activeSession && activeSession.tabId !== tabId) {
        stopActiveSession();
      }

      const newSession: AgentSession = {
        sessionId: `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        tabId,
        status: 'PROTECTING',
        startedAt: Date.now(),
        taskPrompt: message.taskPrompt || '',
      };

      saveSession(newSession).then(() => {
        // Notify the target tab that it is now the active agent tab
        chrome.tabs.sendMessage(tabId, {
          type: 'SESSION_ACTIVATED',
          session: newSession,
        }).catch(() => {});

        console.log(`[Nexus Privacy Agent] 🚀 Started session ${newSession.sessionId} on tab ${tabId}`);
        sendResponse({ success: true, session: newSession });
      });

      return true;
    }

    if (message.type === 'UPDATE_SESSION_STATUS') {
      if (activeSession) {
        activeSession.status = message.status;
        if (message.status === 'COMPLETED' || message.status === 'ERROR') {
          activeSession.completedAt = Date.now();
        }
        if (message.executionReport) {
          activeSession.executionReport = message.executionReport;
        }
        if (message.plan) {
          activeSession.plan = message.plan;
        }
        saveSession(activeSession).then(() => {
          if (storageArea) {
            storageArea.get(['nexus_popup_saved_state', 'nexus_last_executed_action_state'], (res) => {
              if (res && res.nexus_popup_saved_state) {
                const saved: any = res.nexus_popup_saved_state;
                if (message.executionReport) {
                  saved.executionReport = message.executionReport;
                }
                if (message.plan) {
                  saved.plan = message.plan;
                }
                saved.agentSession = activeSession;
                storageArea.set({ nexus_popup_saved_state: saved }).catch(() => {});
              }

              // Also persist into nexus_last_executed_action_state so it survives popup closure!
              if (message.executionReport) {
                const prev: any = res?.nexus_last_executed_action_state || {};
                const report = message.executionReport;
                const steps = (report.results || []).map((r: any, idx: number) => ({
                  stepIndex: idx + 1,
                  actionType: r.action?.action || 'action',
                  description: r.action?.reasoning || `${r.action?.action?.toUpperCase() || 'Action'} on ${r.action?.targetSelector || 'element'}`,
                  value: r.action?.value || undefined,
                  targetSelector: r.action?.targetSelector || undefined,
                  status: r.status,
                  message: r.message,
                }));
                const updatedState = {
                  ...prev,
                  taskPrompt: prev.taskPrompt || activeSession?.taskPrompt || 'Autonomous Agent Task',
                  url: prev.url || activeSession?.url,
                  domain: prev.domain,
                  plan: activeSession?.plan || prev.plan || null,
                  executionReport: report,
                  completedAt: Date.now(),
                  success: report.success,
                  totalSteps: report.totalSteps,
                  executedSteps: report.executedSteps,
                  steps,
                  autoRunStep: report.success
                    ? `Goal Completed: ${report.executedSteps}/${report.totalSteps} steps succeeded! ✅`
                    : 'Some steps could not complete',
                };
                chrome.storage.local.set({ nexus_last_executed_action_state: updatedState }).catch(() => {});
              }
            });
          }
          sendResponse({ success: true, session: activeSession });
        });
      } else {
        sendResponse({ success: false, reason: 'No active session' });
      }
      return true;
    }

    if (message.type === 'SET_EXTENSION_ACTIVE') {
      if (!message.active && storageArea) {
        chrome.storage.local.remove(['nexus_last_executed_action_state']).catch(() => {});
      }
      sendResponse({ success: true });
      return true;
    }

    if (message.type === 'STOP_AGENT_SESSION') {
      stopActiveSession().then(() => {
        if (storageArea) {
          storageArea.remove('nexus_popup_saved_state');
        }
        sendResponse({ success: true });
      });
      return true;
    }

    if (message.type === 'GET_SESSION_STATE') {
      sendResponse({ session: activeSession });
      return true;
    }

    if (message.type === 'CAPTURE_SCREEN') {
      try {
        const targetWindowId =
          typeof message.windowId === 'number' && message.windowId > 0 ? message.windowId : undefined;
        chrome.tabs.captureVisibleTab(
          targetWindowId as any,
          { format: 'jpeg', quality: 90 },
          (dataUrl) => {
            if (chrome.runtime.lastError || !dataUrl) {
              chrome.tabs.captureVisibleTab(
                null as any,
                { format: 'jpeg', quality: 90 },
                (fallbackUrl) => {
                  sendResponse(fallbackUrl || '');
                }
              );
            } else {
              sendResponse(dataUrl || '');
            }
          }
        );
      } catch (err) {
        console.error('[Nexus Privacy Agent] Capture exception:', err);
        sendResponse('');
      }

      return true;
    }
  });
});
