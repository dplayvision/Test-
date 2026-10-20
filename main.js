import { PaddleOCR } from "@paddleocr/paddleocr-js";

(() => {
"use strict";

const DB_NAME = "scanChassisDB", DB_VERSION = 1, STORE = "fiches";
const OPS = ["Empilage","Double empilage","Retour","Double retour","Soudage / Nettoyage ouvrants","Soudage / Nettoyage dormants"];
const OCR_PLACEHOLDER = "Le texte reconnu apparaîtra ici.";
let db = null, ocrInstance = null, currentPhoto = null, currentPhotoType = "image/jpeg", currentOCRText = "";
let previewUrl = null, liveStream = null, isReading = false, editingId = null, ocrEditOpen = false, photoRotation = 0;
let cropImage = null, cropRect = null, cropDrag = null, cropScale = 1, originalLabelPhoto = null, originalLabelPhotoType = "image/jpeg";
let cropDragMode = null, cropResizeHandle = null, cropDragStart = null, cropRectStart = null;

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
    reader.onerror = () => reject(reader.error || new Error("Lecture du fichier impossible."));
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
  editingId = null; setPhoto(null); originalLabelPhoto = null; originalLabelPhotoType = "image/jpeg"; currentOCRText = "";
  $("cameraInput").value = "";
  $("clientName").value = ""; $("orderNo").value = ""; $("frameNo").value = ""; $("notes").value = "";
  setOps([]); $("saveBtn").textContent = "💾 Enregistrer la fiche";
  setOcrText(""); $("ocrEditor").value = ""; closeOcrEditor();
  status("formStatus", ""); status("scanStatus", "");
}
function loadForm(record) {
  editingId = record.id; setPhoto(record.photo || null, record.photoType || "image/jpeg"); originalLabelPhoto = record.photo || null; originalLabelPhotoType = record.photoType || "image/jpeg";
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

// Extraction des champs depuis le texte OCR.
function extractFields(raw) {
  const lines = String(raw || "")
    .split(/\r?\n/)
    .map(cleanText)
    .filter(Boolean);
  const upperLines = lines.map(line => line.toUpperCase());
  const all = upperLines.join(" ");
  let order = "";
  for (const line of upperLines) {
    const match = line.replace(/\s+/g, "").match(/\d{2}CR\d{4,8}/);
    if (match) { order = match[0]; break; }
  }
  let client = "";
  const clientLine = lines.find(line =>
    /\b\d{4,6}\b/.test(line) &&
    /[A-Za-zÀ-ÿ]/.test(line) &&
    !/\d{2}\s*CR\s*\d{4,8}/i.test(line) &&
    !/815[BSE]?\d{5,}/i.test(line) &&
    !/CHASSIS|GAS1|CAS1|ACS1|WAKO/i.test(line)
  );
  if (clientLine) {
    client = clientLine
      .replace(/[·•|]/g, " ")
      .replace(/\b\d{4,6}\b.*$/, "")
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  const compactClient = client.toUpperCase().replace(/[^A-ZÀ-Ÿ]/g, "");
  if (compactClient === "DEBUGNOUXS" || compactClient === "DEBOUGNOUXS" ||
      /DEB.*UGN.*UX.*S/.test(client.toUpperCase())) {
    client = "DEBOUGNOUX S";
  }
  if (!client) {
    const candidate = lines.find(line =>
      /[A-Za-zÀ-ÿ]{4,}/.test(line) &&
      !/\d{2}\s*CR\s*\d{4,8}/i.test(line) &&
      !/CHASSIS|GAS1|CAS1|ACS1|WAKO|815[BSE]?\d{5,}/i.test(line) &&
      !/^\[?LI[- ]?\d+\]?$/i.test(line) &&
      !/^\/?\d{3,}\W*$/.test(line)
    );
    if (candidate) client = candidate.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  }
  let chassis = "";
  const gasMatch = all.match(/\b(GA|CA)S1\s*[-_ ]*\s*(\d{3})\b/i);
  if (gasMatch) chassis = "GAS1 " + gasMatch[2];
  if (!chassis) {
    for (const line of upperLines) {
      const normalizedLine = line.replace(/[–—]/g, "-");
      const match = normalizedLine.match(/\bACS1\s*-\s*S\s*(P\s*)?\d{3,6}\b/i);
      if (match) {
        const suffix = match[0].match(/(P\s*)?\d{3,6}$/i);
        const numberPart = suffix ? suffix[0].replace(/\s+/g, "") : "";
        chassis = "ACS1-S " + numberPart;
        break;
      }
    }
  }
  return { lines, order, client, chassis };
}
function applyExtractedFields(raw) {
  const fields = extractFields(raw);
  if (fields.order) $("orderNo").value = fields.order;
  if (fields.client) $("clientName").value = fields.client;
  if (fields.chassis) $("frameNo").value = fields.chassis;
  console.log("Champs extraits de l'étiquette WAKO :", fields);
}

// Recadrage : prépare une copie tournée ; la photo originale reste intacte.
function makeRotatedCropSource(dataUrl, degrees) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      try {
        const rotation = ((degrees % 360) + 360) % 360;
        const sideways = rotation === 90 || rotation === 270;
        const canvas = document.createElement("canvas");
        canvas.width = sideways ? image.naturalHeight : image.naturalWidth;
        canvas.height = sideways ? image.naturalWidth : image.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(rotation * Math.PI / 180);
        ctx.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
        resolve(canvas.toDataURL("image/jpeg", .94));
      } catch (error) { reject(error); }
    };
    image.onerror = () => reject(new Error("Impossible de tourner la photo pour le recadrage."));
    image.src = dataUrl;
  });
}
function openCropper() {
  if (!currentPhoto) {
    status("scanStatus", "Choisis ou capture d’abord une photo.", true);
    return;
  }
  if (!originalLabelPhoto) { originalLabelPhoto = currentPhoto; originalLabelPhotoType = currentPhotoType; }
  const modal = $("cropModal"), canvas = $("cropCanvas"), ctx = canvas.getContext("2d");
  status("scanStatus", photoRotation ? "Préparation de la photo tournée pour le cadrage…" : "Ouverture du cadrage…");
  makeRotatedCropSource(currentPhoto, photoRotation).then(rotatedSource => {
    cropImage = new Image();
    cropImage.onload = () => {
      const maxW = Math.min(window.innerWidth - 36, 720);
      const maxH = Math.min(window.innerHeight * 0.52, 520);
      cropScale = Math.min(maxW / cropImage.naturalWidth, maxH / cropImage.naturalHeight, 1);
      canvas.width = Math.max(1, Math.round(cropImage.naturalWidth * cropScale));
      canvas.height = Math.max(1, Math.round(cropImage.naturalHeight * cropScale));
      ctx.drawImage(cropImage, 0, 0, canvas.width, canvas.height);
      cropRect = null;
      drawCropOverlay();
      modal.style.display = "flex";
      status("scanStatus", "La photo garde son orientation. Trace le cadre ou utilise le cadrage automatique.");
    };
    cropImage.onerror = () => status("scanStatus", "Impossible d’ouvrir cette photo pour le recadrage.", true);
    cropImage.src = rotatedSource;
  }).catch(error => status("scanStatus", error.message, true));
}
function autoDetectLabel() {
  if (!cropImage) return;
  const sample = document.createElement("canvas"), maxSide = 240;
  const scale = Math.min(1, maxSide / Math.max(cropImage.naturalWidth, cropImage.naturalHeight));
  sample.width = Math.max(1, Math.round(cropImage.naturalWidth * scale));
  sample.height = Math.max(1, Math.round(cropImage.naturalHeight * scale));
  const sctx = sample.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(cropImage, 0, 0, sample.width, sample.height);
  const data = sctx.getImageData(0, 0, sample.width, sample.height).data;
  const w = sample.width, h = sample.height, seen = new Uint8Array(w*h);
  let best = null, bestScore = 0;
  for (let y=0; y<h; y++) for (let x=0; x<w; x++) {
    const start=y*w+x, p=start*4;
    if (seen[start]) continue;
    const r=data[p], g=data[p+1], b=data[p+2];
    if (!(r>205 && g>205 && b>200 && Math.max(r,g,b)-Math.min(r,g,b)<45)) { seen[start]=1; continue; }
    const stack=[start]; seen[start]=1; let minX=x,maxX=x,minY=y,maxY=y,count=0;
    while(stack.length) {
      const idx=stack.pop(), px=idx%w, py=Math.floor(idx/w); count++;
      if(px<minX)minX=px;if(px>maxX)maxX=px;if(py<minY)minY=py;if(py>maxY)maxY=py;
      const neighbors=[idx-1,idx+1,idx-w,idx+w];
      for(const ni of neighbors){
        if(ni<0||ni>=w*h||seen[ni])continue;
        const nx=ni%w, ny=Math.floor(ni/w); if(Math.abs(nx-px)+Math.abs(ny-py)!==1)continue;
        const q=ni*4, rr=data[q],gg=data[q+1],bb=data[q+2]; seen[ni]=1;
        if(rr>205&&gg>205&&bb>200&&Math.max(rr,gg,bb)-Math.min(rr,gg,bb)<45) stack.push(ni);
      }
    }
    const bw=maxX-minX+1,bh=maxY-minY+1,area=bw*bh, fraction=area/(w*h), aspect=bw/bh;
    if(fraction<0.012||fraction>0.72||count<area*0.45)continue;
    const rectangularity=count/area;
    const score=count * rectangularity * (aspect>0.08&&aspect<8 ? 1 : 0.25);
    if(score>bestScore){bestScore=score;best={x:minX,y:minY,w:bw,h:bh};}
  }
  if(best){
    const sx=$("cropCanvas").width/w, sy=$("cropCanvas").height/h;
    const padX=Math.max(3,best.w*0.035), padY=Math.max(3,best.h*0.035);
    const x=Math.max(0,best.x-padX), y=Math.max(0,best.y-padY);
    const right=Math.min(w,best.x+best.w+padX), bottom=Math.min(h,best.y+best.h+padY);
    cropRect={x:x*sx,y:y*sy,w:(right-x)*sx,h:(bottom-y)*sy};
    drawCropOverlay();
    status("scanStatus","Cadrage automatique proposé. Vérifie les bords et ajuste au doigt si nécessaire.");
  } else {
    cropRect={x:$("cropCanvas").width*0.12,y:$("cropCanvas").height*0.12,w:$("cropCanvas").width*0.76,h:$("cropCanvas").height*0.76};
    drawCropOverlay();
    status("scanStatus","Je n’ai pas isolé les bords avec certitude. Un cadre de départ est proposé : ajuste-le au doigt.",true);
  }
}
function adjustCropZoom(factor) {
  const canvas=$("cropCanvas");
  if(!cropRect) cropRect={x:canvas.width*.12,y:canvas.height*.12,w:canvas.width*.76,h:canvas.height*.76};
  const cx=cropRect.x+cropRect.w/2, cy=cropRect.y+cropRect.h/2;
  const nw=Math.max(24,Math.min(canvas.width,cropRect.w*factor));
  const nh=Math.max(24,Math.min(canvas.height,cropRect.h*factor));
  cropRect={x:Math.max(0,Math.min(canvas.width-nw,cx-nw/2)),y:Math.max(0,Math.min(canvas.height-nh,cy-nh/2)),w:nw,h:nh};
  drawCropOverlay();
}
function drawCropOverlay() {
  if (!cropImage) return;
  const canvas = $("cropCanvas"), ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(cropImage, 0, 0, canvas.width, canvas.height);
  if (!cropRect) return;
  ctx.save();
  ctx.fillStyle = "rgba(10,20,40,.45)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.clearRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
  ctx.drawImage(cropImage, 0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(37,99,235,.10)";
  ctx.fillRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
  ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 3; ctx.setLineDash([8, 4]);
  ctx.strokeRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h); ctx.setLineDash([]);
  const r = 8;
  const corners = [[cropRect.x,cropRect.y],[cropRect.x+cropRect.w,cropRect.y],[cropRect.x,cropRect.y+cropRect.h],[cropRect.x+cropRect.w,cropRect.y+cropRect.h]];
  ctx.fillStyle = "#fff"; ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 2;
  for (const [x,y] of corners) { ctx.beginPath(); ctx.rect(x-r,y-r,r*2,r*2); ctx.fill(); ctx.stroke(); }
  ctx.restore();
}
function cropPointerPosition(event) {
  const canvas = $("cropCanvas"), bounds = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(canvas.width, (event.clientX - bounds.left) * canvas.width / bounds.width)),
    y: Math.max(0, Math.min(canvas.height, (event.clientY - bounds.top) * canvas.height / bounds.height))
  };
}
function cropHitTest(p) {
  if (!cropRect) return { mode: "draw", handle: null };
  const hit = 22;
  const corners = [
    { name: "nw", x: cropRect.x, y: cropRect.y },
    { name: "ne", x: cropRect.x + cropRect.w, y: cropRect.y },
    { name: "sw", x: cropRect.x, y: cropRect.y + cropRect.h },
    { name: "se", x: cropRect.x + cropRect.w, y: cropRect.y + cropRect.h }
  ];
  for (const c of corners) if (Math.abs(p.x-c.x)<=hit && Math.abs(p.y-c.y)<=hit) return {mode:"resize",handle:c.name};
  if (p.x>=cropRect.x && p.x<=cropRect.x+cropRect.w && p.y>=cropRect.y && p.y<=cropRect.y+cropRect.h) return {mode:"move",handle:null};
  return {mode:"draw",handle:null};
}
function startCropDrag(event) {
  event.preventDefault();
  const p = cropPointerPosition(event), hit = cropHitTest(p);
  cropDragMode = hit.mode; cropResizeHandle = hit.handle;
  cropDragStart = {x:p.x,y:p.y}; cropRectStart = cropRect ? {...cropRect} : null;
  if (cropDragMode === "draw") cropRect = {x:p.x,y:p.y,w:0,h:0};
  cropDrag = {x:p.x,y:p.y};
  $("cropCanvas").setPointerCapture?.(event.pointerId);
  drawCropOverlay();
}
function moveCropDrag(event) {
  if (!cropDrag) return;
  event.preventDefault();
  const p = cropPointerPosition(event), dx=p.x-cropDragStart.x, dy=p.y-cropDragStart.y;
  if (cropDragMode === "draw") {
    cropRect={x:Math.min(cropDragStart.x,p.x),y:Math.min(cropDragStart.y,p.y),w:Math.abs(dx),h:Math.abs(dy)};
  } else if (cropDragMode === "move" && cropRectStart) {
    const w=cropRectStart.w,h=cropRectStart.h,canvas=$("cropCanvas");
    cropRect={x:Math.max(0,Math.min(canvas.width-w,cropRectStart.x+dx)),y:Math.max(0,Math.min(canvas.height-h,cropRectStart.y+dy)),w,h};
  } else if (cropDragMode === "resize" && cropRectStart) {
    const c=cropRectStart, min=12, canvas=$("cropCanvas");
    let left=c.x, right=c.x+c.w, top=c.y, bottom=c.y+c.h;
    if(cropResizeHandle.includes("w")) left=Math.max(0,Math.min(right-min,c.x+dx));
    if(cropResizeHandle.includes("e")) right=Math.min(canvas.width,Math.max(left+min,c.x+c.w+dx));
    if(cropResizeHandle.includes("n")) top=Math.max(0,Math.min(bottom-min,c.y+dy));
    if(cropResizeHandle.includes("s")) bottom=Math.min(canvas.height,Math.max(top+min,c.y+c.h+dy));
    cropRect={x:left,y:top,w:right-left,h:bottom-top};
  }
  drawCropOverlay();
}
function endCropDrag() { cropDrag=null; cropDragMode=null; cropResizeHandle=null; cropDragStart=null; cropRectStart=null; }
function closeCropper() {
  $("cropModal").style.display = "none";
  cropImage = null; cropRect = null; cropDrag = null;
}
function applyCrop() {
  if (!cropImage || !cropRect || cropRect.w < 12 || cropRect.h < 12) {
    status("scanStatus", "Trace d’abord un cadre suffisamment grand autour de l’étiquette.", true);
    return;
  }
  const scaleX = cropImage.naturalWidth / $("cropCanvas").width;
  const scaleY = cropImage.naturalHeight / $("cropCanvas").height;
  const x = Math.round(cropRect.x * scaleX), y = Math.round(cropRect.y * scaleY);
  const w = Math.round(cropRect.w * scaleX), h = Math.round(cropRect.h * scaleY);
  const out = document.createElement("canvas"); out.width = w; out.height = h;
  out.getContext("2d").drawImage(cropImage, x, y, w, h, 0, 0, w, h);
  const cropped = out.toDataURL("image/jpeg", .94);
  // Le recadrage est désormais l'image réelle utilisée et enregistrée.
  setPhoto(cropped, "image/jpeg");
  originalLabelPhoto = cropped;
  originalLabelPhotoType = "image/jpeg";
  closeCropper();
  setOcrText("Photo recadrée. Appuie sur « Lire le texte de la photo ».");
  status("scanStatus", "Recadrage appliqué et intégré à la photo enregistrée.");
}
function beginOcrEdit() {
  if (isReading) return;
  const visibleText = $("ocrResult").textContent.trim();
  $("ocrEditor").value = visibleText === OCR_PLACEHOLDER ? "" : visibleText;
  ocrEditOpen = true;
  $("ocrResult").style.display = "none"; $("ocrEditor").style.display = "block";
  $("editOcrBtn").style.display = "none"; $("saveOcrEditBtn").style.display = ""; $("cancelOcrEditBtn").style.display = "";
  $("ocrEditor").focus();
}
function saveOcrEdit() {
  if (!ocrEditOpen) return;
  const corrected = $("ocrEditor").value.trim();
  setOcrText(corrected); closeOcrEditor();
  if (corrected) applyExtractedFields(corrected);
  status("scanStatus", "Texte brut corrigé. Les corrections seront enregistrées avec la fiche.");
}
function cancelOcrEdit() { $("ocrEditor").value = ""; closeOcrEditor(); }

async function runOCR() {
  if (isReading) return;
  if (!currentPhoto) { status("scanStatus", "Choisis d’abord une photo de l’étiquette.", true); return; }
  const savedPhoto = currentPhoto, savedPhotoType = currentPhotoType;
  isReading = true; $("readLabelBtn").disabled = true;
  try {
    $("preview").src = savedPhoto; $("preview").style.display = "block";
    status("scanStatus", "Chargement du moteur OCR…");
    if (!ocrInstance) {
      ocrInstance = await PaddleOCR.create({
        lang: "en", ocrVersion: "PP-OCRv5",
        ortOptions: { backend: "wasm", wasmPaths: "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/" }
      });
    }
    status("scanStatus", "Préparation d’une copie légère de la photo…");
    setOcrText("Préparation de la photo pour l’analyse… l’original est conservé.");
    const blob = await makeOCRBlob(savedPhoto, 1500, 0.82, photoRotation);
    status("scanStatus", "Analyse OCR en cours sur la copie allégée…");
    setOcrText("Analyse en cours… la photo originale est conservée.");
    const results = await ocrInstance.predict(blob);
    console.log("Résultat brut PaddleOCR :", results);
    const ocrLines = (Array.isArray(results) ? results : [results])
      .flatMap(result => (result?.items || []).map(item => cleanText(item?.text || "")))
      .filter(Boolean);
    const filteredLines = [];
    for (let i = 0; i < ocrLines.length; i++) {
      const token = ocrLines[i].toUpperCase().replace(/[^A-Z]/g, "");
      if (token === "WAKO") continue;
      if (token === "W" && ocrLines.slice(i, i + 4).map(line => line.toUpperCase().replace(/[^A-Z]/g, "")).join("") === "WAKO") {
        i += 3; continue;
      }
      filteredLines.push(ocrLines[i]);
    }
    const raw = filteredLines.join("\n");
    setOcrText(raw || "Aucun texte détecté. Essaie une photo plus nette, prise de face et bien éclairée.");
    if (raw) applyExtractedFields(raw);
    status("scanStatus", raw ? "Lecture terminée. Vérifie les champs avant d’enregistrer." : "Aucun texte récupéré. Tu peux réessayer.", !raw);
  } catch (e) {
    console.error("Erreur PaddleOCR", e);
    const errorMessage = e?.message || String(e);
    setOcrText("Erreur pendant la lecture : " + errorMessage);
    status("scanStatus", "Erreur OCR : " + errorMessage, true);
  } finally {
    currentPhoto = savedPhoto; currentPhotoType = savedPhotoType;
    if (savedPhoto) { $("preview").setAttribute("src", savedPhoto); $("preview").style.display = "block"; }
    isReading = false; $("readLabelBtn").disabled = false;
  }
}

$("editOcrBtn").addEventListener("click", beginOcrEdit);
$("saveOcrEditBtn").addEventListener("click", saveOcrEdit);
$("cancelOcrEditBtn").addEventListener("click", cancelOcrEdit);

// Correctif sélection photo : fonctionne avec le label for="cameraInput" existant dans le HTML.
// Un bouton #choosePhotoBtn facultatif est également pris en charge si tu l'as ajouté.
const photoInput = $("cameraInput");
const choosePhotoBtn = $("choosePhotoBtn");
if (choosePhotoBtn) {
  choosePhotoBtn.addEventListener("click", () => photoInput.click());
}
photoInput.addEventListener("change", async (e) => {
  const input = e.target;
  const file = input.files && input.files[0];
  if (!file) return;
  try {
    if (!file.type.startsWith("image/")) {
      throw new Error("Le fichier sélectionné n'est pas une image.");
    }
    status("scanStatus", "Chargement de la photo…");
    const data = await dataURL(file);
    await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = resolve;
      img.onerror = () => reject(new Error("Impossible d'ouvrir cette image sur le téléphone."));
      img.src = data;
    });
    setPhoto(data, file.type || "image/jpeg");
    originalLabelPhoto = data;
    originalLabelPhotoType = file.type || "image/jpeg";
    $("clientName").value = ""; $("orderNo").value = ""; $("frameNo").value = "";
    closeOcrEditor();
    setOcrText("Photo chargée. Appuie sur « Lire le texte de la photo ».");
    status("scanStatus", "Photo chargée avec succès. Tu peux la cadrer ou lancer la lecture OCR.");
  } catch (err) {
    console.error("Erreur de chargement de la photo :", err);
    status("scanStatus", "Impossible de charger la photo : " + (err.message || err), true);
  } finally {
    // Permet de sélectionner à nouveau la même photo sur iOS.
    input.value = "";
  }
});

$("clearPhotoBtn").addEventListener("click", () => {
  setPhoto(null); originalLabelPhoto = null; originalLabelPhotoType = "image/jpeg";
  $("cameraInput").value = ""; setOcrText(""); closeOcrEditor();
  status("scanStatus", "Photo retirée de la fiche en cours.");
});
async function rotatePreview(degrees) {
  if (!currentPhoto) { status("scanStatus", "Choisis ou capture d’abord une photo.", true); return; }
  try {
    // Rotation réellement dessinée dans une nouvelle image, pas seulement en CSS.
    // Ainsi l'orientation reste correcte après enregistrement et rechargement.
    status("scanStatus", "Rotation de la photo en cours…");
    const rotatedPhoto = await makeRotatedCropSource(currentPhoto, degrees);
    setPhoto(rotatedPhoto, "image/jpeg");
    originalLabelPhoto = rotatedPhoto;
    originalLabelPhotoType = "image/jpeg";
    photoRotation = 0;
    status("scanStatus", "Rotation intégrée à la photo. Elle restera dans ce sens après l’enregistrement.");
  } catch (error) {
    console.error("Erreur de rotation de la photo :", error);
    status("scanStatus", "Impossible de tourner la photo : " + (error.message || error), true);
  }
}
$("rotateLeftBtn").addEventListener("click", () => rotatePreview(-90));
$("rotateRightBtn").addEventListener("click", () => rotatePreview(90));
$("cropBtn").addEventListener("click", openCropper);
$("cropCancelBtn").addEventListener("click", closeCropper);
$("cropApplyBtn").addEventListener("click", applyCrop);
$("cropCanvas").addEventListener("pointerdown", startCropDrag);
$("cropCanvas").addEventListener("pointermove", moveCropDrag);
$("cropCanvas").addEventListener("pointerup", endCropDrag);
$("cropCanvas").addEventListener("pointercancel", endCropDrag);
$("autoCropBtn").addEventListener("click", autoDetectLabel);
$("zoomInBtn").addEventListener("click", () => adjustCropZoom(0.88));
$("zoomOutBtn").addEventListener("click", () => adjustCropZoom(1.12));
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
  } catch (e) {
    stopCamera();
    status("scanStatus", "Impossible d’ouvrir la caméra. Vérifie l’autorisation et utilise le site en HTTPS.", true);
  }
});
$("captureBtn").addEventListener("click", async () => {
  const video = $("liveVideo");
  if (!video.videoWidth) { status("scanStatus", "Attends que l’image de la caméra apparaisse.", true); return; }
  const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  setPhoto(canvas.toDataURL("image/jpeg", .92), "image/jpeg");
  originalLabelPhoto = currentPhoto; originalLabelPhotoType = currentPhotoType; stopCamera();
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
      || displayedRaw.startsWith("Photo recadrée.")
      || displayedRaw.startsWith("Préparation de la photo")
      || displayedRaw.startsWith("Analyse en cours")
      || displayedRaw.startsWith("Erreur pendant la lecture :")
      || displayedRaw.startsWith("Aucun texte détecté.");
    const ocrText = isInstruction ? "" : displayedRaw;
    const record = {
      clientName: $("clientName").value.trim(), orderNo, frameNo,
      operations: getOps(), notes: $("notes").value.trim(), ocrText,
      photo: currentPhoto || originalLabelPhoto,
      photoType: currentPhoto ? currentPhotoType : (originalLabelPhotoType || currentPhotoType),
      updatedAt: now
    };
    if (editingId) {
      record.id = editingId;
      const old = await getRecord(editingId);
      record.createdAt = old?.createdAt || now;
    } else record.createdAt = now;
    await saveRecord(record);
    await refreshRecords();
    // Après chaque validation, vider le formulaire pour encoder la fiche suivante.
    // La fiche sauvegardée reste dans l'historique et n'est pas supprimée.
    resetForm();
    status("formStatus", "Fiche enregistrée avec succès. Le formulaire est remis à zéro pour la suivante.");
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
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
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
      await saveRecord({
        clientName: String(item.clientName || ""), orderNo: String(item.orderNo), frameNo: String(item.frameNo),
        operations: OPS.filter(op => (item.operations || []).includes(op)), notes: String(item.notes || ""),
        ocrText: String(item.ocrText || ""), photo: item.photo || null, photoType: item.photoType || "image/jpeg",
        createdAt: Number(item.createdAt) || Date.now(), updatedAt: Number(item.updatedAt) || Date.now()
      });
      added++;
    }
    await refreshRecords(); status("backupStatus", `Import terminé : ${added} ajoutée(s), ${skipped} ignorée(s).`);
  } catch (err) { status("backupStatus", "Import impossible : " + err.message, true); }
  finally { e.target.value = ""; }
});
let currentSummaryRows = [];
function dateInputValue(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}
function getRecordDate(record) {
  // La période correspond à la date de création de la fiche, pas à sa dernière modification.
  return Number(record.createdAt || record.updatedAt || 0);
}
function summaryKey(row) {
  return [row.clientName, row.orderNo, row.frameNo, row.operation, row.notes]
    .map(value => String(value || '').trim().toLocaleLowerCase('fr'))
    .join('\u001f');
}
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
function renderSummary(rows) {
  const target = $('summaryResults');
  target.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Aucune opération enregistrée pour cette période.';
    target.appendChild(empty);
    return;
  }
  const wrap = document.createElement('div');
  wrap.style.overflowX = 'auto';
  const table = document.createElement('table');
  table.style.cssText = 'width:100%;border-collapse:collapse;margin-top:12px;font-size:13px;min-width:720px';
  const headers = ['Date fiche', 'Client', 'N° commande', 'N° châssis', 'Opération', 'Remarque'];
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headers.forEach(label => {
    const th = document.createElement('th'); th.textContent = label;
    th.style.cssText = 'text-align:left;padding:10px 8px;background:#e8efff;border-bottom:1px solid #cbd5e1;white-space:nowrap';
    headRow.appendChild(th);
  });
  thead.appendChild(headRow); table.appendChild(thead);
  const tbody = document.createElement('tbody');
  rows.forEach((row, index) => {
    const tr = document.createElement('tr');
    if (index % 2) tr.style.background = '#f8fafc';
    [row.date, row.clientName || '—', row.orderNo, row.frameNo, row.operation || '—', row.notes || '—'].forEach(value => {
      const td = document.createElement('td'); td.textContent = value;
      td.style.cssText = 'padding:9px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody); wrap.appendChild(table); target.appendChild(wrap);
}
async function generateSummary() {
  const startValue = $('summaryStart').value;
  const endValue = $('summaryEnd').value;
  if (!startValue || !endValue) {
    currentSummaryRows = []; $('exportSummaryBtn').disabled = true; $('saveSummaryImageBtn').disabled = true;
    status('summaryStatus', 'Choisis une date de début et une date de fin.', true); return;
  }
  if (startValue > endValue) {
    currentSummaryRows = []; $('exportSummaryBtn').disabled = true; $('saveSummaryImageBtn').disabled = true;
    status('summaryStatus', 'La date de début doit être antérieure ou égale à la date de fin.', true); return;
  }
  try {
    const start = new Date(startValue + 'T00:00:00').getTime();
    const end = new Date(endValue + 'T23:59:59.999').getTime();
    const records = await allRecords();
    const seen = new Set();
    const rows = [];
    for (const record of records) {
      const timestamp = getRecordDate(record);
      if (!timestamp || timestamp < start || timestamp > end) continue;
      const date = new Date(timestamp).toLocaleDateString('fr-BE');
      const operations = (record.operations && record.operations.length) ? record.operations : [''];
      for (const operation of operations) {
        const row = { date, timestamp, clientName: String(record.clientName || ''), orderNo: String(record.orderNo || ''), frameNo: String(record.frameNo || ''), operation: String(operation || ''), notes: String(record.notes || '') };
        const key = summaryKey(row);
        if (seen.has(key)) continue;
        seen.add(key); rows.push(row);
      }
    }
    rows.sort((a, b) => a.timestamp - b.timestamp || a.orderNo.localeCompare(b.orderNo, 'fr') || a.operation.localeCompare(b.operation, 'fr'));
    currentSummaryRows = rows;
    renderSummary(rows);
    const hasRows = rows.length > 0;
    $('exportSummaryBtn').disabled = !hasRows;
    $('saveSummaryImageBtn').disabled = !hasRows;
    $('exportSummaryBtn').style.opacity = hasRows ? '1' : '0.5';
    $('saveSummaryImageBtn').style.opacity = hasRows ? '1' : '0.5';
    status('summaryStatus', `${rows.length} ligne(s) affichée(s), doublons identiques ignorés. Période : ${startValue} au ${endValue}.`);
  } catch (error) {
    currentSummaryRows = []; $('exportSummaryBtn').disabled = true; $('saveSummaryImageBtn').disabled = true;
    status('summaryStatus', 'Impossible de générer la synthèse : ' + (error.message || error), true);
  }
}
$('generateSummaryBtn').addEventListener('click', generateSummary);
$('exportSummaryBtn').addEventListener('click', () => {
  if (!currentSummaryRows.length) return;
  const headers = ['Date fiche', 'Client', 'N° commande', 'N° châssis', 'Opération', 'Remarque'];
  const lines = [headers, ...currentSummaryRows.map(row => [row.date, row.clientName, row.orderNo, row.frameNo, row.operation, row.notes])];
  const csv = '\ufeff' + lines.map(line => line.map(csvCell).join(';')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = `synthese-scan-chassis-${$('summaryStart').value}-${$('summaryEnd').value}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  status('summaryStatus', `${currentSummaryRows.length} ligne(s) exportée(s) en CSV compatible Excel.`);
});

function buildSummaryCanvas() {
  if (!currentSummaryRows.length) throw new Error('Génère d’abord le tableau.');
  const headers = ['Date fiche', 'Client', 'N° commande', 'N° châssis', 'Opération', 'Remarque'];
  const rows = currentSummaryRows.map(r => [r.date, r.clientName || '—', r.orderNo || '—', r.frameNo || '—', r.operation || '—', r.notes || '—']);
  const canvas = document.createElement('canvas');
  const scale = 2, pad = 28, rowH = 42, headH = 48;
  const widths = [120, 190, 145, 130, 270, 190];
  const totalW = widths.reduce((a,b)=>a+b,0);
  canvas.width = (totalW + pad*2) * scale; canvas.height = (pad*2 + headH + rows.length*rowH + 60) * scale;
  const ctx = canvas.getContext('2d'); ctx.scale(scale, scale); ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,canvas.width/scale,canvas.height/scale);
  ctx.fillStyle='#172033'; ctx.font='bold 24px Arial'; ctx.fillText('Synthèse Scan Châssis', pad, pad+24);
  ctx.font='14px Arial'; ctx.fillStyle='#65718a'; ctx.fillText(`Période : ${$('summaryStart').value} au ${$('summaryEnd').value} — ${rows.length} ligne(s)`, pad, pad+46);
  let y=pad+60; let x=pad; ctx.fillStyle='#e8efff'; ctx.fillRect(pad,y,totalW,headH); ctx.font='bold 13px Arial'; ctx.fillStyle='#172033';
  headers.forEach((h,i)=>{ctx.fillText(h,x+8,y+28);x+=widths[i];}); y+=headH;
  ctx.font='12px Arial'; rows.forEach((row,ri)=>{x=pad; if(ri%2) {ctx.fillStyle='#f5f7fb';ctx.fillRect(pad,y,totalW,rowH);} ctx.fillStyle='#172033'; row.forEach((v,i)=>{let text=String(v); const max=Math.floor((widths[i]-14)/6.5); if(text.length>max) text=text.slice(0,max-1)+'…'; ctx.fillText(text,x+8,y+25); x+=widths[i];}); ctx.strokeStyle='#dfe6f0';ctx.beginPath();ctx.moveTo(pad,y+rowH);ctx.lineTo(pad+totalW,y+rowH);ctx.stroke();y+=rowH;});
  return canvas;
}
$('saveSummaryImageBtn').addEventListener('click', () => {
  try { const canvas=buildSummaryCanvas(); canvas.toBlob(blob=>{ if(!blob){status('summaryStatus','Impossible de créer l’image.',true);return;} const url=URL.createObjectURL(blob); const w=window.open(url,'_blank'); if(!w){const a=document.createElement('a');a.href=url;a.download=`synthese-scan-chassis-${$('summaryStart').value}-${$('summaryEnd').value}.png`;a.click();} status('summaryStatus','Image créée. Sur iPhone, ouvre-la puis fais un appui long pour choisir Enregistrer dans Photos.'); setTimeout(()=>URL.revokeObjectURL(url),60000); },'image/png'); } catch(e){status('summaryStatus',e.message,true);}
});


const today = dateInputValue(new Date());
$('summaryStart').value = today;
$('summaryEnd').value = today;

(async () => {
  try {
    await openDB();
    await refreshRecords();
    status("formStatus", "Base locale ouverte. Historique actualisé.");
  } catch (e) {
    console.error("Erreur au démarrage de Scan Châssis / accès aux fiches :", e);
    const message = "Impossible de charger les fiches : " + (e?.message || String(e)) + ". Ne supprime pas les données du navigateur et ne réinstalle pas l’application.";
    status("formStatus", message, true);
    const history = $("records");
    if (history) {
      const error = document.createElement("div");
      error.className = "empty";
      error.style.color = "#b91c1c";
      error.textContent = message;
      history.replaceChildren(error);
    }
  }
})();
})();
