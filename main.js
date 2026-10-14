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

// Redimensionne les photos trop grandes pour limiter la mémoire utilisée
// sur iPhone. L'aperçu continue d'utiliser la photo originale.
async function makeOcrImage(file) {
  if (!file || !file.type.startsWith("image/")) return file;

  if (typeof createImageBitmap !== "function") return file;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }

  try {
    const maxSide = 1600;
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    if (scale === 1 && file.size < 3_000_000) return file;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) return file;

    context.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise(resolve => {
      canvas.toBlob(resolve, "image/jpeg", 0.88);
    });

    return blob || file;
  } finally {
    bitmap.close?.();
  }
}

function extractLabelInfo(rawText) {
  const lines = rawText.split(/\r?\n/).map(cleanText).filter(Boolean);
  const allText = lines.join(" ").toUpperCase();

  const orders = unique(
    [...allText.matchAll(/\b\d{2}\s?[A-Z]{2}\s?\d{4,6}\b/g)]
      .map(match => match[0].replace(/\s+/g, ""))
  );

  const parts = unique(
    [...allText.matchAll(/\bP\s?\d{3,5}\b/g)]
      .map(match => match[0].replace(/\s+/g, ""))
  );

  const codes = unique(
    [...allText.matchAll(/\b[A-Z0-9]{8,14}\b/g)]
      .map(match => match[0])
      .filter(code => /\d/.test(code) && /[A-Z]/.test(code))
  );

  const client = /\bFROIDMANTEAU\b/.test(allText) ? "FROIDMANTEAU" : "";

  // N'affiche un châssis que si le texte reconnu le relie explicitement
  // au mot « châssis », afin de ne pas prendre un nombre quelconque.
  let chassis = "";
  const chassisLine = lines.find(line => /ch[aâ]ssis/i.test(line));
  if (chassisLine) {
    const match = chassisLine.match(/ch[aâ]ssis[^A-Z0-9]{0,12}([A-Z0-9-]{2,12})/i);
    if (match) chassis = match[1];
  }

  return { lines, orders, parts, codes, client, chassis };
}

function renderResults(rawText) {
  const info = extractLabelInfo(rawText);

  setText(orderValue, info.orders.join(" · "), "Non détectée automatiquement");
  setText(clientValue, info.client, "Non détecté sur cette étiquette");
  setText(chassisValue, info.chassis, "Non détecté avec certitude");
  setText(partValue, info.parts.join(" · "), "Non détectée automatiquement");
  setText(barcodeValue, info.codes.join(" · "), "Non détecté automatiquement");

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

    // Conserve l'URL de prévisualisation tant que l'utilisateur ne change pas
    // de photo. Elle n'est pas révoquée au lancement de l'analyse.
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

    // L'aperçu ne doit pas être masqué pendant l'analyse.
    if (preview && previewUrl) {
      preview.src = previewUrl;
      preview.style.display = "block";
    }

    try {
      showStatus("Préparation de la photo pour limiter la mémoire utilisée…");

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
        result.textContent =
          "L'analyse a échoué. La photo est conservée ; tu peux réessayer.\n\n" +
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