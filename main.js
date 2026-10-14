import { PaddleOCR } from "@paddleocr/paddleocr-js";

let ocrInstance = null;
let previewUrl = null;

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

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractLabelInfo(rawText) {
  const lines = rawText
    .split(/\r?\n/)
    .map(cleanText)
    .filter(Boolean);

  const allText = lines.join(" ").toUpperCase();

  // Exemples de commandes : 26CR02833. Ce format est une piste,
  // pas une garantie : vÃ©rifier la valeur sur la photo.
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

  // Le client ne peut pas Ãªtre dÃ©duit de faÃ§on fiable d'une Ã©tiquette
  // si son nom n'est pas imprimÃ© dessus.
  const clientMatch = allText.match(/\bFROIDMANTEAU\b/);
  const client = clientMatch ? "FROIDMANTEAU" : "";

  // Ne jamais prendre arbitrairement un nombre de 3 chiffres comme chÃ¢ssis :
  // sur les Ã©tiquettes, il peut s'agir d'une autre donnÃ©e (ex. 053, 003).
  // On le propose uniquement si une ligne mentionne explicitement CHASSIS.
  let chassis = "";
  const chassisLine = lines.find(line => /ch[aÃ¢]ssis/i.test(line));
  if (chassisLine) {
    const match = chassisLine.match(/ch[aÃ¢]ssis[^A-Z0-9]{0,12}([A-Z0-9-]{2,12})/i);
    if (match) chassis = match[1];
  }

  return { lines, orders, parts, codes, client, chassis };
}

function setField(element, value, fallback) {
  if (element) element.textContent = value || fallback;
}

function renderResults(rawText) {
  const info = extractLabelInfo(rawText);

  setField(orderValue, info.orders.join(" Â· "), "Non dÃ©tectÃ©e automatiquement");
  setField(clientValue, info.client, "Non dÃ©tectÃ© sur cette Ã©tiquette");
  setField(chassisValue, info.chassis, "Non dÃ©tectÃ© avec certitude");
  setField(partValue, info.parts.join(" Â· "), "Non dÃ©tectÃ©e automatiquement");
  setField(barcodeValue, info.codes.join(" Â· "), "Non dÃ©tectÃ© automatiquement");

  if (result) {
    result.textContent = info.lines.length
      ? info.lines.join("\n")
      : "Aucun texte dÃ©tectÃ©.";
  }
}

function resetDetectedFields() {
  setField(orderValue, "", "En attente de la photo");
  setField(clientValue, "", "En attente de la photo");
  setField(chassisValue, "", "En attente de la photo");
  setField(partValue, "", "En attente de la photo");
  setField(barcodeValue, "", "En attente de la photo");
}

if (photoInput) {
  photoInput.addEventListener("change", () => {
    const file = photoInput.files?.[0];

    if (!file) {
      if (preview) preview.style.display = "none";
      if (runButton) runButton.disabled = true;
      if (result) result.textContent = "Les rÃ©sultats apparaÃ®tront ici.";
      resetDetectedFields();
      showStatus("Choisis une photo d'Ã©tiquette.");
      return;
    }

    if (preview) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(file);
      preview.src = previewUrl;
      preview.style.display = "block";
    }

    if (result) result.textContent = "Les rÃ©sultats apparaÃ®tront ici.";
    resetDetectedFields();
    if (runButton) runButton.disabled = false;
    showStatus("Photo chargÃ©e. Appuie sur Â« Lancer PaddleOCR Â».");
  });
}

if (runButton) {
  runButton.addEventListener("click", async () => {
    const file = photoInput?.files?.[0];

    if (!file) {
      showStatus("Choisis d'abord une photo.");
      return;
    }

    runButton.disabled = true;

    try {
      showStatus("Chargement du moteur OCRâ¦");

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

      showStatus("Analyse de la photo en coursâ¦");
      if (result) result.textContent = "";

      const prediction = await ocrInstance.predict(file);

      const resultItems = Array.isArray(prediction)
        ? prediction.flatMap(entry => Array.isArray(entry?.items) ? entry.items : [])
        : Array.isArray(prediction?.items)
          ? prediction.items
          : [];

      const lines = resultItems
        .map(item => typeof item === "string" ? item : item?.text)
        .map(cleanText)
        .filter(Boolean);

      let rawText = lines.join("\n");

      if (!rawText && Array.isArray(prediction)) {
        rawText = prediction
          .map(entry => typeof entry?.text === "string" ? entry.text : "")
          .filter(Boolean)
          .join("\n");
      } else if (!rawText && typeof prediction?.text === "string") {
        rawText = prediction.text;
      }

      renderResults(rawText);
      showStatus(rawText.trim()
        ? "Analyse terminÃ©e. VÃ©rifie les valeurs proposÃ©es sur la photo."
        : "Aucun texte dÃ©tectÃ©. Essaie une photo plus nette, prise de face et bien Ã©clairÃ©e.");
    } catch (error) {
      console.error(error);
      showStatus("Erreur OCR : " + (error?.message || String(error)));
      if (result) result.textContent = "L'analyse a Ã©chouÃ©.\n\n" + (error?.message || String(error));
    } finally {
      runButton.disabled = !photoInput?.files?.[0];
    }
  });
}

resetDetectedFields();
showStatus("PrÃªt. Choisis une photo d'Ã©tiquette.");