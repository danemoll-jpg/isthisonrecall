const $ = (id) => document.getElementById(id);

const MAX_EDGE = 1568; // plenty for reading labels, keeps uploads small
const SOURCES_LABEL = "FDA and USDA food recalls";

// ---------------------------------------------------------------------------
// Passcode (only used if the server has APP_PASSCODE set)

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

function askPasscode() {
  return new Promise((resolve) => {
    const dialog = $("passcode-dialog");
    $("passcode").value = "";
    dialog.addEventListener("close", () => {
      const code = $("passcode").value.trim();
      if (code) store.set("passcode", code);
      resolve(Boolean(code));
    }, { once: true });
    dialog.showModal();
  });
}

async function api(path, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-passcode": store.get("passcode") || "" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.error === "passcode") {
      if (!(await askPasscode())) throw new Error("A passcode is needed to use this app.");
      continue;
    }
    if (!res.ok) throw new Error(data.message || `Something went wrong (${res.status}).`);
    return data;
  }
  throw new Error("That passcode didn't work.");
}

// ---------------------------------------------------------------------------
// Photo → small JPEG data URL

async function loadImage(file) {
  if ("createImageBitmap" in window) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function shrink(file) {
  const img = await loadImage(file);
  const w = img.width, h = img.height;
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

// ---------------------------------------------------------------------------
// Rendering

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null && c !== "") node.append(c);
  return node;
}

function setStatus(text, { busy = true, error = false } = {}) {
  const s = $("status");
  s.replaceChildren();
  s.classList.toggle("error", error);
  if (!text) return;
  if (busy) s.append(el("span", { className: "spinner" }));
  s.append(el("span", { textContent: text }));
}

function reset() {
  $("start").hidden = true;
  $("work").hidden = false;
  $("product").hidden = true;
  $("edit-form").hidden = true;
  $("verdict").hidden = true;
  $("check").hidden = true;
  $("footnote").hidden = true;
  $("again").hidden = true;
  $("recalls").replaceChildren();
  window.scrollTo({ top: 0 });
}

function showProduct(p) {
  $("product").hidden = false;
  $("product-name").textContent = p.name || "Unknown item";
  $("product-meta").textContent = [p.brand, p.model_or_variety, p.upc && `UPC ${p.upc}`, p.codes_visible && `Codes: ${p.codes_visible}`]
    .filter(Boolean).join(" · ");
  const name = p.name || "";
  $("edit-query").value = p.brand && !name.toLowerCase().includes(p.brand.toLowerCase()) ? `${p.brand} ${name}` : name;
}

const VERDICTS = {
  recalled: "⚠️ Recall found",
  possible: "Possible recall — check your package",
  no_recall_found: "✓ No recalls found",
  unavailable: "Couldn't check right now",
};

function showResults(data, product) {
  const v = $("verdict");
  v.className = `verdict ${data.verdict}`;
  v.replaceChildren(el("strong", { textContent: VERDICTS[data.verdict] || "Results" }), el("p", { textContent: data.summary }));
  v.hidden = false;

  if (data.what_to_check) {
    $("check").replaceChildren(el("b", { textContent: "How to tell if yours is affected" }), data.what_to_check);
    $("check").hidden = false;
  }

  $("recalls").replaceChildren(...(data.recalls || []).map(recallCard));

  const notes = [];
  if (product?.notes && data.verdict !== "recalled") notes.push(product.notes);
  notes.push(`Searched ${SOURCES_LABEL}${data.total_candidates ? ` (${data.total_candidates} notices checked)` : ""}.`);
  if (data.errors?.length) notes.push("Some databases didn't respond, so results may be incomplete — try again later to be sure.");
  $("footnote").textContent = notes.join(" ");
  $("footnote").hidden = false;
  $("again").hidden = false;
}

function recallCard(r) {
  const details = el("dl");
  const row = (label, value) => value && details.append(el("dt", { textContent: label }), el("dd", { textContent: value }));
  row("Product", r.product);
  row("Problem", r.hazard);
  row("What to do", r.remedy);
  row("Affected codes / models", r.codes);
  row("Company", r.firm);

  return el("article", { className: `recall ${r.relevance}` },
    el("div", { className: "recall-top" },
      el("span", { className: "badge", textContent: r.source }),
      el("span", { textContent: formatDate(r.date) }),
      el("span", { textContent: r.relevance === "likely" ? "Likely match" : "Possible match" })),
    el("h3", { textContent: r.title }),
    r.why ? el("p", { className: "why", textContent: r.why }) : null,
    details,
    r.image ? el("img", { src: r.image, alt: "", loading: "lazy" }) : null,
    el("a", { className: "official", href: r.url, target: "_blank", rel: "noopener", textContent: "Read the official notice →" }),
  );
}

function formatDate(d) {
  if (!d) return "";
  const date = new Date(`${d.slice(0, 10)}T12:00:00`);
  return isNaN(date) ? d : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Flows

async function checkPhoto(file) {
  if (!file) return;
  reset();
  const preview = $("preview");
  preview.hidden = true;
  setStatus("Reading the label…");
  try {
    const image = await shrink(file);
    preview.src = image;
    preview.hidden = false;

    const product = await api("/api/identify", { image });
    if (!product.found_product) {
      setStatus(product.notes || "Couldn't find a food product in that photo. Try again closer to the label.", { busy: false, error: true });
      $("product").hidden = false;
      $("product-name").textContent = "No product recognized";
      $("edit-form").hidden = false;
      $("edit-btn").hidden = true;
      $("again").hidden = false;
      return;
    }
    showProduct(product);
    $("edit-btn").hidden = false;
    if (product.category === "not_food") {
      setStatus("This doesn't look like food. This app checks food recalls only. If it is food, tap “Not right? Change it” and type its name.", { busy: false, error: true });
      $("again").hidden = false;
      return;
    }
    await runSearch({ product }, product);
  } catch (err) {
    setStatus(err.message, { busy: false, error: true });
    $("again").hidden = false;
  }
}

async function checkText(query) {
  query = query.trim();
  if (!query) return;
  reset();
  $("preview").hidden = true;
  showProduct({ name: query });
  $("edit-btn").hidden = false;
  try {
    await runSearch({ query });
  } catch (err) {
    setStatus(err.message, { busy: false, error: true });
    $("again").hidden = false;
  }
}

async function runSearch(body, product) {
  $("verdict").hidden = true;
  $("check").hidden = true;
  $("recalls").replaceChildren();
  setStatus(`Checking ${SOURCES_LABEL}…`);
  const data = await api("/api/recalls", body);
  setStatus("");
  showResults(data, product);
}

// ---------------------------------------------------------------------------
// Wiring

for (const id of ["photo", "library"]) {
  $(id).addEventListener("change", (e) => {
    checkPhoto(e.target.files[0]);
    e.target.value = ""; // allow picking the same photo again
  });
}

$("text-search").addEventListener("submit", (e) => {
  e.preventDefault();
  $("query").blur();
  checkText($("query").value);
});

$("edit-btn").addEventListener("click", () => {
  $("edit-form").hidden = false;
  $("edit-btn").hidden = true;
  $("edit-query").focus();
});

$("edit-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("edit-query").value.trim();
  if (!q) return;
  $("edit-query").blur();
  $("edit-form").hidden = true;
  $("edit-btn").hidden = false;
  $("product-name").textContent = q;
  $("product-meta").textContent = "";
  runSearch({ query: q }).catch((err) => setStatus(err.message, { busy: false, error: true }));
});

$("again").addEventListener("click", () => {
  $("work").hidden = true;
  $("start").hidden = false;
  $("query").value = "";
  window.scrollTo({ top: 0 });
});
