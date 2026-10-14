import { PaddleOCR } from "@paddleocr/paddleocr-js";

(() => {
"use strict";

const DB_NAME = "scanChassisDB", DB_VERSION = 1, STORE = "fiches";
const OPS = ["Empilage","Double empilage","Retour","Double retour","Soudage / Nettoyage ouvrants","Soudage / Nettoyage dormants"];
let db = null, ocrInstance = null, currentPhoto = null, currentPhotoType = "image/jpeg";
let previewUrl = null, liveStream = null, isReading = false, editingId = null;

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
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  if (data) {
    $("preview").src = data;
    $("preview").style.display = "block";
  } else {
    $("preview").removeAttribute("src");
    $("preview").style.display = "none";
  }
}
function resetForm() {
  editingId = null; setPhoto(null);
  $("cameraInput").value = "";
  $("clientName").value = ""; $("orderNo").value = ""; $("frameNo").value = ""; $("notes").value = "";
  setOps([]); $("saveBtn").textContent = "ð¾ Enregistrer la fiche";
  $("ocrResult").textContent = "Le texte reconnu apparaÃ®tra ici.";
  status("formStatus", ""); status("scanStatus", "");
}
function loadForm(record) {
  editingId = record.id; setPhoto(record.photo || null, record.photoType || "image/jpeg");
  $("clientName").value = record.clientName || ""; $("orderNo").value = record.orderNo || "";
  $("frameNo").value = record.frameNo || ""; $("notes").value = record.notes || "";
  setOps(record.operations || []); $("cameraInput").value = "";
  $("saveBtn").textContent = "ð¾ Mettre Ã  jour la fiche";
  status("formStatus", "Fiche chargÃ©e. Les modifications seront enregistrÃ©es sur cette fiche.");
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
}
function renderRecord(record) {
  const article = document.createElement("article"); article.className = "record";
  const ops = (record.operations || []).map(op => `<span class="badge">${escapeHTML(op)}</span>`).join(" ");
  article.innerHTML = `<div class="record-top"><div><h3>Commande ${escapeHTML(record.orderNo)}</h3><p>Client : <strong>${escapeHTML(record.clientName || "â")}</strong></p><p>ChÃ¢ssis / code-barres : <strong>${escapeHTML(record.frameNo)}</strong></p><p>${new Date(record.updatedAt || record.createdAt).toLocaleString("fr-BE")}</p></div><span class="badge">${(record.operations || []).length} opÃ©ration(s)</span></div><p>${ops || "Aucune opÃ©ration cochÃ©e"}</p>${record.notes ? `<p>Remarque : ${escapeHTML(record.notes)}</p>` : ""}${record.photo ? `<img alt="Photo originale de lâÃ©tiquette" src="${record.photo}">` : "<p>Pas de photo enregistrÃ©e</p>"}<div class="actions"><button type="button" class="secondary edit">âï¸ Modifier</button><button type="button" class="danger delete">ðï¸ Supprimer</button></div>`;
  article.querySelector(".edit").addEventListener("click", () => loadForm(record));
  article.querySelector(".delete").addEventListener("click", async () => {
    if (!confirm(`Supprimer la fiche commande ${record.orderNo}, chÃ¢ssis ${record.frameNo} ?`)) return;
    try { await deleteRecord(record.id); await refreshRecords(); if (editingId === record.id) resetForm(); }
    catch (e) { alert("Impossible de supprimer la fiche : " + e.message); }
  });
  return article;
}
async function refreshRecords() {
  const container = $("records");
  try {
    const records = await allRecords(), query = $("searchBox").value.trim().toLocaleLowerCase("fr");
    const filtered = records.filter(r => [r.clientName, r.orderNo, r.frameNo, ...(r.operations || [])].some(v => String(v || "").toLocaleLowerCase("fr").includes(query)));
    container.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement("div"); empty.className = "empty";
      empty.textContent = records.length ? "Aucun rÃ©sultat pour cette recherche." : "Aucune fiche enregistrÃ©e pour le moment.";
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
  function collect(value) {
    if (!value) return;
    if (typeof value === "string") { parts.push(value); return; }
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (typeof value.text === "string" && value.text.trim()) parts.push(value.text);
    if (Array.isArray(value.items)) value.items.forEach(collect);
  }
  collect(prediction);
  return unique(parts.map(cleanText)).join("\n");
}
function extractFields(raw) {
  const lines = raw.split(/\r?\n/).map(cleanText).filter(Boolean);
  const all = lines.join(" ").toUpperCase();
  const compact = all.replace(/[^A-Z0-9]/g, "");
  let order = compact.match(/\d{2}CR\d{4,8}/)?.[0] || "";
  if (!order) {
    const merged = compact.match(/\d{2}(\d{2}CR\d{4,8})/);
    if (merged) order = merged[1];
  }
  let client = "";
  if (/FRO[I1L]D?MANTEAU/.test(all.replace(/[^A-Z0-9]/g, "")) || all.replace(/[^A-Z0-9]/g, "").includes("FROIDMANTEAU")) client = "FROIDMANTEAU";
  const chassis = lines.find(line => /^\d{3}$/.test(line)) || "";
  const codes = unique([...all.matchAll(/\b[A-Z0-9]{8,14}\b/g)].map(m => m[0]).filter(v => /\d/.test(v) && /[A-Z]/.test(v) && v !== order));
  return { lines, order, client, chassis, codes };
}
async function runOCR() {
  if (isReading) return;
  if (!currentPhoto) { status("scanStatus", "Choisis dâabord une photo de lâÃ©tiquette.", true); return; }
  isReading = true; $("readLabelBtn").disabled = true;
  try {
    status("scanStatus", "Chargement du moteur OCRâ¦");
    if (!ocrInstance) {
      ocrInstance = await PaddleOCR.create({
        lang: "en", ocrVersion: "PP-OCRv5",
        ortOptions: { backend: "wasm", wasmPaths: "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/" }
      });
    }
    status("scanStatus", "Analyse de la photo en coursâ¦");
    const response = await fetch(currentPhoto);
    const blob = await response.blob();
    const prediction = await ocrInstance.predict(blob);
    const raw = predictionToText(prediction);
    $("ocrResult").textContent = raw || "Aucun texte dÃ©tectÃ©. Essaie une photo plus nette, prise de face et bien Ã©clairÃ©e.";
    const fields = extractFields(raw);
    if (fields.order) $("orderNo").value = fields.order;
    if (fields.client) $("clientName").value = fields.client;
    if (fields.chassis) $("frameNo").value = fields.chassis;
    status("scanStatus", raw ? "Lecture terminÃ©e. VÃ©rifie les champs et le texte brut avant dâenregistrer." : "Aucun texte rÃ©cupÃ©rÃ©. Tu peux rÃ©essayer.", !raw);
  } catch (e) {
    console.error("Erreur PaddleOCR", e);
    status("scanStatus", "Erreur OCR : " + (e?.message || String(e)) + ". La photo est conservÃ©e.", true);
    if (!$("ocrResult").textContent || $("ocrResult").textContent === "Le texte reconnu apparaÃ®tra ici.") $("ocrResult").textContent = "La lecture a Ã©chouÃ©. RÃ©essaie.";
  } finally { isReading = false; $("readLabelBtn").disabled = false; }
}

$("cameraInput").addEventListener("change", async e => {
  const file = e.target.files?.[0]; if (!file) return;
  try {
    setPhoto(await dataURL(file), file.type);
    $("clientName").value = ""; $("orderNo").value = ""; $("frameNo").value = "";
    $("ocrResult").textContent = "Photo chargÃ©e. Appuie sur Â« Lire le texte de la photo Â».";
    status("scanStatus", "Photo chargÃ©e. Appuie sur Â« Lire le texte de la photo Â» pour analyser.");
  } catch (err) { status("scanStatus", "Impossible de lire la photo : " + err.message, true); }
});
$("clearPhotoBtn").addEventListener("click", () => {
  setPhoto(null); $("cameraInput").value = ""; $("ocrResult").textContent = "Le texte reconnu apparaÃ®tra ici.";
  status("scanStatus", "Photo retirÃ©e de la fiche en cours.");
});
$("readLabelBtn").addEventListener("click", runOCR);
$("copyOcrBtn").addEventListener("click", async () => {
  const text = $("ocrResult").textContent.trim();
  if (!text || text === "Le texte reconnu apparaÃ®tra ici.") { status("scanStatus", "Aucun texte Ã  copier.", true); return; }
  try {
    await navigator.clipboard.writeText(text);
    status("scanStatus", "Texte brut copiÃ©. Tu peux le coller oÃ¹ tu veux.");
  } catch {
    const range = document.createRange(); range.selectNodeContents($("ocrResult"));
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    status("scanStatus", "SÃ©lection du texte effectuÃ©e. Appuie longuement puis choisis Copier.");
  }
});
$("barcodeBtn").addEventListener("click", async () => {
  if (!currentPhoto) { status("scanStatus", "Choisis dâabord une photo.", true); return; }
  try {
    const mod = await import("https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm");
    const reader = new mod.BrowserMultiFormatReader();
    const result = await reader.decodeFromImageUrl(currentPhoto);
    $("frameNo").value = result.getText();
    status("scanStatus", "Code-barres lu : " + result.getText() + ". VÃ©rifie-le avant dâenregistrer.");
  } catch (e) { status("scanStatus", "Code-barres non dÃ©tectÃ© sur cette photo. Tu peux utiliser la lecture du texte.", true); }
});
$("startScanBtn").addEventListener("click", async () => {
  stopCamera();
  try {
    liveStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    $("liveVideo").srcObject = liveStream; $("liveVideo").style.display = "block"; await $("liveVideo").play();
    $("captureBtn").disabled = false; $("stopScanBtn").disabled = false;
    status("scanStatus", "CamÃ©ra ouverte. Capture lâÃ©tiquette pour la lire.");
  } catch (e) { stopCamera(); status("scanStatus", "Impossible dâouvrir la camÃ©ra. VÃ©rifie lâautorisation et utilise le site en HTTPS.", true); }
});
$("captureBtn").addEventListener("click", async () => {
  const video = $("liveVideo");
  if (!video.videoWidth) { status("scanStatus", "Attends que lâimage de la camÃ©ra apparaisse.", true); return; }
  const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  setPhoto(canvas.toDataURL("image/jpeg", .92), "image/jpeg"); stopCamera();
  $("ocrResult").textContent = "Photo capturÃ©e. Appuie sur Â« Lire le texte de la photo Â».";
  status("scanStatus", "Photo capturÃ©e. Appuie sur Â« Lire le texte de la photo Â» pour lancer lâanalyse.");
});
$("stopScanBtn").addEventListener("click", () => { stopCamera(); status("scanStatus", "CamÃ©ra fermÃ©e."); });
$("saveBtn").addEventListener("click", async () => {
  const orderNo = $("orderNo").value.trim(), frameNo = $("frameNo").value.trim();
  if (!orderNo) { status("formStatus", "Le numÃ©ro de commande est obligatoire.", true); $("orderNo").focus(); return; }
  if (!frameNo) { status("formStatus", "Le numÃ©ro du chÃ¢ssis est obligatoire.", true); $("frameNo").focus(); return; }
  const now = Date.now();
  try {
    const record = { clientName: $("clientName").value.trim(), orderNo, frameNo, operations: getOps(), notes: $("notes").value.trim(), photo: currentPhoto, photoType: currentPhotoType, updatedAt: now };
    if (editingId) { record.id = editingId; const old = await getRecord(editingId); record.createdAt = old?.createdAt || now; } else record.createdAt = now;
    editingId = await saveRecord(record);
    $("saveBtn").textContent = "ð¾ Mettre Ã  jour la fiche";
    status("formStatus", "Fiche enregistrÃ©e avec succÃ¨s, photo comprise.");
    await refreshRecords();
  } catch (e) { status("formStatus", "Erreur dâenregistrement : " + e.message, true); }
});
$("resetBtn").addEventListener("click", () => { if (confirm("Effacer le formulaire et prÃ©parer une nouvelle fiche ?")) resetForm(); });
$("searchBox").addEventListener("input", refreshRecords);
$("exportBtn").addEventListener("click", async () => {
  try {
    const records = await allRecords();
    const blob = new Blob([JSON.stringify({ app: "Scan ChÃ¢ssis", version: 1, exportedAt: new Date().toISOString(), records })], { type: "application/json" });
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = `scan-chassis-sauvegarde-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    status("backupStatus", `${records.length} fiche(s) exportÃ©e(s), photos incluses.`);
  } catch (e) { status("backupStatus", "Ãchec de lâexport : " + e.message, true); }
});
$("importInput").addEventListener("change", async e => {
  const file = e.target.files?.[0]; if (!file) return;
  if (!confirm("Importer cette sauvegarde ? Les fiches existantes seront conservÃ©es.")) { e.target.value = ""; return; }
  try {
    const parsed = JSON.parse(await file.text());
    if (!Array.isArray(parsed.records)) throw new Error("Format de sauvegarde invalide.");
    let added = 0, skipped = 0;
    for (const item of parsed.records) {
      if (!item?.orderNo || !item?.frameNo) { skipped++; continue; }
      const existing = await allRecords();
      if (existing.some(r => r.orderNo === item.orderNo && r.frameNo === item.frameNo && JSON.stringify(r.operations || []) === JSON.stringify(item.operations || []))) { skipped++; continue; }
      await saveRecord({ clientName: String(item.clientName || ""), orderNo: String(item.orderNo), frameNo: String(item.frameNo), operations: OPS.filter(op => (item.operations || []).includes(op)), notes: String(item.notes || ""), photo: item.photo || null, photoType: item.photoType || "image/jpeg", createdAt: Number(item.createdAt) || Date.now(), updatedAt: Number(item.updatedAt) || Date.now() });
      added++;
    }
    await refreshRecords(); status("backupStatus", `Import terminÃ© : ${added} ajoutÃ©e(s), ${skipped} ignorÃ©e(s).`);
  } catch (err) { status("backupStatus", "Import impossible : " + err.message, true); }
  finally { e.target.value = ""; }
});
(async () => {
  try { await openDB(); await refreshRecords(); }
  catch (e) { status("formStatus", "Impossible dâouvrir la base locale : " + e.message, true); }
})();
})();