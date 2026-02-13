/*  face-recognition.js – Modulo riconoscimento volti con face-api.js
 *
 *  Funzioni: initFaceApi, detectFaces, extractDescriptor, findBestMatch, scanImages
 */

/* global faceapi */

let modelsLoaded = false;

/**
 * Carica i modelli face-api.js.
 * @param {string} modelPath – percorso alla cartella models/
 */
export async function initFaceApi(modelPath) {
  if (modelsLoaded) return;

  await faceapi.nets.ssdMobilenetv1.loadFromUri(modelPath);
  await faceapi.nets.faceLandmark68Net.loadFromUri(modelPath);
  await faceapi.nets.faceRecognitionNet.loadFromUri(modelPath);

  modelsLoaded = true;
  console.log("[FaceTagger] Modelli face-api.js caricati ✓");
}

/**
 * Rileva tutti i volti in un elemento (img, canvas, video).
 * Restituisce array di { detection, landmarks, descriptor: Float32Array }
 */
export async function detectFaces(input) {
  return faceapi
    .detectAllFaces(input, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptors();
}

/**
 * Estrai il descriptor del volto principale (più grande) da un dataUrl.
 * @returns {Float32Array|null} vettore 128-d oppure null
 */
export async function extractDescriptor(dataUrl) {
  const img = await loadImage(dataUrl);
  const detections = await detectFaces(img);
  if (detections.length === 0) return null;

  // Prendi il volto con area maggiore
  let best = detections[0];
  let bestArea = best.detection.box.width * best.detection.box.height;
  for (let i = 1; i < detections.length; i++) {
    const area = detections[i].detection.box.width * detections[i].detection.box.height;
    if (area > bestArea) { best = detections[i]; bestArea = area; }
  }
  return best.descriptor;
}

/**
 * Rileva TUTTI i volti in un dataUrl e restituisce per ognuno:
 *   { descriptor: Float32Array, box, cropDataUrl }
 * cropDataUrl è una miniatura ritagliata del volto (JPEG).
 * @returns {Array<{descriptor, box, cropDataUrl}>}
 */
export async function extractAllFaces(dataUrl) {
  const img = await loadImage(dataUrl);
  const detections = await detectFaces(img);
  if (detections.length === 0) return [];

  const results = [];
  for (const det of detections) {
    const box = det.detection.box;

    // Ritaglia il volto con un po' di margine
    const pad = 0.25; // 25% di margine
    const x = Math.max(0, Math.round(box.x - box.width * pad));
    const y = Math.max(0, Math.round(box.y - box.height * pad));
    const w = Math.min(img.naturalWidth - x, Math.round(box.width * (1 + pad * 2)));
    const h = Math.min(img.naturalHeight - y, Math.round(box.height * (1 + pad * 2)));

    const canvas = document.createElement("canvas");
    const size = 128; // miniatura 128x128
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.drawImage(img, x, y, w, h, 0, 0, size, size);
    const cropDataUrl = canvas.toDataURL("image/jpeg", 0.9);

    results.push({
      descriptor: det.descriptor,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      cropDataUrl
    });
  }

  // Ordina per area (volto più grande primo)
  results.sort((a, b) => (b.box.width * b.box.height) - (a.box.width * a.box.height));
  return results;
}

/**
 * Confronta un descriptor con profili noti.
 * @param {Float32Array} queryDescriptor
 * @param {Array<{name: string, descriptor: number[]|Float32Array}>} knownFaces
 * @param {number} threshold – distanza euclidea max (default 0.6)
 * @returns {{ name: string, distance: number }|null}
 */
export function findBestMatch(queryDescriptor, knownFaces, threshold = 0.5) {
  if (!knownFaces.length) return null;

  let bestName = null;
  let bestDist = Infinity;

  for (const kf of knownFaces) {
    const known = kf.descriptor instanceof Float32Array
      ? kf.descriptor
      : new Float32Array(kf.descriptor);
    const dist = faceapi.euclideanDistance(queryDescriptor, known);
    if (dist < bestDist) { bestDist = dist; bestName = kf.name; }
  }

  return bestDist <= threshold ? { name: bestName, distance: bestDist } : null;
}

/**
 * Scansiona un array di dataUrl, rileva volti e confronta con profili noti.
 * @param {string[]} dataUrls
 * @param {Array<{name, descriptor}>} knownFaces
 * @param {number} threshold
 * @returns {Array<{ dataUrl, faces: Array<{box, match}> }>}
 */
export async function scanImages(dataUrls, knownFaces, threshold = 0.5) {
  const results = [];
  for (const dataUrl of dataUrls) {
    try {
      const img = await loadImage(dataUrl);
      const detections = await detectFaces(img);
      const faces = detections.map(det => ({
        box: det.detection.box,
        match: findBestMatch(det.descriptor, knownFaces, threshold)
      }));
      results.push({ dataUrl, faces });
    } catch (e) {
      results.push({ dataUrl, faces: [], error: e.message });
    }
  }
  return results;
}

/** Helper: carica immagine da URL/dataUrl */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Impossibile caricare immagine"));
    img.src = src;
  });
}

/**
 * Disegna rettangoli e 68 face landmarks su un'immagine.
 * Restituisce un dataUrl con le annotazioni disegnate sopra.
 * @param {string} dataUrl – immagine sorgente
 * @param {string} color – colore CSS (default: giallo intenso)
 * @returns {Promise<string>} dataUrl annotato
 */
export async function drawFaceLandmarks(dataUrl, color = "#FFD600") {
  const img = await loadImage(dataUrl);
  const detections = await detectFaces(img);

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  for (const det of detections) {
    const box = det.detection.box;

    // ── Rettangolo volto ─────────────────────────────────────────
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, Math.round(Math.min(canvas.width, canvas.height) / 200));
    ctx.setLineDash([]);
    ctx.strokeRect(box.x, box.y, box.width, box.height);

    // ── 68 Landmarks ─────────────────────────────────────────────
    const points = det.landmarks.positions;
    const dotSize = Math.max(1.5, Math.round(Math.min(canvas.width, canvas.height) / 300));

    ctx.fillStyle = color;
    for (const pt of points) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, dotSize, 0, Math.PI * 2);
      ctx.fill();
    }

    // ── Linee di connessione landmarks (contorno, sopracciglia, occhi, naso, bocca) ──
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, dotSize * 0.6);
    ctx.globalAlpha = 0.7;

    // Gruppi di landmarks connessi
    const groups = [
      // Contorno viso (0-16)
      [...Array(17).keys()],
      // Sopracciglio sinistro (17-21)
      [17, 18, 19, 20, 21],
      // Sopracciglio destro (22-26)
      [22, 23, 24, 25, 26],
      // Naso ponte (27-30)
      [27, 28, 29, 30],
      // Naso base (31-35)
      [31, 32, 33, 34, 35],
      // Occhio sinistro (36-41, chiuso)
      [36, 37, 38, 39, 40, 41, 36],
      // Occhio destro (42-47, chiuso)
      [42, 43, 44, 45, 46, 47, 42],
      // Labbro esterno (48-59, chiuso)
      [48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 48],
      // Labbro interno (60-67, chiuso)
      [60, 61, 62, 63, 64, 65, 66, 67, 60]
    ];

    for (const group of groups) {
      ctx.beginPath();
      for (let i = 0; i < group.length; i++) {
        const pt = points[group[i]];
        if (i === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      ctx.stroke();
    }

    ctx.globalAlpha = 1.0;
  }

  return canvas.toDataURL("image/jpeg", 0.92);
}
