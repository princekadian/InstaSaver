// InstaSaver - Background Service Worker

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'download') {
    const { url, filename } = message;

    chrome.downloads.download(
      {
        url: url,
        filename: filename,
        saveAs: false,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error('[InstaSaver] Download failed:', chrome.runtime.lastError.message);
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, downloadId });
        }
      }
    );

    // Keep message channel open for async response
    return true;
  }
});
