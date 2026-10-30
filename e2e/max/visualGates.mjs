// Runs in the browser. Disabled controls and placeholders use a 3:1 floor;
// other text follows WCAG AA (4.5:1, or 3:1 for large text); icon-only controls 3:1.
export function visualGates() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const colors = new Map();
  const color = (value) => {
    if (!colors.has(value)) {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      colors.set(value, [r / 255, g / 255, b / 255, a / 255]);
    }
    return colors.get(value);
  };
  const over = (fg, bg) => {
    const a = fg[3] + bg[3] * (1 - fg[3]);
    return [...[0, 1, 2].map((i) => (fg[i] * fg[3] + bg[i] * bg[3] * (1 - fg[3])) / (a || 1)), a];
  };
  const background = (el) => {
    const chain = [];
    for (let p = el; p; p = p.parentElement) chain.unshift(p);
    return chain.reduce(
      (bg, p) => over(color(getComputedStyle(p).backgroundColor), bg),
      [1, 1, 1, 1],
    );
  };
  const luminance = (rgb) =>
    rgb
      .slice(0, 3)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((v, c, i) => v + c * [0.2126, 0.7152, 0.0722][i], 0);
  const visible = (el, rect) => {
    if (
      !rect ||
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.bottom <= 0 ||
      rect.top >= innerHeight ||
      rect.right <= 0 ||
      rect.left >= innerWidth
    )
      return false;
    for (let p = el; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0)
        return false;
    }
    const hit = document.elementFromPoint(
      Math.max(0, Math.min(innerWidth - 1, rect.x + rect.width / 2)),
      Math.max(0, Math.min(innerHeight - 1, rect.y + rect.height / 2)),
    );
    return hit && (el.contains(hit) || hit.contains(el));
  };
  const identify = (el) =>
    el.tagName.toLowerCase() +
    (el.id ? "#" + el.id : "") +
    (el.classList.length ? "." + [...el.classList].slice(0, 3).join(".") : "");
  const contrast = [];
  const check = (el, text, style, placeholder = false) => {
    const bg = background(el);
    const fg = [...color(style.color)];
    for (let p = el; p; p = p.parentElement) fg[3] *= Number(getComputedStyle(p).opacity);
    const a = luminance(over(fg, bg)),
      b = luminance(bg);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && parseInt(style.fontWeight) >= 700);
    const minimum =
      placeholder || el.closest(':disabled,[aria-disabled="true"]') || large ? 3 : 4.5;
    if (ratio + 0.01 < minimum)
      contrast.push({
        selector: identify(el),
        text: text.trim().slice(0, 80),
        ratio: +ratio.toFixed(2),
        minimum,
      });
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim() || node.parentElement.closest("script,style,svg")) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    if ([...range.getClientRects()].some((r) => visible(node.parentElement, r)))
      check(node.parentElement, node.textContent, getComputedStyle(node.parentElement));
  }
  for (const el of document.querySelectorAll("input,textarea")) {
    if (!visible(el, el.getBoundingClientRect())) continue;
    if (el.value) check(el, el.type === "password" ? "[password]" : el.value, getComputedStyle(el));
    else if (el.placeholder) check(el, el.placeholder, getComputedStyle(el, "::placeholder"), true);
  }
  // Icon-only controls (a button whose only content is an icon) need WCAG's 3:1 non-text
  // contrast between the icon and what it sits on. Disabled controls are exempt, as in WCAG.
  const iconContrast = [];
  const textVisible = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1 && visible(el, rect);
  };
  for (const el of document.querySelectorAll('button,a,[role="button"]')) {
    if (!visible(el, el.getBoundingClientRect()) || el.closest(':disabled,[aria-disabled="true"]'))
      continue;
    const svg = el.querySelector("svg");
    if (!svg || !visible(svg, svg.getBoundingClientRect())) continue;
    const hasText =
      [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) ||
      [...el.querySelectorAll("*")].some(
        (child) => !child.closest("svg") && child.textContent.trim() && textVisible(child),
      );
    if (hasText) continue;
    // What the icon is painted over: the elements under its centre, not its DOM ancestors (the
    // sidebar toggle floats over the title bar it is not nested in).
    const centre = el.getBoundingClientRect();
    const beneath = document
      .elementsFromPoint(centre.x + centre.width / 2, centre.y + centre.height / 2)
      .filter((entry) => !el.contains(entry));
    const bg = beneath
      .reverse()
      .reduce(
        (acc, entry) => over(color(getComputedStyle(entry).backgroundColor), acc),
        [1, 1, 1, 1],
      );
    const fg = [...color(getComputedStyle(svg).color)];
    for (let p = svg; p; p = p.parentElement) fg[3] *= Number(getComputedStyle(p).opacity);
    const a = luminance(over(fg, bg)),
      b = luminance(bg);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (ratio + 0.01 < 3)
      iconContrast.push({
        selector: identify(el),
        label: el.getAttribute("aria-label") || el.getAttribute("title") || "",
        ratio: +ratio.toFixed(2),
        minimum: 3,
      });
  }
  const transparentPanels = [
    ...document.querySelectorAll(
      '[data-slot="popover-popup"],[data-slot="menu-popup"],[data-slot="select-popup"],[role="dialog"]',
    ),
  ]
    .filter(
      (el) =>
        visible(el, el.getBoundingClientRect()) &&
        color(getComputedStyle(el).backgroundColor)[3] < 0.95,
    )
    .map((el) => ({ selector: identify(el), background: getComputedStyle(el).backgroundColor }));
  return { contrast, iconContrast, transparentPanels };
}
