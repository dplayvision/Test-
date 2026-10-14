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

if (photoInput) {
  photoInput.addEventListener("change", () => {
    const file = photoInput.files?.[0];

    if (!file) {
      if (preview) preview.style.display = "none";
      if (runButton) runButton.disabled = true;
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

      const [ocrResult] = await ocrInstance.predict(file);

      const lines = (ocrResult?.items || [])
        .map(item => item.text)
        .filter(Boolean);

      const text = lines.length
        ? lines.join("\n")
        : typeof ocrResult?.text === "string"
          ? ocrResult.text
          : "Aucun texte détecté.";

      if (result) result.textContent = text;
      showStatus("Terminé. Compare le texte avec la commande 26CR02342, le client FROIDMANTEAU et le châssis 003.");
    } catch (error) {
      console.error(error);
      showStatus("Erreur OCR : " + (error?.message || String(error)));
    } finally {
      runButton.disabled = !photoInput?.files?.[0];
    }
  });
}

showStatus("Prêt. Choisis une photo de châssis.");
