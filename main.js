import { PaddleOCR } from "@paddleocr/paddleocr-js";

(() => {
"use strict";

const DB_NAME = "scanChassisDB", DB_VERSION = 1, STORE = "fiches";
const OPS = ["Empilage","Double empilage","Retour","Double retour","Soudage / Nettoyage ouvrants","Soudage / Nettoyage dormants"];
const OCR_PLACEHOLDER = "Le texte reconnu apparaîtra ici.";
let db = null, ocrInstance = null, currentPhoto = null, currentPhotoType = "image/jpeg", currentOCRText = "";
let previewUrl = null, liveStream = null, isReading = false, editingId = null, ocrEditOpen = false, photoRotation = 0;

const $ = id => document.getElementById(id);
const status = (id, message, error = false) => {
  const el = $(id);
  if (el) { el.textContent = message; el.style.color = error ? "#b91c1c" : "#15803d"; }
};
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        const store = database.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex("orderNo", "orderNo", { unique: false });
        store.createIndex("frameNo", "frameNo", { unique: false });
      }
    };
    request.onsuccess = () => { db = request.result; resolve(db); };
    request.onerror = () => reject(request.error);
  });
}
function allRecords() {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a,b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)));
    req.onerror = () => reject(req.error);
  });
}
function saveRecord(record) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readwrite").objectStore(STORE)[record.id ? "put" : "add"](record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function getRecord(id) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function deleteRecord(id) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readwrite").objectStore(STORE).delete(id);
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
  });
}
function getOps() {
  return [...document.querySelectorAll('#operations input[type="checkbox"]:checked')].map(el => el.value);
}
function setOps(values) {
  document.querySelectorAll('#operations input[type="checkbox"]').forEach(el => el.checked = values.includes(el.value));
}
function dataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
function setPhoto(data, type = "image/jpeg") {
  currentPhoto = data;
  currentPhotoType = type || "image/jpeg";
  photoRotation = 0;
  $("preview").style.setProperty("--preview-rotation", "0deg");
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  if (data) {
    $("preview").src = data;
    $("preview").style.display = "block";
  } else {
    $("preview").removeAttribute("src");
    $("preview").style.display = "none";
  }
}
function setOcrText(text) {
  currentOCRText = String(text || "");
  $("ocrResult").textContent = currentOCRText || OCR_PLACEHOLDER;
}
function closeOcrEditor() {
  ocrEditOpen = false;
  $("ocrEditor").style.display = "none";
  $("ocrResult").style.display = "block";
  $("editOcrBtn").style.display = "";
  $("saveOcrEditBtn").style.display = "none";
  $("cancelOcrEditBtn").style.display = "none";
}
function resetForm() {
  editingId = null; setPhoto(null); currentOCRText = "";
  $("cameraInput").value = "";
  $("clientName").value = ""; $("orderNo").value = ""; $("frameNo").value = ""; $("notes").value = "";
  setOps([]); $("saveBtn").textContent = "💾 Enregistrer la fiche";
  setOcrText(""); $("ocrEditor").value = ""; closeOcrEditor();
  status("formStatus", ""); status("scanStatus", "");
}
function loadForm(record) {
  editingId = record.id; setPhoto(record.photo || null, record.photoType || "image/jpeg");
  $("clientName").value = record.clientName || ""; $("orderNo").value = record.orderNo || "";
  $("frameNo").value = record.frameNo || ""; $("notes").value = record.notes || "";
  setOcrText(record.ocrText || "");
  $("ocrEditor").value = ""; closeOcrEditor();
  setOps(record.operations || []); $("cameraInput").value = "";
  $("saveBtn").textContent = "💾 Mettre à jour la fiche";
  status("formStatus", "Fiche chargée. Les modifications seront enregistrées sur cette fiche.");
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
}
function renderRecord(record) {
  const article = document.createElement("article"); article.className = "record";
  const ops = (record.operations || []).map(op => `<span class="badge">${escapeHTML(op)}</span>`).join(" ");
  const rawTextBlock = record.ocrText ? `<div class="field"><strong>Texte brut reconnu :</strong><div style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHTML(record.ocrText)}</div></div>` : "";
  article.innerHTML = `<div class="record-top"><div><h3>Commande ${escapeHTML(record.orderNo)}</h3><p>Client : <strong>${escapeHTML(record.clientName || "—")}</strong></p><p>Châssis / code-barres : <strong>${escapeHTML(record.frameNo)}</strong></p><p>${new Date(record.updatedAt || record.createdAt).toLocaleString("fr-BE")}</p></div><span class="badge">${(record.operations || []).length} opération(s)</span></div><p>${ops || "Aucune opération cochée"}</p>${record.notes ? `<p>Remarque : ${escapeHTML(record.notes)}</p>` : ""}${rawTextBlock}${record.photo ? `<img alt="Photo originale de l’étiquette" src="${record.photo}">` : "<p>Pas de photo enregistrée</p>"}<div class="actions"><button type="button" class="secondary edit">✏️ Modifier</button><button type="button" class="danger delete">🗑️ Supprimer</button></div>`;
  article.querySelector(".edit").addEventListener("click", () => loadForm(record));
  article.querySelector(".delete").addEventListener("click", async () => {
    if (!confirm(`Supprimer la fiche commande ${record.orderNo}, châssis ${record.frameNo} ?`)) return;
    try { await deleteRecord(record.id); await refreshRecords(); if (editingId === record.id) resetForm(); }
    catch (e) { alert("Impossible de supprimer la fiche : " + e.message); }
  });
  return article;
}
async function refreshRecords() {
  const container = $("records");
  try {
    const records = await allRecords(), query = $("searchBox").value.trim().toLocaleLowerCase("fr");
    const filtered = records.filter(r => [r.clientName, r.orderNo, r.frameNo, r.ocrText, ...(r.operations || [])].some(v => String(v || "").toLocaleLowerCase("fr").includes(query)));
    container.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement("div"); empty.className = "empty";
      empty.textContent = records.length ? "Aucun résultat pour cette recherche." : "Aucune fiche enregistrée pour le moment.";
      container.appendChild(empty); return;
    }
    filtered.forEach(record => container.appendChild(renderRecord(record)));
  } catch (e) { container.textContent = "Erreur de lecture : " + e.message; }
}
function stopCamera() {
  if (liveStream) liveStream.getTracks().forEach(track => track.stop());
  liveStream = null;
  const video = $("liveVideo");
  if (video) { video.pause(); video.srcObject = null; video.style.display = "none"; }
  $("captureBtn").disabled = true; $("stopScanBtn").disabled = true;
}
function cleanText(value) { return String(value || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim(); }
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function predictionToText(prediction) {
  const parts = [];
  const seen = new Set();
  function collect(value, key = "") {
    if (value == null) return;
    if (typeof value === "string") {
      const text = cleanText(value);
      if (text && /text|transcription|content|rec_text/i.test(key)) parts.push(text);
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(item => collect(item, key));
      return;
    }
    for (const k of ["text", "rec_text", "rec_texts", "texts", "transcription", "content"]) {
      if (Object.prototype.hasOwnProperty.call(value, k)) {
        const v = value[k];
        if (typeof v === "string") { if (cleanText(v)) parts.push(cleanText(v)); }
        else collect(v, k);
      }
    }
    for (const [k, v] of Object.entries(value)) {
      if (["text", "rec_text", "rec_texts", "texts", "transcription", "content"].includes(k)) continue;
      if (v && typeof v === "object") collect(v, k);
    }
  }
  collect(prediction);
  return unique(parts.map(cleanText)).join("\n");
}
// Prépare une copie plus légère pour l’OCR sans modifier la photo originale sauvegardée.
function makeOCRBlob(dataUrl, maxSide = 1500, quality = 0.82, rotationDegrees = 0) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      try {
        const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
        const sourceWidth = Math.max(1, Math.round(image.naturalWidth * scale));
        const sourceHeight = Math.max(1, Math.round(image.naturalHeight * scale));
        const normalizedRotation = ((rotationDegrees % 360) + 360) % 360;
        const sideways = normalizedRotation === 90 || normalizedRotation === 270;
        const canvas = document.createElement("canvas");
        canvas.width = sideways ? sourceHeight : sourceWidth;
        canvas.height = sideways ? sourceWidth : sourceHeight;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("Impossible de préparer l’image pour l’OCR.");
        context.translate(canvas.width / 2, canvas.height / 2);
        context.rotate(normalizedRotation * Math.PI / 180);
        context.drawImage(image, -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight);
        canvas.toBlob(blob => {
          if (blob) resolve(blob);
          else reject(new Error("Impossible de réduire la photo pour l’OCR."));
        }, "image/jpeg", quality);
      } catch (error) { reject(error); }
    };
    image.onerror = () => reject(new Error("La photo ne peut pas être décodée par le navigateur."));
    image.src = dataUrl;
  });
}
function extractFields(raw) {
  const lines = raw.split(/\r?\n/).map(cleanText).filter(Boolean);
  const all = lines.join(" ").toUpperCase();
  const compact = all.replace(/[^A-Z0-9]/g, "");
  const orderMatch = compact.match(/\d{2}CR\d{4,8}/);
  const order = orderMatch ? orderMatch[0] : "";
  const normalized = all.replace(/[^A-Z0-9]/g, "");
  let client = "";
  if (/FRO[I1L]D?MANTEAU/.test(normalized) || normalized.includes("FROIDMANTEAU")) {
    client = "FROIDMANTEAU";
  } else if (normalized.includes("BELONCLECYR") || /BELONCLE.*CYR/.test(all)) {
    client = "BELONCLE CYR";
  }
  const chassis = lines.find(line => /^\d{3}$/.test(line)) || "";
  const codes = unique([...all.matchAll(/\b[A-Z0-9]{8,14}\b/g)].map(m => m[0]).filter(v => /\d/.test(v) && /[A-Z]/.test(v) && v !== order));
  return { lines, order, client, chassis, codes };
}
function applyExtractedFields(raw) {
  const fields = extractFields(raw);
  if (fields.order) $("orderNo").value = fields.order;
  if (fields.client) $("clientName").value = fields.client;
  if (fields.chassis) $("frameNo").value = fields.chassis;
}
// Correction du texte brut : les changements sont validés avant d’être conservés.
function beginOcrEdit() {
  if (isReading) return;
  const visibleText = $("ocrResult").textContent.trim();
  $("ocrEditor").value = visibleText === OCR_PLACEHOLDER ? "" : visibleText;
  ocrEditOpen = true;
  $("ocrResult").style.display = "none";
  $("ocrEditor").style.display = "block";
  $("editOcrBtn").style.display = "none";
  $("saveOcrEditBtn").style.display = "";
  $("cancelOcrEditBtn").style.display = "";
  $("ocrEditor").focus();
}
function saveOcrEdit() {
  if (!ocrEditOpen) return;
  const corrected = $("ocrEditor").value.trim();
  setOcrText(corrected);
  closeOcrEditor();
  if (corrected) applyExtractedFields(corrected);
  status("scanStatus", "Texte brut corrigé. Les corrections seront enregistrées avec la fiche.");
}
function cancelOcrEdit() {
  $("ocrEditor").value = "";
  closeOcrEditor();
}
async function runOCR() {
  if (isReading) return;
  if (!currentPhoto) {
    status("scanStatus", "Choisis d’abord une photo de l’étiquette.", true);
    return;
  }
  const savedPhoto = currentPhoto;
  const savedPhotoType = currentPhotoType;
  isReading = true;
  $("readLabelBtn").disabled = true;
  try {
    $("preview").src = savedPhoto;
    $("preview").style.display = "block";
    status("scanStatus", "Chargement du moteur OCR…");
    if (!ocrInstance) {
      ocrInstance = await PaddleOCR.create({
        lang: "en",
        ocrVersion: "PP-OCRv5",
        ortOptions: { backend: "wasm", wasmPaths: "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/" }
      });
    }
    status("scanStatus", "Analyse de la photo en cours…");
    status("scanStatus", "Préparation d’une copie légère de la photo…");
    setOcrText("Préparation de la photo pour l’analyse… l’original est conservé.");
    const blob = await makeOCRBlob(savedPhoto, 1500, 0.82, photoRotation);
    status("scanStatus", "Analyse OCR en cours sur la copie allégée…");
    setOcrText("Analyse en cours… la photo originale est conservée.");
    const results = await ocrInstance.predict(blob);
    console.log("Résultat brut PaddleOCR :", results);
    const raw = (Array.isArray(results) ? results : [results])
      .flatMap(result => (result?.items || []).map(item => item?.text || ""))
      .filter(Boolean)
      .join("\n");
    setOcrText(raw || "Aucun texte détecté. Essaie une photo plus nette, prise de face et bien éclairée.");
    if (raw) applyExtractedFields(raw);
    status("scanStatus", raw ? "Lecture terminée. Vérifie les champs avant d’enregistrer." : "Aucun texte récupéré. Tu peux réessayer.", !raw);
  } catch (e) {
    console.error("Erreur PaddleOCR", e);
    const errorMessage = e?.message || String(e);
    setOcrText("Erreur pendant la lecture : " + errorMessage);
    status("scanStatus", "Erreur OCR : " + errorMessage, true);
  } finally {
    currentPhoto = savedPhoto;
    currentPhotoType = savedPhotoType;
    if (savedPhoto) {
      $("preview").setAttribute("src", savedPhoto);
      $("preview").style.display = "block";
    }
    isReading = false;
    $("readLabelBtn").disabled = false;
  }
}

$("editOcrBtn").addEventListener("click", beginOcrEdit);
$("saveOcrEditBtn").addEventListener("click", saveOcrEdit);
$("cancelOcrEditBtn").addEventListener("click", cancelOcrEdit);
$("cameraInput").addEventListener("change", async e => {
  const file = e.target.files?.[0]; if (!file) return;
  try {
    setPhoto(await dataURL(file), file.type);
    setOcrText("");
    $("clientName").value = ""; $("orderNo").value = ""; $("frameNo").value = "";
    closeOcrEditor();
    setOcrText("Photo chargée. Appuie sur « Lire le texte de la photo ».");
    status("scanStatus", "Photo chargée. Appuie sur « Lire le texte de la photo » pour analyser.");
  } catch (err) { status("scanStatus", "Impossible de lire la photo : " + err.message, true); }
});
$("clearPhotoBtn").addEventListener("click", () => {
  setPhoto(null); $("cameraInput").value = ""; setOcrText(""); closeOcrEditor();
  status("scanStatus", "Photo retirée de la fiche en cours.");
});
function rotatePreview(degrees) {
  if (!currentPhoto) {
    status("scanStatus", "Choisis ou capture d’abord une photo.", true);
    return;
  }
  photoRotation = (photoRotation + degrees + 360) % 360;
  $("preview").style.setProperty("--preview-rotation", `${photoRotation}deg`);
  status("scanStatus", `Orientation de lecture : ${photoRotation}°. La photo originale reste inchangée.`);
}
$("rotateLeftBtn").addEventListener("click", () => rotatePreview(-90));
$("rotateRightBtn").addEventListener("click", () => rotatePreview(90));
$("readLabelBtn").addEventListener("click", runOCR);
$("copyOcrBtn").addEventListener("click", async () => {
  const text = (ocrEditOpen ? $("ocrEditor").value : $("ocrResult").textContent).trim();
  if (!text || text === OCR_PLACEHOLDER) { status("scanStatus", "Aucun texte à copier.", true); return; }
  try {
    await navigator.clipboard.writeText(text);
    status("scanStatus", "Texte brut copié. Tu peux le coller où tu veux.");
  } catch {
    const range = document.createRange();
    range.selectNodeContents(ocrEditOpen ? $("ocrEditor") : $("ocrResult"));
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    status("scanStatus", "Sélection du texte effectuée. Appuie longuement puis choisis Copier.");
  }
});
$("barcodeBtn").addEventListener("click", async () => {
  if (!currentPhoto) { status("scanStatus", "Choisis d’abord une photo.", true); return; }
  try {
    const mod = await import("https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm");
    const reader = new mod.BrowserMultiFormatReader();
    const result = await reader.decodeFromImageUrl(currentPhoto);
    $("frameNo").value = result.getText();
    status("scanStatus", "Code-barres lu : " + result.getText() + ". Vérifie-le avant d’enregistrer.");
  } catch (e) { status("scanStatus", "Code-barres non détecté sur cette photo. Tu peux utiliser la lecture du texte.", true); }
});
$("startScanBtn").addEventListener("click", async () => {
  stopCamera();
  try {
    liveStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    $("liveVideo").srcObject = liveStream; $("liveVideo").style.display = "block"; await $("liveVideo").play();
    $("captureBtn").disabled = false; $("stopScanBtn").disabled = false;
    status("scanStatus", "Caméra ouverte. Capture l’étiquette pour la lire.");
  } catch (e) { stopCamera(); status("scanStatus", "Impossible d’ouvrir la caméra. Vérifie l’autorisation et utilise le site en HTTPS.", true); }
});
$("captureBtn").addEventListener("click", async () => {
  const video = $("liveVideo");
  if (!video.videoWidth) { status("scanStatus", "Attends que l’image de la caméra apparaisse.", true); return; }
  const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  setPhoto(canvas.toDataURL("image/jpeg", .92), "image/jpeg"); stopCamera();
  setOcrText("Photo capturée. Appuie sur « Lire le texte de la photo ».");
  status("scanStatus", "Photo capturée. Appuie sur « Lire le texte de la photo » pour lancer l’analyse.");
});
$("stopScanBtn").addEventListener("click", () => { stopCamera(); status("scanStatus", "Caméra fermée."); });
$("saveBtn").addEventListener("click", async () => {
  if (ocrEditOpen) saveOcrEdit();
  const orderNo = $("orderNo").value.trim(), frameNo = $("frameNo").value.trim();
  if (!orderNo) { status("formStatus", "Le numéro de commande est obligatoire.", true); $("orderNo").focus(); return; }
  if (!frameNo) { status("formStatus", "Le numéro du châssis est obligatoire.", true); $("frameNo").focus(); return; }
  const now = Date.now();
  try {
    const displayedRaw = $("ocrResult").textContent.trim();
    const isInstruction = displayedRaw === OCR_PLACEHOLDER
      || displayedRaw.startsWith("Photo chargée.")
      || displayedRaw.startsWith("Photo capturée.")
      || displayedRaw.startsWith("Préparation de la photo")
      || displayedRaw.startsWith("Analyse en cours")
      || displayedRaw.startsWith("Erreur pendant la lecture :")
      || displayedRaw.startsWith("Aucun texte détecté.");
    const ocrText = isInstruction ? "" : displayedRaw;
    const record = { clientName: $("clientName").value.trim(), orderNo, frameNo, operations: getOps(), notes: $("notes").value.trim(), ocrText, photo: currentPhoto, photoType: currentPhotoType, updatedAt: now };
    if (editingId) { record.id = editingId; const old = await getRecord(editingId); record.createdAt = old?.createdAt || now; } else record.createdAt = now;
    editingId = await saveRecord(record);
    $("saveBtn").textContent = "💾 Mettre à jour la fiche";
    status("formStatus", "Fiche enregistrée avec succès, photo comprise et texte brut conservé.");
    await refreshRecords();
  } catch (e) { status("formStatus", "Erreur d’enregistrement : " + e.message, true); }
});
$("resetBtn").addEventListener("click", () => { if (confirm("Effacer le formulaire et préparer une nouvelle fiche ?")) resetForm(); });
$("searchBox").addEventListener("input", refreshRecords);
$("exportBtn").addEventListener("click", async () => {
  try {
    const records = await allRecords();
    const blob = new Blob([JSON.stringify({ app: "Scan Châssis", version: 1, exportedAt: new Date().toISOString(), records })], { type: "application/json" });
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = `scan-chassis-sauvegarde-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    status("backupStatus", `${records.length} fiche(s) exportée(s), photos et textes bruts inclus.`);
  } catch (e) { status("backupStatus", "Échec de l’export : " + e.message, true); }
});
$("importInput").addEventListener("change", async e => {
  const file = e.target.files?.[0]; if (!file) return;
  if (!confirm("Importer cette sauvegarde ? Les fiches existantes seront conservées.")) { e.target.value = ""; return; }
  try {
    const parsed = JSON.parse(await file.text());
    if (!Array.isArray(parsed.records)) throw new Error("Format de sauvegarde invalide.");
    let added = 0, skipped = 0;
    for (const item of parsed.records) {
      if (!item?.orderNo || !item?.frameNo) { skipped++; continue; }
      const existing = await allRecords();
      if (existing.some(r => r.orderNo === item.orderNo && r.frameNo === item.frameNo && JSON.stringify(r.operations || []) === JSON.stringify(item.operations || []))) { skipped++; continue; }
      await saveRecord({ clientName: String(item.clientName || ""), orderNo: String(item.orderNo), frameNo: String(item.frameNo), operations: OPS.filter(op => (item.operations || []).includes(op)), notes: String(item.notes || ""), ocrText: String(item.ocrText || ""), photo: item.photo || null, photoType: item.photoType || "image/jpeg", createdAt: Number(item.createdAt) || Date.now(), updatedAt: Number(item.updatedAt) || Date.now() });
      added++;
    }
    await refreshRecords(); status("backupStatus", `Import terminé : ${added} ajoutée(s), ${skipped} ignorée(s).`);
  } catch (err) { status("backupStatus", "Import impossible : " + err.message, true); }
  finally { e.target.value = ""; }
});
(async () => {
  try { await openDB(); await refreshRecords(); }
  catch (e) { status("formStatus", "Impossible d’ouvrir la base locale : " + e.message, true); }
})();
})();
