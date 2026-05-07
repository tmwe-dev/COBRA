/**
 * COBRA Bridge v2.0 — Content Script
 * Iniettato in ogni pagina e iframe (all_frames: true).
 * Ruolo: notifica pagina pronta + ponte per comandi diretti dal background.
 */

// Notifica background che la pagina/frame è pronta
chrome.runtime.sendMessage({
  type: 'page_ready',
  url: location.href,
  title: document.title,
  isFrame: window !== window.top,
  readyState: document.readyState
}).catch(() => {});

// Notifica anche quando il DOM è completamente caricato
if (document.readyState !== 'complete') {
  window.addEventListener('load', () => {
    chrome.runtime.sendMessage({
      type: 'page_loaded',
      url: location.href,
      title: document.title,
      isFrame: window !== window.top
    }).catch(() => {});
  });
}

// Rileva navigazioni SPA (URL cambia senza reload)
let lastUrl = location.href;
const observer = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    chrome.runtime.sendMessage({
      type: 'spa_navigation',
      url: location.href,
      title: document.title
    }).catch(() => {});
  }
});
observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
