// popup.js - External script (required by MV3 CSP)
document.addEventListener('DOMContentLoaded', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    const el  = document.getElementById('statusIndicator');
    if (tab && tab.url && tab.url.includes('instagram.com')) {
      el.innerHTML  = '✅ Active on Instagram!<br>Save buttons injected into posts.';
      el.className  = 'status active';
    } else {
      el.innerHTML  = 'Navigate to Instagram to use InstaSaver.';
      el.className  = 'status';
    }
  });
});
