/* content.js – Content Script */

let lastSelection = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── Selezione immagine (tag manuale, come prima) ───────────────
  if (msg.type === "SELECT_IMAGE") {
    lastSelection = {
      srcUrl: msg.srcUrl,
      pageUrl: msg.pageUrl || location.href,
      pageTitle: document.title || ""
    };
    chrome.runtime.sendMessage({ type: "SELECTION_UPDATED", selection: lastSelection }).catch(() => {});
  }

  if (msg.type === "GET_LAST_SELECTION") {
    sendResponse({ selection: lastSelection });
  }

  // ── "Chi è?" dal menu contestuale ──────────────────────────────
  if (msg.type === "WHO_IS_THIS") {
    showToast("🔍 Analizzo il volto…", null);
    chrome.runtime.sendMessage(
      { type: "FETCH_IMAGE_AS_DATAURL", url: msg.srcUrl },
      (resp) => {
        if (!resp?.ok) {
          showToast("❌ Impossibile scaricare l'immagine", false);
          return;
        }
        // Invia al popup per il riconoscimento (ha face-api.js + DB)
        chrome.runtime.sendMessage({
          type: "RECOGNIZE_SINGLE",
          dataUrl: resp.dataUrl,
          srcUrl: msg.srcUrl
        });
      }
    );
  }

  // ── Scan pagina: raccogli URL immagini ─────────────────────────
  if (msg.type === "GET_PAGE_IMAGES") {
    const imgs = Array.from(document.querySelectorAll("img"))
      .filter(img => img.naturalWidth > 80 && img.naturalHeight > 80)
      .map(img => img.src)
      .filter(Boolean);
    sendResponse({ urls: [...new Set(imgs)] });
  }

  // ── Mostra risultati scan pagina (overlay) ─────────────────────
  if (msg.type === "SHOW_SCAN_RESULTS") {
    showScanOverlays(msg.results);
  }

  // ── Mostra toast "Chi è?" ──────────────────────────────────────
  if (msg.type === "SHOW_WHO_RESULT") {
    showToast(msg.text, msg.isMatch);
  }
});

// ═══════════════════════════════════════════════════════════════════
// Overlay – rettangoli verdi + label sui volti riconosciuti
// ═══════════════════════════════════════════════════════════════════
function showScanOverlays(results) {
  // Rimuovi overlay precedenti
  document.querySelectorAll(".ft-overlay").forEach(el => el.remove());

  for (const res of results) {
    if (!res.faces || res.faces.length === 0) continue;

    // Trova l'elemento <img> corrispondente
    const imgEl = Array.from(document.querySelectorAll("img"))
      .find(img => img.src === res.originalUrl);
    if (!imgEl) continue;

    const rect = imgEl.getBoundingClientRect();
    const scaleX = rect.width / (imgEl.naturalWidth || rect.width);
    const scaleY = rect.height / (imgEl.naturalHeight || rect.height);

    for (const face of res.faces) {
      if (!face.match) continue; // mostra solo volti riconosciuti

      const box = face.box;

      // Rettangolo
      const overlay = document.createElement("div");
      overlay.className = "ft-overlay";
      overlay.style.cssText = `
        position: absolute;
        left: ${rect.left + window.scrollX + box.x * scaleX}px;
        top: ${rect.top + window.scrollY + box.y * scaleY}px;
        width: ${box.width * scaleX}px;
        height: ${box.height * scaleY}px;
        border: 2px solid #00ff88;
        border-radius: 4px;
        pointer-events: none;
        z-index: 999999;
      `;
      document.body.appendChild(overlay);

      // Label con nome
      const confidence = Math.round((1 - face.match.distance) * 100);
      const label = document.createElement("div");
      label.className = "ft-overlay";
      label.style.cssText = `
        position: absolute;
        left: ${rect.left + window.scrollX + box.x * scaleX}px;
        top: ${rect.top + window.scrollY + box.y * scaleY - 22}px;
        background: #00ff88;
        color: #000;
        font-size: 12px;
        font-family: system-ui, sans-serif;
        font-weight: 600;
        padding: 2px 6px;
        border-radius: 4px;
        pointer-events: none;
        z-index: 999999;
        white-space: nowrap;
      `;
      label.textContent = `${face.match.name} (${confidence}%)`;
      document.body.appendChild(label);
    }
  }

  // Auto-rimuovi dopo 15s
  setTimeout(() => {
    document.querySelectorAll(".ft-overlay").forEach(el => el.remove());
  }, 15000);
}

// ═══════════════════════════════════════════════════════════════════
// Toast – notifica in basso a destra
// ═══════════════════════════════════════════════════════════════════
function showToast(text, isMatch) {
  document.querySelectorAll(".ft-toast").forEach(el => el.remove());

  let bg = "#333";
  if (isMatch === true) bg = "#00a854";
  if (isMatch === false) bg = "#cc3333";

  const toast = document.createElement("div");
  toast.className = "ft-toast";
  toast.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: ${bg};
    color: #fff;
    padding: 12px 20px;
    border-radius: 10px;
    font-family: system-ui, sans-serif;
    font-size: 14px;
    z-index: 9999999;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    max-width: 360px;
    transition: opacity 0.3s;
  `;
  toast.textContent = text;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 400);
  }, 5000);
}

// ═══════════════════════════════════════════════════════════════════
// AUTO-SCAN: scansiona automaticamente la pagina al caricamento
// ═══════════════════════════════════════════════════════════════════
let autoScanDone = false; // evita scan multipli sulla stessa pagina

function collectPageImageUrls() {
  return [...new Set(
    Array.from(document.querySelectorAll("img"))
      .filter(img => img.naturalWidth > 80 && img.naturalHeight > 80 && img.src)
      .map(img => img.src)
  )];
}

function triggerAutoScan() {
  if (autoScanDone) return;
  autoScanDone = true;

  const urls = collectPageImageUrls();
  if (urls.length === 0) return;

  console.log(`[FaceTagger] Auto-scan: ${urls.length} immagini trovate`);

  chrome.runtime.sendMessage({
    type: "AUTO_SCAN_REQUEST",
    urls: urls.slice(0, 30) // max 30 per non sovraccaricare
  }).catch(() => {});
}

// Attendi che le immagini siano caricate, poi scansiona
function waitForImagesAndScan() {
  // Primo tentativo dopo 2s (le immagini sopra la piega sono probabilmente caricate)
  setTimeout(() => {
    triggerAutoScan();
  }, 2000);

  // Secondo tentativo dopo 5s (per immagini lazy-loaded)
  setTimeout(() => {
    if (!autoScanDone) triggerAutoScan();
  }, 5000);
}

// Osserva anche nuove immagini aggiunte al DOM (SPA, infinite scroll)
const observer = new MutationObserver((mutations) => {
  let hasNewImages = false;
  for (const mut of mutations) {
    for (const node of mut.addedNodes) {
      if (node.nodeName === "IMG" || (node.querySelectorAll && node.querySelectorAll("img").length > 0)) {
        hasNewImages = true;
        break;
      }
    }
    if (hasNewImages) break;
  }

  if (hasNewImages) {
    // Reset e ri-scansiona dopo un debounce
    autoScanDone = false;
    clearTimeout(observer._debounce);
    observer._debounce = setTimeout(() => triggerAutoScan(), 3000);
  }
});

observer.observe(document.body, { childList: true, subtree: true });

// Avvia auto-scan
waitForImagesAndScan();
