// Queries the free, public U.S. government recall databases and normalizes
// every result into one shape:
//   { id, source, title, date, firm, product, hazard, remedy, codes, url, image }
// None of these APIs need a key.

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

async function getJSON(url, { timeoutMs = 12000 } = {}) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": UA },
    signal: AbortSignal.timeout(timeoutMs),
  });
  // openFDA answers "no matches" with a 404.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
  return res.json();
}

const clip = (s, n = 600) => {
  const t = String(s ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

const fdaDate = (d) => (d && d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d || "");

// ---------------------------------------------------------------------------
// CPSC (consumer products: toys, cribs, appliances, furniture, electronics…)
// https://www.cpsc.gov/Recalls/CPSC-Recalls-Application-Program-Interface-API-Information
async function cpsc(terms) {
  const seen = new Map();
  const queries = terms.flatMap((t) => [
    `ProductName=${encodeURIComponent(t)}`,
    `RecallTitle=${encodeURIComponent(t)}`,
  ]);
  const batches = await Promise.allSettled(
    queries.map((q) => getJSON(`https://www.saferproducts.gov/RestWebServices/Recall?format=json&${q}`)),
  );
  if (batches.every((b) => b.status === "rejected")) throw batches[0].reason;
  for (const b of batches) {
    if (b.status !== "fulfilled" || !Array.isArray(b.value)) continue;
    for (const r of b.value) {
      const id = `cpsc-${r.RecallNumber || r.RecallID}`;
      if (seen.has(id)) continue;
      seen.set(id, {
        id,
        source: "CPSC",
        title: clip(r.Title, 200),
        date: (r.RecallDate || "").slice(0, 10),
        firm: (r.Manufacturers || []).map((m) => m.Name).join(", "),
        product: clip(
          [r.Description, ...(r.Products || []).map((p) => [p.Name, p.Description, p.Model].filter(Boolean).join(" – "))].join(" "),
        ),
        hazard: clip((r.Hazards || []).map((h) => h.Name).join(" "), 300),
        remedy: clip((r.Remedies || []).map((h) => h.Name).join(" "), 300),
        codes: clip((r.Products || []).map((p) => p.Model).filter(Boolean).join(", "), 300),
        url: r.URL || "https://www.cpsc.gov/Recalls",
        image: r.Images?.[0]?.URL || null,
      });
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// FDA enforcement reports (food & pet food, drugs, medical devices)
// https://open.fda.gov/apis/
async function fda(kind, terms) {
  const clauses = terms.map((t) => `product_description:${encodeURIComponent(`"${t}"`)}`);
  const firmTerm = terms.brand ? [`recalling_firm:${encodeURIComponent(`"${terms.brand}"`)}`] : [];
  const search = [...clauses, ...firmTerm].join("+OR+");
  const url = `https://api.fda.gov/${kind}/enforcement.json?search=${search}&sort=report_date:desc&limit=30`;
  const data = await getJSON(url);
  const label = { food: "FDA (food)", drug: "FDA (drug)", device: "FDA (device)" }[kind];
  return (data?.results || []).map((r) => ({
    id: `fda-${kind}-${r.recall_number}`,
    source: label,
    title: clip(r.product_description, 200),
    date: fdaDate(r.recall_initiation_date || r.report_date),
    firm: r.recalling_firm || "",
    product: clip(r.product_description),
    hazard: clip(`${r.classification || ""}: ${r.reason_for_recall || ""}`, 400),
    remedy: r.status ? `Status: ${r.status}` : "",
    codes: clip(r.code_info, 400),
    url: r.event_id
      ? `https://www.accessdata.fda.gov/scripts/ires/index.cfm?Event=${encodeURIComponent(r.event_id)}`
      : "https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts",
    image: null,
  }));
}

// ---------------------------------------------------------------------------
// USDA FSIS (meat, poultry, egg products). The API returns the full list, so we
// cache it in memory and filter locally.
let fsisCache = { at: 0, rows: null };
async function fsis(terms) {
  if (!fsisCache.rows || Date.now() - fsisCache.at > 60 * 60 * 1000) {
    const rows = await getJSON("https://www.fsis.usda.gov/fsis/api/recall/v/1", { timeoutMs: 15000 });
    if (!Array.isArray(rows) || !rows.length) return []; // don't cache a bad response
    fsisCache = { at: Date.now(), rows };
  }
  const needles = terms.map((t) => t.toLowerCase());
  return fsisCache.rows
    .filter((r) => (r.langcode || "English") === "English")
    .filter((r) => {
      const hay = `${r.field_title} ${r.field_product_items} ${r.field_establishment} ${r.field_summary}`.toLowerCase();
      return needles.some((n) => hay.includes(n));
    })
    .slice(0, 30)
    .map((r) => ({
      id: `fsis-${r.field_recall_number || r.field_title}`,
      source: "USDA",
      title: clip(r.field_title, 200),
      date: (r.field_recall_date || "").slice(0, 10),
      firm: r.field_establishment || "",
      product: clip(r.field_product_items || r.field_summary),
      hazard: clip(`${r.field_recall_reason || ""} ${r.field_risk_level ? `(${r.field_risk_level})` : ""}`, 300),
      remedy: r.field_active_notice === "True" ? "Active recall" : "",
      codes: clip(r.field_product_items, 400),
      url: r.field_recall_url || "https://www.fsis.usda.gov/recalls",
      image: null,
    }));
}

// ---------------------------------------------------------------------------
// NHTSA (vehicles) — only used when we know make + model + year.
async function nhtsa({ make, model, year }) {
  if (!make || !model || !year) return [];
  const url = `https://api.nhtsa.gov/recalls/recallsByVehicle?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${encodeURIComponent(year)}`;
  const data = await getJSON(url);
  return (data?.results || []).map((r) => ({
    id: `nhtsa-${r.NHTSACampaignNumber}`,
    source: "NHTSA",
    title: clip(`${r.Component}`, 200),
    date: r.ReportReceivedDate || "",
    firm: r.Manufacturer || "",
    product: clip(`${year} ${make} ${model} — ${r.Summary}`),
    hazard: clip(r.Consequence, 300),
    remedy: clip(r.Remedy, 300),
    codes: `Campaign ${r.NHTSACampaignNumber}`,
    url: `https://www.nhtsa.gov/recalls?nhtsaId=${encodeURIComponent(r.NHTSACampaignNumber)}`,
    image: null,
  }));
}

// ---------------------------------------------------------------------------

/**
 * Search every relevant database for the given product.
 * @param {{search_terms: string[], brand?: string, category?: string, vehicle?: object}} product
 * @returns {Promise<{results: object[], errors: string[]}>}
 */
export async function searchAll(product) {
  const terms = [...new Set((product.search_terms || []).map((t) => String(t).trim().slice(0, 60)).filter((t) => t.length >= 3))].slice(0, 4);
  terms.brand = product.brand?.trim() || "";
  if (!terms.length && terms.brand) terms.push(terms.brand);

  const cat = product.category || "other";
  const jobs = [];
  const add = (name, p) => jobs.push(p.then((r) => ({ name, r }), (e) => ({ name, e })));

  if (terms.length) {
    add("CPSC", cpsc(terms));
    if (["food", "pet_food", "supplement", "other"].includes(cat)) add("FDA food", fda("food", terms));
    if (["food", "other"].includes(cat)) add("USDA", fsis(terms));
    if (["drug", "supplement", "cosmetic", "other"].includes(cat)) add("FDA drug", fda("drug", terms));
    if (["medical_device", "other"].includes(cat)) add("FDA device", fda("device", terms));
  }
  if (cat === "vehicle") add("NHTSA", nhtsa(product.vehicle || {}));

  const settled = await Promise.all(jobs);
  const results = [];
  const errors = [];
  for (const { name, r, e } of settled) {
    if (e) errors.push(`${name}: ${e.message}`);
    else results.push(...r);
  }
  results.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return { results, errors, searched: settled.map((s) => s.name) };
}
