import { PaddleOCR } from "@paddleocr/paddleocr-js";

let ocrInstance = null;
let previewUrl = null;
let currentFile = null;
let isRunning = false;

const photoInput = document.getElementById("photo");
const preview = document.getElementById("preview");
const runButton = document.getElementById("run");
const status = document.getElementById("status");
const result = document.getElementById("result");

const orderValue = document.getElementById("orderValue");
const clientValue = document.getElementById("clientValue");
const chassisValue = document.getElementById("chassisValue");
const partValue = document.getElementById("partValue");
const barcodeValue = document.getElementById("barcodeValue");

function showStatus(message) {
  if (status) status.textContent = message;
}

function setText(element, value, fallback = "Non détecté") {
  if (element) element.textContent = value || fallback;
}

function resetFields(message = "En attente de la photo") {
  setText(orderValue, "", message);
  setText(clientValue, "", message);
  setText(chassisValue, "", message);
  setText(partValue, "", message);
  setText(barcodeValue, "", message);
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeClient(text) {
  const compact = String(text || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!compact) return "";

  // PaddleOCR confond parfois I et L avec 1 dans le nom imprimé.
  const repaired = compact
    .replace(/1/g, "I")
    .replace(/0/g, "O");

  if (
    repaired.includes("FROIDMANTEAU") ||
    repaired.includes("FROIDMANTEAU".replace(/I/g, "1"))
  ) {
    return "FROIDMANTEAU";
  }

  // Tolérance aux petites erreurs OCR : on compare les caractères communs
  // et la longueur, sans appliquer de correction à un nom sans ressemblance.
  if (
    repaired.length >= 10 &&
    repaired.length <= 14 &&
    repaired.startsWith("FRO") &&
    repaired.includes("MANTEAU")
  ) {
    return "FROIDMANTEAU";
  }

  return "";
}

function extractOrder(allText) {
  const compact = allText.toUpperCase().replace(/[^A-Z0-9]/g, "");

  // Commande visée du type 26CR02342. Sur certaines étiquettes, le numéro
  // imprimé à gauche (ex. 16) est collé par l'OCR au début de la commande :
  // « 1626CR02342 ». On récupère donc aussi la commande à partir du 3e caractère.
  const mergedPrefix = compact.match(/\d{2}(\d{2}[A-Z]{2}\d{4,6})/);
  if (mergedPrefix) return mergedPrefix[1];

  const standard = compact.match(/\d{2}[A-Z]{2}\d{4,6}/);
  return standard ? standard[0] : "";
}

function extractLabelInfo(rawText) {
  const lines = rawText.split(/\r?\n/).map(cleanText).filter(Boolean);
  const allText = lines.join(" ").toUpperCase();

  const order = extractOrder(allText);

  const parts = unique(
    [...allText.matchAll(/\bP\s?\d{3,5}\b/g)]
      .map(match => match[0].replace(/\s+/g, ""))
  );

  const barcodeCodes = unique(
    [...allText.matchAll(/\b[A-Z0-9]{8,14}\b/g)]
      .map(match => match[0])
      .filter(code =>
        /\d/.test(code) &&
        /[A-Z]/.test(code) &&
        code !== order &&
        !/^\d{2}[A-Z]{2}\d{4,6}$/.test(code)
      )
  );

  const client = normalizeClient(allText);

  // Le châssis « 003 » apparaît comme une ligne isolée sur l'étiquette
  // de référence. Ne considérer que les lignes contenant exactement 3 chiffres.
  // On ne choisit pas un nombre de 3 chiffres s'il est collé à une autre donnée.
  const chassis = lines.find(line => /^\d{3}$/.test(line)) || "";

  return { lines, order, parts, barcodeCodes, client, chassis };
}

function renderResults(rawText) {
  const info = extractLabelInfo(rawText);

  setText(orderValue, info.order, "Non détectée automatiquement");
  setText(clientValue, info.client, "Non détecté sur cette étiquette");
  setText(chassisValue, info.chassis, "Non détecté avec certitude");
  setText(partValue, info.parts.join(" · "), "Non détectée automatiquement");
  setText(barcodeValue, info.barcodeCodes.join(" · "), "Non détecté automatiquement");

  if (result) {
    result.textContent = info.lines.length
      ? info.lines.join("\n")
      : "Aucun texte détecté. Essaie une photo plus nette, prise de face et bien éclairée.";
  }
}

function predictionToText(prediction) {
  const textParts = [];

  function collect(value) {
    if (!value) return;

    if (typeof value === "string") {
      textParts.push(value);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }

    if (typeof value.text === "string" && value.text.trim()) {
      textParts.push(value.text);
    }

    if (Array.isArray(value.items)) {
      value.items.forEach(collect);
    }
  }

  collect(prediction);
  return unique(textParts.map(cleanText)).join("\n");
}

async function makeOcrImage(file) {
  if (!file || !file.type.startsWith("image/") || typeof createImageBitmap !== "function") {
    return file;
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }

  try {
    const maxSide = 1600;
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 3000000) return file;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));

    const context = canvas.getContext("2d");
    if (!context) return file;

    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise(resolve => {
      canvas.toBlob(blob => resolve(blob || file), "image/jpeg", 0.9);
    });
  } finally {
    bitmap.close?.();
  }
}

if (photoInput) {
  photoInput.addEventListener("change", () => {
    const file = photoInput.files?.[0];
    currentFile = file || null;

    if (!file) {
      if (preview) {
        preview.removeAttribute("src");
        preview.style.display = "none";
      }
      if (runButton) runButton.disabled = true;
      if (result) result.textContent = "Les résultats apparaîtront ici.";
      resetFields();
      showStatus("Choisis une photo d'étiquette.");
      return;
    }

    if (preview) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(file);
      preview.src = previewUrl;
      preview.style.display = "block";
    }

    if (result) result.textContent = "Appuie sur « Lancer PaddleOCR » pour démarrer l'analyse.";
    resetFields("En attente de l'analyse");
    if (runButton) runButton.disabled = false;
    showStatus("Photo chargée. Appuie sur « Lancer PaddleOCR ».");
  });
}

if (runButton) {
  runButton.addEventListener("click", async event => {
    event.preventDefault();
    if (isRunning) return;

    const file = currentFile || photoInput?.files?.[0];
    if (!file) {
      showStatus("Choisis d'abord une photo.");
      return;
    }

    isRunning = true;
    runButton.disabled = true;

    try {
      if (preview && previewUrl) {
        preview.src = previewUrl;
        preview.style.display = "block";
      }

      showStatus("Préparation de la photo…");
      const ocrFile = await makeOcrImage(file);

      showStatus("Chargement du moteur OCR…");
      if (!ocrInstance) {
        ocrInstance = await PaddleOCR.create({
          lang: "en",
          ocrVersion: "PP-OCRv5",
          ortOptions: {
            backend: "wasm",
            wasmPaths: "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/"
          }
        });
      }

      showStatus("Analyse de la photo en cours… Ne ferme pas la page.");
      const prediction = await ocrInstance.predict(ocrFile);
      const rawText = predictionToText(prediction);

      renderResults(rawText);
      showStatus(rawText.trim()
        ? "Analyse terminée. Vérifie les valeurs proposées sur la photo."
        : "Analyse terminée, mais aucun texte n'a été récupéré. Essaie une photo plus nette.");

      if (preview && previewUrl) {
        preview.src = previewUrl;
        preview.style.display = "block";
      }
    } catch (error) {
      console.error("Erreur PaddleOCR :", error);
      showStatus("Erreur OCR : " + (error?.message || String(error)));
      if (result) {
        result.textContent = "L'analyse a échoué. La photo est conservée ; tu peux réessayer.\n\n" +
          (error?.message || String(error));
      }
      if (preview && previewUrl) {
        preview.src = previewUrl;
        preview.style.display = "block";
      }
    } finally {
      isRunning = false;
      if (runButton) runButton.disabled = !(currentFile || photoInput?.files?.[0]);
    }
  });
}

resetFields();
showStatus("Prêt. Choisis une photo d'étiquette.");
