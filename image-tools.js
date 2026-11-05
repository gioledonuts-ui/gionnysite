(() => {
  const loadImageSource = async (file) => {
    if (typeof createImageBitmap === "function") {
      try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
      catch { return createImageBitmap(file); }
    }
    return new Promise((resolve, reject) => {
      const image = new Image();
      const objectUrl = URL.createObjectURL(file);
      image.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve({ image, width: image.naturalWidth, height: image.naturalHeight, close() {} });
      };
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Cette image ne peut pas être ouverte."));
      };
      image.src = objectUrl;
    });
  };

  const canvasToWebp = (canvas, quality) => new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob || blob.type !== "image/webp") {
        reject(new Error("Ce navigateur ne peut pas compresser les images en WebP."));
        return;
      }
      resolve(blob);
    }, "image/webp", quality);
  });

  const compressToWebp = async (file, {
    maxWidth = 800,
    maxHeight = 800,
    cropSquare = false,
    preserveDimensions = false,
    maxBytes = 40_000,
    initialQuality = 0.75,
  } = {}) => {
    if (!file || typeof file.type !== "string" || !file.type.startsWith("image/")) {
      throw new Error("Choisis un fichier image.");
    }
    const source = await loadImageSource(file);
    const sourceWidth = source.width || source.image?.naturalWidth || 0;
    const sourceHeight = source.height || source.image?.naturalHeight || 0;
    if (!sourceWidth || !sourceHeight) {
      source.close?.();
      throw new Error("Cette image ne contient pas de dimensions valides.");
    }
    const sourceSize = Math.min(sourceWidth, sourceHeight);
    const ratio = cropSquare ? 1 : Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
    let targetWidth = cropSquare ? maxWidth : Math.max(1, Math.round(sourceWidth * ratio));
    let targetHeight = cropSquare ? maxHeight : Math.max(1, Math.round(sourceHeight * ratio));
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      source.close?.();
      throw new Error("Le traitement de l’image n’est pas disponible.");
    }
    const qualities = [initialQuality, 0.74, 0.66, 0.58, 0.5, 0.42, 0.34, 0.28];
    try {
      const sizeAttempts = preserveDimensions ? 1 : 5;
      for (let sizeAttempt = 0; sizeAttempt < sizeAttempts; sizeAttempt += 1) {
        const scale = preserveDimensions ? 1 : Math.pow(0.82, sizeAttempt);
        canvas.width = Math.max(64, Math.round(targetWidth * scale));
        canvas.height = Math.max(64, Math.round(targetHeight * scale));
        context.clearRect(0, 0, canvas.width, canvas.height);
        if (cropSquare) {
          const sx = Math.floor((sourceWidth - sourceSize) / 2);
          const sy = Math.floor((sourceHeight - sourceSize) / 2);
          context.drawImage(source.image || source, sx, sy, sourceSize, sourceSize, 0, 0, canvas.width, canvas.height);
        } else {
          context.drawImage(source.image || source, 0, 0, canvas.width, canvas.height);
        }
        for (const quality of qualities) {
          const blob = await canvasToWebp(canvas, quality);
          if (blob.size <= maxBytes) return blob;
        }
      }
      throw new Error(`L’image reste trop lourde. Choisis une image plus simple (maximum ${Math.round(maxBytes / 1000)} Ko).`);
    } finally {
      source.close?.();
      canvas.width = 0;
      canvas.height = 0;
    }
  };

  const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new Error("L’image n’a pas pu être préparée."));
    reader.readAsDataURL(blob);
  });

  let imageViewer;
  const openImageViewer = (src, alt = "Image jointe") => {
    if (typeof src !== "string" || !src) return;
    if (!imageViewer) {
      imageViewer = document.createElement("dialog");
      imageViewer.className = "qg-image-viewer";
      imageViewer.setAttribute("aria-label", "Aperçu de l’image");
      const close = document.createElement("button");
      close.type = "button";
      close.className = "qg-image-viewer-close";
      close.setAttribute("aria-label", "Fermer l’image");
      close.textContent = "×";
      const image = document.createElement("img");
      image.className = "qg-image-viewer-image";
      imageViewer.append(close, image);
      close.addEventListener("click", () => imageViewer.close());
      imageViewer.addEventListener("click", (event) => {
        if (event.target === imageViewer) imageViewer.close();
      });
      imageViewer.addEventListener("close", () => {
        image.removeAttribute("src");
        image.alt = "";
      });
      document.body.append(imageViewer);
    }
    const image = imageViewer.querySelector("img");
    image.src = src;
    image.alt = alt;
    if (!imageViewer.open) imageViewer.showModal();
  };

  window.qgImageTools = Object.freeze({ compressToWebp, blobToDataUrl, openImageViewer });
})();
