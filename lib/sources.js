// Queries the free, public U.S. food recall sources and normalizes every
// result into one shape:
//   { id, source, title, date, firm, product, hazard, remedy, codes, url, image }
// None of these need a key.

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

async function get(url, { timeoutMs = 12000, accept = "application/json" } = {}) {
  const res = await fetch(url, {
    headers: { Accept: accept, "User-Agent": UA },
    signal: AbortSignal.timeout(timeoutMs),
  });
  // openFDA answers "no matches" with a 404.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
  return accept === "application/json" ? res.json() : res.text();
}

const clip = (s, n = 600) => {
  const t = String(s ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

const fdaDate = (d) => (d && d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d || "");

const digits = (s) => String(s ?? "").replace(/\D/g, "");

// Loose keyword test used for sources we have to filter ourselves. Claude does
// the strict matching afterwards, so err on the side of including things.
const STOP = new Set(["with", "and", "the", "for", "from", "brand", "food", "foods", "size", "pack", "original"]);
function matcher(terms) {
  const words = new Set();
  for (const t of [...terms, terms.brand]) {
    for (const w of String(t || "").toLowerCase().split(/[^a-z0-9']+/)) {
      if (w.length >= 4 && !STOP.has(w)) words.add(w);
    }
  }
  const phrases = [...terms, terms.brand].filter(Boolean).map((t) => t.toLowerCase());
  const upc = terms.upc;
  return (text) => {
    const hay = text.toLowerCase();
    if (phrases.some((p) => hay.includes(p))) return 2;
    if (upc && digits(text).includes(upc)) return 2;
    if (!words.size) return 0;
    let hits = 0;
    for (const w of words) if (hay.includes(w)) hits++;
    return hits >= Math.min(2, words.size) ? 1 : 0;
  };
}

// ---------------------------------------------------------------------------
// FDA enforcement reports (food, beverages, supplements, pet food). Detailed,
// with lot codes, but only published once FDA classifies a recall — often a
// week or more after it's announced.
// https://open.fda.gov/apis/food/enforcement/
async function fdaEnforcement(terms) {
  const q = (field, v) => `${field}:${encodeURIComponent(`"${v}"`)}`;
  const clauses = terms.map((t) => q("product_description", t));
  if (terms.brand) clauses.push(q("recalling_firm", terms.brand), q("product_description", terms.brand));
  if (terms.upc) clauses.push(q("code_info", terms.upc), q("product_description", terms.upc));
  const url = `https://api.fda.gov/food/enforcement.json?search=${clauses.join("+OR+")}&sort=report_date:desc&limit=40`;
  const data = await get(url);
  return (data?.results || []).map((r) => ({
    id: `fda-${r.recall_number}`,
    source: "FDA",
    title: clip(r.product_description, 200),
    date: fdaDate(r.recall_initiation_date || r.report_date),
    firm: r.recalling_firm || "",
    product: clip(r.product_description),
    hazard: clip(`${r.classification || ""}: ${r.reason_for_recall || ""}`, 400),
    remedy: r.status ? `Status: ${r.status}` : "",
    codes: clip(r.code_info, 500),
    url: r.event_id
      ? `https://www.accessdata.fda.gov/scripts/ires/index.cfm?Event=${encodeURIComponent(r.event_id)}`
      : "https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts",
    image: null,
  }));
}

// ---------------------------------------------------------------------------
// FDA recall announcements (company press releases FDA posts the day a recall
// is announced). Less detail, but catches brand-new recalls the enforcement
// reports don't have yet. The RSS feed only holds recent items, so fetch it
// whole, cache it, and filter locally.
const FDA_RSS = "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/recalls/rss.xml";

function parseRss(xml) {
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
    if (!m) return "";
    return m[1]
      .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
      .replace(/&amp;/g, "&")
      .trim();
  };
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map(([block]) => ({
    title: tag(block, "title"),
    link: tag(block, "link"),
    description: tag(block, "description"),
    pubDate: tag(block, "pubDate"),
  }));
}

let rssCache = { at: 0, items: null };
async function fdaAnnouncements(terms) {
  if (!rssCache.items || Date.now() - rssCache.at > 30 * 60 * 1000) {
    const xml = await get(FDA_RSS, { accept: "application/rss+xml, application/xml, text/xml" });
    const items = xml ? parseRss(xml) : [];
    if (!items.length) return [];
    rssCache = { at: Date.now(), items };
  }
  const match = matcher(terms);
  return rssCache.items
    .filter((i) => match(`${i.title} ${i.description}`))
    .map((i) => {
      const d = new Date(i.pubDate);
      return {
        id: `fda-news-${i.link.split("/").filter(Boolean).pop() || i.title}`,
        source: "FDA announcement",
        title: clip(i.title, 200),
        date: isNaN(d) ? "" : d.toISOString().slice(0, 10),
        firm: "",
        product: clip(i.description || i.title),
        hazard: "",
        remedy: "",
        codes: "",
        url: i.link || "https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts",
        image: null,
      };
    });
}

// ---------------------------------------------------------------------------
// USDA FSIS (meat, poultry, egg products). The API returns the full list, so we
// cache it in memory and filter locally.
let fsisCache = { at: 0, rows: null };
async function fsis(terms) {
  if (!fsisCache.rows || Date.now() - fsisCache.at > 60 * 60 * 1000) {
    const rows = await get("https://www.fsis.usda.gov/fsis/api/recall/v/1", { timeoutMs: 15000 });
    if (!Array.isArray(rows) || !rows.length) return []; // don't cache a bad response
    fsisCache = { at: Date.now(), rows };
  }
  const match = matcher(terms);
  return fsisCache.rows
    .filter((r) => (r.langcode || "English") === "English")
    .map((r) => [r, match(`${r.field_title} ${r.field_product_items} ${r.field_establishment} ${r.field_summary}`)])
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([r]) => ({
      id: `fsis-${r.field_recall_number || r.field_title}`,
      source: "USDA",
      title: clip(r.field_title, 200),
      date: (r.field_recall_date || "").slice(0, 10),
      firm: r.field_establishment || "",
      product: clip(r.field_product_items || r.field_summary),
      hazard: clip(`${r.field_recall_reason || ""} ${r.field_risk_level ? `(${r.field_risk_level})` : ""}`, 300),
      remedy: r.field_active_notice === "True" ? "Active recall" : "",
      codes: clip(r.field_product_items, 500),
      url: r.field_recall_url || "https://www.fsis.usda.gov/recalls",
      image: null,
    }));
}

// ---------------------------------------------------------------------------

/**
 * Search every food recall source for the given product.
 * @param {{search_terms: string[], brand?: string, upc?: string}} product
 * @returns {Promise<{results: object[], errors: string[], searched: string[]}>}
 */
export async function searchAll(product) {
  const terms = [...new Set((product.search_terms || []).map((t) => String(t).trim().slice(0, 60)).filter((t) => t.length >= 3))].slice(0, 4);
  terms.brand = String(product.brand || "").trim().slice(0, 60);
  const upc = digits(product.upc);
  terms.upc = upc.length >= 8 && upc.length <= 14 ? upc : "";
  if (!terms.length && terms.brand) terms.push(terms.brand);
  if (!terms.length && !terms.upc) return { results: [], errors: [], searched: [] };

  const jobs = [
    ["FDA", fdaEnforcement(terms)],
    ["FDA announcements", fdaAnnouncements(terms)],
    ["USDA", fsis(terms)],
  ].map(([name, p]) => p.then((r) => ({ name, r }), (e) => ({ name, e })));

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
