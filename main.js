import { PaddleOCR } from "@paddleocr/paddleocr-js";

let ocrInstance = null;
let previewUrl = null;

const photoInput = document.getElementById("photo");
const preview = document.getElementById("preview");
const runButton = document.getElementById("run");
const status = document.getElementById("status");
const result = document.getElementById("result");

function showStatus(message) {
  if (status) status.textContent = message;
}

function getItemText(item) {
  if (typeof item === "string") return item;
  return typeof item?.text === "string" ? item.text : "";
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[|]/g, "I")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function extractLabelInfo(rawText) {
  const lines = rawText
    .split(/\r?\n/)
    .map(cleanText)
    .filter(Boolean);

  const allText = cleanText(lines.join(" ")).toUpperCase();

  // Cherche des identifiants qui ressemblent à une commande.
  // Exemple : 26CR02833. On n'impose plus une commande de test fixe.
  const orderCandidates = [
    ...allText.matchAll(/\b\d{2}\s?[A-Z]{2}\s?\d{4,6}\b/g)
  ].map(match => match[0].replace(/\s+/g, ""));

  // Cherche des références courtes de type P007.
  const partCandidates = [
    ...allText.matchAll(/\bP\s?\d{3,5}\b/g)
  ].map(match => match[0].replace(/\s+/g, ""));

  // Cherche les codes alphanumériques souvent imprimés sous un code-barres.
  // Exemples possibles : 813C60111A, 814E001248.
  const barcodeCodeCandidates = [
    ...allText.matchAll(/\b(?=[A-Z0-9]{8,14}\b)(?=[A-Z0-9]*\d)[A-Z0-9]+\b/g)
  ].map(match => match[0]).filter(code => {
    // Écarte les mots ordinaires et privilégie les codes mêlant lettres/chiffres.
    return /\d/.test(code) && /[A-Z]/.test(code);
  });

  // Affiche les lignes complètes pour éviter de perdre les informations
  // qui ne correspondent pas à un format connu.
  const unique = values => [...new Set(values)];

  return {
    lines: unique(lines),
    orders: unique(orderCandidates),
    parts: unique(partCandidates),
    barcodeCodes: unique(barcodeCodeCandidates)
  };
}

function displayList(values, emptyMessage = "Non détecté automatiquement") {
  return values.length ? values.join(" · ") : emptyMessage;
}

function renderResults(rawText) {
  if (!result) return;

  const info = extractLabelInfo(rawText);

  const section = (title, value) => `${title}\n${value}`;

  const output = [
    "INFORMATIONS REPÉRÉES",
    "",
    section("Commande(s) possible(s) :", displayList(info.orders)),
    "",
    section("Référence(s) de pièce possible(s) :", displayList(info.parts)),
    "",
    section("Code(s) alphanumérique(s) possible(s) :", displayList(info.barcodeCodes)),
    "",
    "TEXTE BRUT DÉTECTÉ",
    info.lines.length ? info.lines.join("\n") : "Aucun texte détecté."
  ];

  result.textContent = output.join("\n");
}

if (photoInput) {
  photoInput.addEventListener("change", () => {
    const file = photoInput.files?.[0];

    if (!file) {
      if (preview) preview.style.display = "none";
      if (runButton) runButton.disabled = true;
      if (result) result.textContent = "Les résultats apparaîtront ici.";
      showStatus("Choisis une photo d'étiquette.");
      return;
    }

    if (preview) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(file);
      preview.src = previewUrl;
      preview.style.display = "block";
    }

    if (result) result.textContent = "Les résultats apparaîtront ici.";
    if (runButton) runButton.disabled = false;
    showStatus("Photo chargée. Appuie sur « Lancer PaddleOCR ».");
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

      showStatus("Analyse de la photo en cours…");
      if (result) result.textContent = "";

      const prediction = await ocrInstance.predict(file);

      // Selon la version, predict peut renvoyer un tableau ou un objet.
      const resultItems = Array.isArray(prediction)
        ? prediction.flatMap(entry => Array.isArray(entry?.items) ? entry.items : [])
        : Array.isArray(prediction?.items)
          ? prediction.items
          : [];

      const lines = resultItems
        .map(getItemText)
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

      if (!rawText.trim()) {
        rawText = "Aucun texte détecté. Essaie une photo plus nette, prise de face, avec l'étiquette bien éclairée.";
      }

      renderResults(rawText);
      showStatus("Analyse terminée. Vérifie les informations proposées : elles restent à confirmer visuellement.");
    } catch (error) {
      console.error(error);
      showStatus("Erreur OCR : " + (error?.message || String(error)));
      if (result) {
        result.textContent = "L'analyse a échoué.\n\n" + (error?.message || String(error));
      }
    } finally {
      runButton.disabled = !photoInput?.files?.[0];
    }
  });
}

showStatus("Prêt. Choisis une photo d'étiquette.");