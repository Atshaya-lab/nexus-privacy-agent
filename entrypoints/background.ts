export default defineBackground(() => {
  console.log('[Nexus Privacy Agent] Background service worker initialized.');

  // Automatically inject content script into all open web tabs when extension reloads/installs
  chrome.runtime.onInstalled.addListener(async () => {
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (
          tab.id &&
          tab.url &&
          !tab.url.startsWith('chrome://') &&
          !tab.url.startsWith('chrome-extension://') &&
          !tab.url.startsWith('edge://') &&
          !tab.url.startsWith('about:')
        ) {
          chrome.scripting
            .executeScript({
              target: { tabId: tab.id },
              files: ['content-scripts/content.js'],
            })
            .catch(() => {});
        }
      }
    } catch {}
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === 'CAPTURE_SCREEN') {
      try {
        const targetWindowId = typeof message.windowId === 'number' ? message.windowId : undefined;
        chrome.tabs.captureVisibleTab(
          targetWindowId as any,
          { format: 'png' },
          (dataUrl) => {
            if (chrome.runtime.lastError) {
              const errMsg = chrome.runtime.lastError.message || 'Capture failed';
              console.warn('[Nexus Privacy Agent] captureVisibleTab error:', errMsg);
              sendResponse('');
            } else {
              console.log('[Nexus Privacy Agent] Viewport screenshot captured, size:', dataUrl ? dataUrl.length : 0);
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
