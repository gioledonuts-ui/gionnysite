/* ==========================================================================
   Twemoji · rendu SVG officiel de Twitter pour chaque emoji des textes
   --------------------------------------------------------------------------
   Aucun emoji natif (Apple / Google / Windows) ne doit s'afficher : dès qu'un
   texte contient un emoji, on le remplace par l'image SVG Twemoji 14.0.2
   servie par cdnjs.

   Usage :
     window.qgTwemoji.render(element)   // remplace les emojis du texte
     window.qgTwemoji.parse(string)     // -> fragment DOM
     window.qgTwemoji.observe(root)     // surveille les ajouts

   Détection volontairement stricte : `\p{Extended_Pictographic}` (Unicode) +
   les paires d'indicatifs régionaux. Aucune classe de caractères large, donc
   aucun risque de correspondance vide ou de faux positif sur du texte.
   ========================================================================== */
(() => {
  if (window.qgTwemoji) return;

  const CDN = "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/svg/";

  // Emoji = pictogramme étendu (+ sélecteur de variante, teinte, séquence ZWJ)
  // ou paire d'indicatifs régionaux (drapeaux, que Unicode ne classe pas
  // dans les pictogrammes).
  const EMOJI_SOURCE =
    "(?:\\p{Extended_Pictographic}(?:\\u{FE0F}|\\u{FE0E})?(?:[\\u{1F3FB}-\\u{1F3FF}])?" +
    "(?:\\u{200D}\\p{Extended_Pictographic}(?:\\u{FE0F})?)*" +
    "|[\\u{1F1E6}-\\u{1F1FF}]{2})";

  // Un objet RegExp neuf à chaque passage : `test` et `matchAll` ne doivent
  // jamais partager le même `lastIndex`.
  const emojiRegex = () => new RegExp(EMOJI_SOURCE, "gu");

  const toCodePoint = (emoji) =>
    [...emoji]
      .map((char) => char.codePointAt(0).toString(16))
      .filter((code) => code !== "fe0f")
      .join("-");

  const imageFor = (emoji) => {
    const image = document.createElement("img");
    image.className = "qg-twemoji";
    image.src = `${CDN}${toCodePoint(emoji)}.svg`;
    image.alt = emoji;
    image.width = 20;
    image.height = 20;
    image.loading = "lazy";
    image.decoding = "async";
    image.draggable = false;
    image.setAttribute("draggable", "false");
    return image;
  };

  /** Découpe une chaîne en nœuds texte / images Twemoji. */
  const parse = (value) => {
    const fragment = document.createDocumentFragment();
    const text = String(value ?? "");
    let lastIndex = 0;
    for (const match of text.matchAll(emojiRegex())) {
      if (!match[0]) continue;
      if (match.index > lastIndex) fragment.append(text.slice(lastIndex, match.index));
      fragment.append(imageFor(match[0]));
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) fragment.append(text.slice(lastIndex));
    return fragment;
  };

  const hasEmoji = (value) => emojiRegex().test(String(value ?? ""));

  const BLOCKED_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "CODE", "PRE", "SVG", "svg"]);
  // Un parent que l'on vient de convertir est marqué le temps d'une frame :
  // si son texte est réécrit par le site (bandeau, compteurs...), on ne
  // repart pas en conversion, sinon les deux observateurs se relancent sans fin.
  const OWNED_ATTR = "data-qg-twemoji-owned";
  const owned = new WeakSet();

  /** Remplace les emojis d'un élément (texte seul, jamais dans les champs). */
  const render = (element) => {
    if (!element || BLOCKED_TAGS.has(element.tagName)) return false;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.nodeValue &&
        !BLOCKED_TAGS.has(node.parentNode?.tagName || "") &&
        !node.parentNode?.classList?.contains("qg-twemoji") &&
        hasEmoji(node.nodeValue)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
    const targets = [];
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentNode;
      if (parent instanceof Element && owned.has(parent)) continue;
      targets.push(walker.currentNode);
      // Garde-fou : jamais plus de 200 conversions d'un coup.
      if (targets.length >= 200) break;
    }

    let converted = 0;
    targets.forEach((node) => {
      const value = String(node.nodeValue || "");
      const matches = [...value.matchAll(emojiRegex())].filter((match) => match[0]);
      // Sécurité anti-boucle : rien à convertir = on ne touche pas au nœud.
      if (!matches.length) return;
      const replacement = document.createDocumentFragment();
      let cursor = 0;
      matches.forEach((match) => {
        if (match.index > cursor) replacement.append(value.slice(cursor, match.index));
        replacement.append(imageFor(match[0]));
        cursor = match.index + match[0].length;
      });
      if (cursor < value.length) replacement.append(value.slice(cursor));
      const parent = node.parentNode;
      if (!parent) return;
      parent.replaceChild(replacement, node);
      if (parent instanceof Element) {
        owned.add(parent);
        parent.setAttribute(OWNED_ATTR, "1");
        window.requestAnimationFrame(() => {
          window.setTimeout(() => {
            owned.delete(parent);
            parent.removeAttribute(OWNED_ATTR);
          }, 0);
        });
      }
      converted += matches.length;
    });
    return converted > 0;
  };

  /** Surveille les textes ajoutés plus tard (fil, chat, bandeau...). */
  let observer = null;
  let queued = new Set();
  let frame = 0;
  const flush = () => {
    frame = 0;
    const pending = queued;
    queued = new Set();
    pending.forEach((node) => {
      if (!node?.isConnected) return;
      if (node instanceof Element && owned.has(node)) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentNode;
        if (parent && !BLOCKED_TAGS.has(parent.tagName) && hasEmoji(node.nodeValue)) render(parent);
        return;
      }
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName !== "IMG") render(node);
    });
  };
  const queue = (node) => {
    if (!node) return;
    queued.add(node);
    if (!frame) frame = window.requestAnimationFrame(flush);
  };

  const observe = (root = document.body) => {
    if (!root || observer || typeof MutationObserver !== "function") return;
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        // Ce que l'on vient de produire ne doit jamais nous être renvoyé.
        const origin = mutation.target?.nodeType === Node.TEXT_NODE ? mutation.target.parentNode : mutation.target;
        if (origin instanceof Element && owned.has(origin)) continue;
        if (mutation.type === "characterData") {
          queue(mutation.target);
          continue;
        }
        mutation.addedNodes.forEach((node) => queue(node));
      }
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    render(root);
  };

  window.qgTwemoji = { parse, render, observe, hasEmoji, CDN };

  // Au chargement, on nettoie le document statique (bandeau, cartes...).
  const start = () => {
    try {
      render(document.body);
      observe(document.body);
    } catch {
      // Un navigateur sans property escapes laisse simplement les emojis natifs.
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
