// Runs inside the page (page.evaluate): the DOM analysis for src/sns-browser.ts analyzeDom. Plain JS, no imports.
({ attr, pattern }) => {
  const re = new RegExp(pattern, "u");
  const readValue = (e) =>
    (attr === "text" ? (e.textContent ?? "") : (e.getAttribute(attr) ?? "")).replace(/\s+/g, " ").trim();
  const pool =
    attr === "href"
      ? document.querySelectorAll("a[href]")
      : attr === "alt"
        ? document.querySelectorAll("img[alt]")
        : attr === "datetime"
          ? document.querySelectorAll("[datetime]")
          : document.querySelectorAll("body *");
  const matching = [...pool].filter((e) => (attr !== "text" || e.childElementCount === 0) && re.test(readValue(e)));
  const own = (e) => {
    const tag = e.tagName.toLowerCase();
    const out = [];
    if (e.id && !/\d{3,}/.test(e.id)) out.push(`${tag}#${CSS.escape(e.id)}`);
    for (const c of [...e.classList].slice(0, 6))
      if (!/\d{3,}|^css-|^x[a-z0-9]{5,}$/.test(c)) out.push(`${tag}.${CSS.escape(c)}`);
    for (const a of ["data-e2e", "data-testid"]) {
      const v = e.getAttribute(a);
      if (v) out.push(`${tag}[${a}="${v}"]`);
    }
    return out;
  };
  const hrefs = attr === "href" ? matching.map((e) => e.getAttribute("href") ?? "") : [];
  let prefix = hrefs[0] ?? "";
  for (const h of hrefs) while (prefix && !h.startsWith(prefix)) prefix = prefix.slice(0, -1);
  const seen = new Set();
  if (prefix.length >= 3) seen.add(`a[href^="${prefix}"]`);
  for (const e of matching.slice(0, 40)) {
    for (const s of own(e)) seen.add(s);
    const parent = e.parentElement;
    if (parent) for (const p of own(parent).slice(0, 3)) for (const s of own(e).slice(0, 2)) seen.add(`${p} > ${s}`);
    const link = attr !== "href" ? e.closest("a[href]") : null;
    const path = link?.getAttribute("href")?.split("/").filter(Boolean)[0];
    if (link && path) seen.add(`a[href*="/${path}/"] ${e.tagName.toLowerCase()}`);
  }
  const candidates = [...seen].flatMap((selector) => {
    let els;
    try {
      els = [...document.querySelectorAll(selector)];
    } catch {
      return [];
    }
    return els.length ? [{ selector, count: els.length, hits: els.filter((e) => re.test(readValue(e))).length }] : [];
  });
  candidates.sort((a, b) => b.hits - a.hits || a.count - b.count || a.selector.length - b.selector.length);
  return {
    matching: matching.length,
    candidates: candidates.slice(0, 20),
    sample: (matching[0]?.parentElement?.outerHTML ?? "").slice(0, 1500),
  };
};
