/* background.js – Service Worker */

// ── Context Menus ────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "tag-image",
    title: "Tagga questa immagine/volto",
    contexts: ["image"]
  });
  chrome.contextMenus.create({
    id: "who-is-this",
    title: "Chi è? (riconosci volto)",
    contexts: ["image"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "tag-image") {
    chrome.tabs.sendMessage(tab.id, {
      type: "SELECT_IMAGE",
      srcUrl: info.srcUrl,
      pageUrl: tab.url
    });
    try { await chrome.action.openPopup(); } catch (e) {}
  }

  if (info.menuItemId === "who-is-this") {
    chrome.tabs.sendMessage(tab.id, {
      type: "WHO_IS_THIS",
      srcUrl: info.srcUrl
    });
  }
});

// ── Offscreen document management ────────────────────────────────
let creatingOffscreen = null;

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument().catch(() => false);
  if (existing) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["DOM_PARSER"],
    justification: "Face recognition con face-api.js richiede DOM e canvas"
  });

  await creatingOffscreen;
  creatingOffscreen = null;

  // Attendi inizializzazione moduli ES
  await new Promise(r => setTimeout(r, 500));
}

// ── Helper: ArrayBuffer -> base64 ────────────────────────────────
function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ── Scarica singola immagine → dataUrl ───────────────────────────
async function fetchImageDataUrl(url) {
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const ab = await res.arrayBuffer();
  const b64 = arrayBufferToBase64(ab);
  return `data:${contentType};base64,${b64}`;
}

// ── Scarica batch immagini ───────────────────────────────────────
async function fetchImagesBatch(urls) {
  const results = [];
  for (const url of urls) {
    try {
      const dataUrl = await fetchImageDataUrl(url);
      results.push({ url, ok: true, dataUrl });
    } catch {
      results.push({ url, ok: false });
    }
  }
  return results;
}

// ── Soglia default per auto-scan ─────────────────────────────────
const DEFAULT_THRESHOLD = 0.4;

// ── Messaggi ─────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Fetch singolo (usato da popup e content)
  if (msg.type === "FETCH_IMAGE_AS_DATAURL") {
    fetchImageDataUrl(msg.url)
      .then(dataUrl => sendResponse({ ok: true, dataUrl }))
      .catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  // Fetch batch (usato da popup per scan manuale)
  if (msg.type === "FETCH_IMAGES_BATCH") {
    fetchImagesBatch(msg.urls)
      .then(results => sendResponse({ ok: true, results }));
    return true;
  }

  // ── AUTO SCAN: richiesta dal content script al caricamento pagina ──
  if (msg.type === "AUTO_SCAN_REQUEST") {
    handleAutoScan(msg, sender).catch(err => {
      console.warn("[FaceTagger BG] Auto-scan error:", err);
    });
    return false;
  }

  // ── RECOGNIZE_SINGLE: "Chi è?" via offscreen ──────────────────
  if (msg.type === "RECOGNIZE_SINGLE") {
    handleRecognizeSingle(msg, sender).catch(err => {
      console.warn("[FaceTagger BG] Recognize error:", err);
    });
    return false;
  }

  // ── Scan manuale dal popup via offscreen ───────────────────────
  if (msg.type === "MANUAL_SCAN_VIA_OFFSCREEN") {
    (async () => {
      try {
        await ensureOffscreen();
        const result = await chrome.runtime.sendMessage({
          type: "OFFSCREEN_SCAN_PAGE",
          images: msg.images,
          threshold: msg.threshold || DEFAULT_THRESHOLD
        });
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }
});

// ═══════════════════════════════════════════════════════════════════
// Auto-scan: content.js → background → offscreen → content.js
// ═══════════════════════════════════════════════════════════════════
async function handleAutoScan(msg, sender) {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  const urls = (msg.urls || []).slice(0, 30);
  if (urls.length === 0) return;

  // Scarica immagini
  const fetched = await fetchImagesBatch(urls);
  const valid = fetched.filter(r => r.ok);
  if (valid.length === 0) return;

  // Assicura offscreen attivo
  await ensureOffscreen();

  // Invia all'offscreen per analisi
  const images = valid.map(r => ({ url: r.url, dataUrl: r.dataUrl }));

  const result = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_SCAN_PAGE",
    images,
    threshold: DEFAULT_THRESHOLD
  }).catch(() => null);

  if (!result?.ok || !result.results) return;

  // Filtra: solo risultati con match
  const withMatches = result.results.filter(r =>
    r.faces && r.faces.some(f => f.match)
  );
  if (withMatches.length === 0) return;

  // Invia overlay al content script
  chrome.tabs.sendMessage(tabId, {
    type: "SHOW_SCAN_RESULTS",
    results: withMatches
  }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════
// "Chi è?" via offscreen
// ═══════════════════════════════════════════════════════════════════
async function handleRecognizeSingle(msg, sender) {
  let tabId = sender.tab?.id;
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
  }
  if (!tabId) return;

  await ensureOffscreen();

  const result = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_RECOGNIZE",
    dataUrl: msg.dataUrl,
    threshold: DEFAULT_THRESHOLD
  }).catch(() => null);

  if (!result?.ok) {
    chrome.tabs.sendMessage(tabId, {
      type: "SHOW_WHO_RESULT",
      text: "❌ Errore nel riconoscimento",
      isMatch: false
    }).catch(() => {});
    return;
  }

  if (result.noFace) {
    chrome.tabs.sendMessage(tabId, {
      type: "SHOW_WHO_RESULT",
      text: "🤷 Nessun volto rilevato nell'immagine",
      isMatch: false
    }).catch(() => {});
  } else if (result.match) {
    chrome.tabs.sendMessage(tabId, {
      type: "SHOW_WHO_RESULT",
      text: `🎯 ${result.match.name} (confidenza: ${result.match.confidence}%)`,
      isMatch: true
    }).catch(() => {});
  } else {
    chrome.tabs.sendMessage(tabId, {
      type: "SHOW_WHO_RESULT",
      text: "🆕 Volto non riconosciuto – non presente nel DB",
      isMatch: false
    }).catch(() => {});
  }
}
