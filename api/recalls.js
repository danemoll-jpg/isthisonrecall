import { assessRecalls } from "../lib/claude.js";
import { checkPasscode, json, readBody } from "../lib/http.js";
import { searchAll } from "../lib/sources.js";

// POST { product } or { query: "free text" } -> matching recalls
export async function POST(request) {
  const denied = checkPasscode(request);
  if (denied) return denied;

  const body = await readBody(request);
  let product = body.product;
  if (!product && typeof body.query === "string" && body.query.trim()) {
    const q = body.query.trim().slice(0, 120);
    const words = q.split(/\s+/);
    product = {
      name: q,
      brand: "",
      category: "food",
      upc: /^\d[\d\s-]{7,20}$/.test(q) ? q : "",
      codes_visible: "",
      search_terms: [q, ...(words.length > 2 ? [words.slice(0, 2).join(" ")] : [])],
    };
  }
  if (!product) return json({ error: "bad_request", message: "Nothing to search for." }, 400);

  const { results, errors, searched } = await searchAll(product);

  if (!results.length) {
    const allFailed = errors.length > 0 && errors.length === searched.length;
    return json({
      verdict: allFailed ? "unavailable" : "no_recall_found",
      summary: allFailed
        ? "The recall databases couldn't be reached right now. Please try again in a minute."
        : `No recalls turned up for “${product.name}”.`,
      what_to_check: "",
      recalls: [],
      searched,
      errors,
    });
  }

  try {
    const assessment = await assessRecalls(product, results);
    const byId = new Map(results.map((r) => [r.id, r]));
    const recalls = assessment.matches
      .filter((m) => byId.has(m.id))
      .map((m) => ({ ...byId.get(m.id), relevance: m.relevance, why: m.why }));
    const verdict = recalls.length ? assessment.verdict : "no_recall_found";
    return json({ ...assessment, verdict, recalls, searched, errors, total_candidates: results.length });
  } catch (err) {
    console.error("assess failed", err);
    // Still show the raw keyword hits rather than nothing.
    return json({
      verdict: "possible",
      summary: "We found recall notices that mention similar words, but couldn't check them automatically. Look through them below.",
      what_to_check: "",
      recalls: results.slice(0, 10).map((r) => ({ ...r, relevance: "possible", why: "Keyword match" })),
      searched,
      errors: [...errors, `assessment: ${err.message}`],
    });
  }
}
