import { addItem, listItems, listItemsWithDescriptor, resetDB, exportAll, importAll } from "./db.js";
import { initFaceApi, extractDescriptor, extractAllFaces, findBestMatch, scanImages, drawFaceLandmarks } from "./face-recognition.js";

// ── DOM ──────────────────────────────────────────────────────────
const preview       = document.getElementById("preview");
const selInfo       = document.getElementById("selInfo");
const errEl         = document.getElementById("err");
const matchInfoEl   = document.getElementById("matchInfo");
const matchSugEl    = document.getElementById("matchSuggestion");
const nameEl        = document.getElementById("name");
const tagsEl        = document.getElementById("tags");
const notesEl       = document.getElementById("notes");
const listEl        = document.getElementById("list");
const importBtn     = document.getElementById("importBtn");
const importFile    = document.getElementById("importFile");
const modelStatus   = document.getElementById("modelStatus");
const scanStatus    = document.getElementById("scanStatus");
const thresholdEl   = document.getElementById("threshold");
const thresholdValEl = document.getElementById("thresholdVal");

let selection = null;
let selectionDataUrl = null;
let faceApiReady = false;
let detectedFaces = [];    // array da extractAllFaces
let selectedFaceIdx = 0;   // indice del volto scelto dall'utente

// ── Threshold ────────────────────────────────────────────────────
thresholdEl.addEventListener("input", () => {
  thresholdValEl.textContent = parseFloat(thresholdEl.value).toFixed(2);
});
function getThreshold() { return parseFloat(thresholdEl.value) || 0.5; }

// ── Utility ──────────────────────────────────────────────────────
function showErr(msg) {
  errEl.style.display = msg ? "block" : "none";
  errEl.textContent = msg || "";
}
function showMatch(msg) {
  matchInfoEl.style.display = msg ? "block" : "none";
  matchInfoEl.textContent = msg || "";
}
function uid() {
  return "ft_" + Date.now() + "_" + Math.random().toString(16).slice(2);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;" }[c]));
}

// ── Caricamento modelli ──────────────────────────────────────────
async function loadModels() {
  try {
    modelStatus.textContent = "⏳ Caricamento modelli face-api.js…";
    await initFaceApi("./models");
    modelStatus.textContent = "✅ Modelli caricati – riconoscimento attivo";
    modelStatus.style.color = "#059669";
    faceApiReady = true;
  } catch (e) {
    modelStatus.textContent = `❌ Errore caricamento modelli: ${e.message}`;
    modelStatus.style.color = "#b91c1c";
    console.error("[FaceTagger] Model load error:", e);
  }
}

// ── Fetch immagine via background ────────────────────────────────
function fetchImageAsDataUrl(url) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "FETCH_IMAGE_AS_DATAURL", url }, (resp) => {
      resolve(resp?.ok ? { ok: true, dataUrl: resp.dataUrl } : { ok: false, error: resp?.error || "Fetch error" });
    });
  });
}

// ── Thumbnail ────────────────────────────────────────────────────
async function makeThumbnail(dataUrl, maxPx = 512, quality = 0.85) {
  const img = new Image();
  img.decoding = "async";
  img.src = dataUrl;
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });

  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const scale = Math.min(1, maxPx / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement("canvas");
  canvas.width = tw; canvas.height = th;
  canvas.getContext("2d", { alpha: false }).drawImage(img, 0, 0, tw, th);

  return {
    thumbDataUrl: canvas.toDataURL("image/jpeg", quality),
    width: tw, height: th, origWidth: w, origHeight: h
  };
}

// ── Selezione da tab ─────────────────────────────────────────────
async function getSelectionFromTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  const resp = await chrome.tabs.sendMessage(tab.id, { type: "GET_LAST_SELECTION" }).catch(() => null);
  return resp?.selection || null;
}

// ── Auto-match: rileva volti e mostra picker se multipli ─────────
async function autoMatchFace(dataUrl) {
  if (!faceApiReady || !dataUrl) return;
  showMatch(null);
  matchSugEl.style.display = "none";
  detectedFaces = [];
  selectedFaceIdx = 0;

  // Rimuovi picker precedente
  const oldPicker = document.getElementById("facePicker");
  if (oldPicker) oldPicker.remove();

  try {
    detectedFaces = await extractAllFaces(dataUrl);

    if (detectedFaces.length === 0) {
      showMatch("ℹ️ Nessun volto rilevato nell'immagine");
      return;
    }

    // Se più di un volto, mostra il picker
    if (detectedFaces.length > 1) {
      showFacePicker(detectedFaces);
    }

    // Auto-match sul volto selezionato (il primo = più grande)
    matchSelectedFace();
  } catch (e) {
    console.warn("[FaceTagger] Auto-match error:", e);
  }
}

// ── Mostra picker visuale dei volti rilevati ─────────────────────
function showFacePicker(faces) {
  const oldPicker = document.getElementById("facePicker");
  if (oldPicker) oldPicker.remove();

  const picker = document.createElement("div");
  picker.id = "facePicker";
  picker.style.cssText = `
    display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0;
    padding: 8px; background: #f8fafc; border: 1px solid #e2e8f0;
    border-radius: 8px;
  `;

  const label = document.createElement("div");
  label.style.cssText = "width: 100%; font-size: 12px; font-weight: 600; color: #475569; margin-bottom: 2px;";
  label.textContent = `👥 ${faces.length} volti rilevati – clicca per scegliere:`;
  picker.appendChild(label);

  faces.forEach((face, idx) => {
    const wrap = document.createElement("div");
    wrap.style.cssText = `
      cursor: pointer; border-radius: 8px; overflow: hidden;
      border: 3px solid ${idx === selectedFaceIdx ? "#2563eb" : "#e2e8f0"};
      transition: border-color 0.15s;
      position: relative;
    `;
    wrap.dataset.idx = idx;

    const img = document.createElement("img");
    img.src = face.cropDataUrl;
    img.style.cssText = "width: 64px; height: 64px; display: block; object-fit: cover;";
    wrap.appendChild(img);

    // Numero
    const num = document.createElement("div");
    num.style.cssText = `
      position: absolute; top: 2px; left: 2px;
      background: ${idx === selectedFaceIdx ? "#2563eb" : "rgba(0,0,0,0.5)"};
      color: #fff; font-size: 10px; font-weight: 700;
      width: 18px; height: 18px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
    `;
    num.textContent = idx + 1;
    wrap.appendChild(num);

    wrap.addEventListener("click", () => {
      selectedFaceIdx = idx;
      // Aggiorna bordi
      picker.querySelectorAll("[data-idx]").forEach(el => {
        const i = parseInt(el.dataset.idx);
        el.style.borderColor = i === idx ? "#2563eb" : "#e2e8f0";
        el.querySelector("div").style.background = i === idx ? "#2563eb" : "rgba(0,0,0,0.5)";
      });
      // Ri-match con il nuovo volto
      matchSelectedFace();
    });

    picker.appendChild(wrap);
  });

  // Inserisci dopo il preview
  preview.parentNode.insertBefore(picker, preview.nextSibling);
}

// ── Match del volto selezionato contro il DB ─────────────────────
async function matchSelectedFace() {
  showMatch(null);
  matchSugEl.style.display = "none";

  if (detectedFaces.length === 0) return;
  const face = detectedFaces[selectedFaceIdx];
  if (!face?.descriptor) return;

  const known = await listItemsWithDescriptor();
  if (known.length === 0) {
    showMatch(`ℹ️ Volto #${selectedFaceIdx + 1} rilevato! Nessun profilo nel DB per il confronto.`);
    return;
  }

  const knownFaces = known.map(it => ({
    name: it.name || "(senza nome)",
    descriptor: it.faceDescriptor,
  }));

  const match = findBestMatch(face.descriptor, knownFaces, getThreshold());

  if (match) {
    const confidence = Math.round((1 - match.distance) * 100);
    matchSugEl.innerHTML = `
      <b>🎯 Possibile match: ${escapeHtml(match.name)}</b> (confidenza: ${confidence}%)
      <br><span class="small">Clicca "Salva" per confermare o modifica il nome.</span>
    `;
    matchSugEl.style.display = "block";
    if (!nameEl.value.trim()) nameEl.value = match.name;
  } else {
    showMatch(`🆕 Volto #${selectedFaceIdx + 1} – nessun match nel DB (nuova persona?)`);
  }
}

// ── Load preview + auto-match ────────────────────────────────────
async function loadPreview() {
  showErr(null);
  showMatch(null);
  matchSugEl.style.display = "none";
  selectionDataUrl = null;
  detectedFaces = [];
  selectedFaceIdx = 0;
  const oldPicker = document.getElementById("facePicker");
  if (oldPicker) oldPicker.remove();

  selection = await getSelectionFromTab();

  if (!selection?.srcUrl) {
    selInfo.textContent = "Nessuna selezione. Tasto destro su un'immagine → \"Tagga…\"";
    preview.style.display = "none";
    return;
  }

  selInfo.textContent = (selection.pageTitle || "").trim() || selection.pageUrl;

  const fetched = await fetchImageAsDataUrl(selection.srcUrl);
  if (!fetched.ok) {
    showErr(`Non riesco a scaricare l'immagine. Salverò solo l'URL. Dettagli: ${fetched.error}`);
    preview.src = selection.srcUrl;
    preview.style.display = "block";
    return;
  }

  selectionDataUrl = fetched.dataUrl;
  preview.src = selectionDataUrl;
  preview.style.display = "block";

  // Disegna landmarks gialli sulla preview (se modelli caricati)
  if (faceApiReady) {
    try {
      const annotated = await drawFaceLandmarks(selectionDataUrl, "#FFD600");
      preview.src = annotated;
    } catch (e) {
      console.warn("[FaceTagger] Landmarks draw error:", e);
    }
  }

  // Auto-match asincrono
  autoMatchFace(selectionDataUrl);
}

// ── Salva (con descriptor del volto selezionato) ─────────────────
document.getElementById("save").addEventListener("click", async () => {
  if (!selection?.srcUrl) return;

  const name = nameEl.value.trim();
  const tags = tagsEl.value.split(",").map(t => t.trim()).filter(Boolean);
  const notes = notesEl.value.trim();

  let thumbDataUrl = null;
  let meta = null;
  let faceDescriptor = null;

  if (selectionDataUrl) {
    try {
      const t = await makeThumbnail(selectionDataUrl, 512, 0.85);
      thumbDataUrl = t.thumbDataUrl;
      meta = { w: t.width, h: t.height, ow: t.origWidth, oh: t.origHeight };
    } catch (e) {
      showErr("Thumbnail non creata.");
    }

    // Usa il descriptor del volto selezionato (se disponibile)
    if (faceApiReady && detectedFaces.length > 0) {
      const selectedFace = detectedFaces[selectedFaceIdx];
      if (selectedFace?.descriptor) {
        faceDescriptor = Array.from(selectedFace.descriptor);
      }
    } else if (faceApiReady) {
      // Fallback: estrai dal volto più grande
      try {
        const desc = await extractDescriptor(selectionDataUrl);
        if (desc) faceDescriptor = Array.from(desc);
      } catch (e) {
        console.warn("[FaceTagger] Descriptor extraction failed:", e);
      }
    }
  }

  const item = {
    id: uid(),
    ts: Date.now(),
    name,
    tags,
    notes,
    imageUrl: selection.srcUrl,
    thumbDataUrl,
    imgMeta: meta,
    faceDescriptor,
    pageUrl: selection.pageUrl,
    pageTitle: selection.pageTitle
  };

  await addItem(item);

  nameEl.value = "";
  tagsEl.value = "";
  notesEl.value = "";
  showMatch(null);
  matchSugEl.style.display = "none";
  detectedFaces = [];
  selectedFaceIdx = 0;
  const oldPicker = document.getElementById("facePicker");
  if (oldPicker) oldPicker.remove();
  await refreshList();
});

// ── Scan pagina ──────────────────────────────────────────────────
document.getElementById("scanPage").addEventListener("click", async () => {
  if (!faceApiReady) {
    scanStatus.textContent = "⚠️ Modelli non ancora caricati, attendi…";
    return;
  }

  const known = await listItemsWithDescriptor();
  if (known.length === 0) {
    scanStatus.textContent = "⚠️ Nessun volto nel DB. Tagga almeno un volto prima.";
    return;
  }

  scanStatus.textContent = "📷 Raccolta immagini dalla pagina…";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const imgResp = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_IMAGES" }).catch(() => null);
  if (!imgResp?.urls?.length) {
    scanStatus.textContent = "Nessuna immagine trovata nella pagina.";
    return;
  }

  const urls = imgResp.urls.slice(0, 50);
  scanStatus.textContent = `⏳ Scarico ${urls.length} immagini…`;

  // Scarica via background (cross-origin)
  const batchResp = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "FETCH_IMAGES_BATCH", urls }, resolve);
  });

  if (!batchResp?.ok) {
    scanStatus.textContent = "❌ Errore download immagini.";
    return;
  }

  const validImages = batchResp.results.filter(r => r.ok);
  scanStatus.textContent = `🧠 Analisi volti in ${validImages.length} immagini…`;

  const knownFaces = known.map(it => ({
    name: it.name || "(senza nome)",
    descriptor: it.faceDescriptor
  }));

  const dataUrls = validImages.map(r => r.dataUrl);
  const results = await scanImages(dataUrls, knownFaces, getThreshold());

  // Mappa risultati con URL originale per il content script
  const mappedResults = results.map((r, i) => ({
    ...r,
    originalUrl: validImages[i].url
  }));

  const totalFaces = mappedResults.reduce((s, r) => s + r.faces.length, 0);
  const recognized = mappedResults.reduce((s, r) => s + r.faces.filter(f => f.match).length, 0);
  scanStatus.textContent = `✅ Trovati ${totalFaces} volti, ${recognized} riconosciuti.`;

  // Invia overlay al content script
  chrome.tabs.sendMessage(tab.id, {
    type: "SHOW_SCAN_RESULTS",
    results: mappedResults.map(r => ({
      originalUrl: r.originalUrl,
      faces: r.faces.map(f => ({
        box: { x: f.box.x, y: f.box.y, width: f.box.width, height: f.box.height },
        match: f.match ? { name: f.match.name, distance: f.match.distance } : null
      }))
    }))
  });
});

// ── "Chi è?" – riceve dal content script ─────────────────────────
chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === "RECOGNIZE_SINGLE" && faceApiReady) {
    try {
      const descriptor = await extractDescriptor(msg.dataUrl);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!descriptor) {
        chrome.tabs.sendMessage(tab.id, {
          type: "SHOW_WHO_RESULT",
          text: "🤷 Nessun volto rilevato nell'immagine",
          isMatch: false
        });
        return;
      }

      const known = await listItemsWithDescriptor();
      const knownFaces = known.map(it => ({
        name: it.name || "(senza nome)",
        descriptor: it.faceDescriptor
      }));

      const match = findBestMatch(descriptor, knownFaces, getThreshold());

      if (match) {
        const confidence = Math.round((1 - match.distance) * 100);
        chrome.tabs.sendMessage(tab.id, {
          type: "SHOW_WHO_RESULT",
          text: `🎯 ${match.name} (confidenza: ${confidence}%)`,
          isMatch: true
        });
      } else {
        chrome.tabs.sendMessage(tab.id, {
          type: "SHOW_WHO_RESULT",
          text: "🆕 Volto non riconosciuto – non presente nel DB",
          isMatch: false
        });
      }
    } catch (e) {
      console.error("[FaceTagger] Recognize error:", e);
    }
  }
});

// ── Lista ────────────────────────────────────────────────────────
async function refreshList() {
  const items = await listItems(50);
  listEl.innerHTML = items.map(it => `
    <div class="card">
      ${it.thumbDataUrl ? `<img src="${it.thumbDataUrl}" />` : ""}
      <div class="small">
        <b>${escapeHtml(it.name || "(senza nome)")}</b> – ${new Date(it.ts).toLocaleString()}
        ${it.faceDescriptor ? " 🧠" : ""}
      </div>
      <div class="small">${escapeHtml((it.tags || []).join(", "))}</div>
      <div class="small"><a href="${it.pageUrl}" target="_blank">apri pagina</a></div>
    </div>
  `).join("");
}

// ── Export / Import / Reset ──────────────────────────────────────
document.getElementById("reset").addEventListener("click", async () => {
  if (!confirm("Cancellare tutto il database?")) return;
  await resetDB();
  await refreshList();
});

document.getElementById("export").addEventListener("click", async () => {
  const data = await exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: `face_tagger_export_${Date.now()}.json`, saveAs: true });
  setTimeout(() => URL.revokeObjectURL(url), 30000);
});

importBtn.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", async () => {
  const file = importFile.files?.[0];
  if (!file) return;
  try {
    const items = JSON.parse(await file.text());
    if (!Array.isArray(items)) throw new Error("JSON deve essere un array");
    await importAll(items);
    await refreshList();
  } catch (e) {
    showErr(`Import fallito: ${e.message}`);
  } finally {
    importFile.value = "";
  }
});

// ── Live update selezione ────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "SELECTION_UPDATED") {
    selection = msg.selection;
    loadPreview();
  }
});

// ── Init ─────────────────────────────────────────────────────────
(async function init() {
  await loadModels();
  await loadPreview();
  await refreshList();
})();
