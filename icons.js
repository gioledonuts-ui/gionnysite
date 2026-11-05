(() => {
  const NS = "http://www.w3.org/2000/svg";
  const SPRITE = "/assets/qg-icons.svg#icon-";

  window.qgIcon = (name, className = "", label = "") => {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("focusable", "false");
    if (className) svg.setAttribute("class", `qg-icon ${className}`);
    else svg.setAttribute("class", "qg-icon");
    if (label) {
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", label);
    } else {
      svg.setAttribute("aria-hidden", "true");
    }
    const use = document.createElementNS(NS, "use");
    use.setAttribute("href", `${SPRITE}${name}`);
    svg.append(use);
    return svg;
  };
})();
