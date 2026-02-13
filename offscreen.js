/* offscreen.js – Esegue face-api.js in un offscreen document (sempre attivo, senza popup)
 *
 * Gestisce:
 *  - OFFSCREEN_SCAN_PAGE   → scan batch di immagini (auto-scan + manuale)
 *  - OFFSCREEN_RECOGNIZE   → riconosci singola immagine ("Chi è?")
 */

import { listItemsWithDescriptor } from "./db.js";
import { initFaceApi, extractDescriptor, findBestMatch, scanImages } from "./face-recognition.js";

let ready = false;

// ── Init modelli ─────────────────────────────────────────────────
async function ensureReady() {
  if (ready) return;
  await initFaceApi("./models");
  ready = true;
  console.log("[FaceTagger Offscreen] Modelli caricati ✓");
}

// ── Carica subito ────────────────────────────────────────────────
ensureReady().catch(e => console.error("[FaceTagger Offscreen] Init error:", e));

// ── Messaggi dal background ──────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── Scan batch (auto-scan pagina o manuale) ────────────────────
  if (msg.type === "OFFSCREEN_SCAN_PAGE") {
    handleScanPage(msg).then(sendResponse).catch(err => {
      sendResponse({ ok: false, error: String(err?.message || err) });
    });
    return true; // async
  }

  // ── Riconosci singola immagine ─────────────────────────────────
  if (msg.type === "OFFSCREEN_RECOGNIZE") {
    handleRecognize(msg).then(sendResponse).catch(err => {
      sendResponse({ ok: false, error: String(err?.message || err) });
    });
    return true;
  }
});

// ═══════════════════════════════════════════════════════════════════
// Scan pagina: riceve array di { url, dataUrl } + threshold
// ═══════════════════════════════════════════════════════════════════
async function handleScanPage(msg) {
  await ensureReady();

  const known = await listItemsWithDescriptor();
  if (known.length === 0) {
    return { ok: true, results: [], noDb: true };
  }

  const knownFaces = known.map(it => ({
    name: it.name || "(senza nome)",
    descriptor: it.faceDescriptor
  }));

  const threshold = msg.threshold || 0.5;
  const images = msg.images || []; // [{ url, dataUrl }]

  const dataUrls = images.map(r => r.dataUrl);
  const scanResults = await scanImages(dataUrls, knownFaces, threshold);

  // Mappa con URL originale
  const results = scanResults.map((r, i) => ({
    originalUrl: images[i].url,
    faces: r.faces.map(f => ({
      box: { x: f.box.x, y: f.box.y, width: f.box.width, height: f.box.height },
      match: f.match ? { name: f.match.name, distance: f.match.distance } : null
    }))
  }));

  return { ok: true, results };
}

// ═══════════════════════════════════════════════════════════════════
// Riconosci singola immagine
// ═══════════════════════════════════════════════════════════════════
async function handleRecognize(msg) {
  await ensureReady();

  const descriptor = await extractDescriptor(msg.dataUrl);
  if (!descriptor) {
    return { ok: true, match: null, noFace: true };
  }

  const known = await listItemsWithDescriptor();
  const knownFaces = known.map(it => ({
    name: it.name || "(senza nome)",
    descriptor: it.faceDescriptor
  }));

  const threshold = msg.threshold || 0.5;
  const match = findBestMatch(descriptor, knownFaces, threshold);

  if (match) {
    const confidence = Math.round((1 - match.distance) * 100);
    return { ok: true, match: { name: match.name, confidence, distance: match.distance } };
  }
  return { ok: true, match: null };
}
