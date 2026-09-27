import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const MODEL = "claude-opus-5";

const client = new Anthropic();

// If a safety classifier ever declines a request, the API re-runs it on
// Anthropic's recommended fallback model instead of returning a refusal.
const FALLBACK = {
  body: { fallbacks: "default" },
  headers: { "anthropic-beta": "server-side-fallback-2026-07-01" },
};

async function parse(params, schema) {
  const response = await client.messages.parse(
    {
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "low", format: zodOutputFormat(schema) },
      ...params,
      ...FALLBACK.body,
    },
    { headers: FALLBACK.headers },
  );
  if (response.stop_reason === "refusal") throw new Error("The request was declined. Try a different photo.");
  if (!response.parsed_output) throw new Error("Couldn't understand the response. Please try again.");
  return response.parsed_output;
}

// ---------------------------------------------------------------------------

const Product = z.object({
  found_product: z.boolean().describe("false if no identifiable product is in the photo"),
  name: z.string().describe("Short human-friendly product name, e.g. 'Creamy Peanut Butter' or 'Frozen Chicken Nuggets'"),
  brand: z.string().describe("Brand name printed on the package, empty string if unknown"),
  model_or_variety: z.string().describe("Flavor, variety and package size if visible, e.g. 'Honey Roasted, 16 oz', else empty"),
  category: z.enum(["food", "pet_food", "supplement", "not_food"]).describe(
    "food includes drinks, baby food and formula, produce, meat, dairy; not_food for anything that isn't eaten",
  ),
  upc: z.string().describe("The UPC/EAN barcode number printed under the barcode, digits only, if readable; else empty"),
  codes_visible: z.string().describe("Lot, batch, best-by / use-by dates, establishment numbers (e.g. 'EST. 1234' or 'P-1234') readable in the photo, else empty"),
  search_terms: z.array(z.string()).describe(
    "2-4 short keyword phrases (1-3 words each) most likely to appear in an FDA or USDA recall notice for this product, most specific first, e.g. 'Jif peanut butter', 'peanut butter'",
  ),
  notes: z.string().describe(
    "One short sentence to the shopper about what would help, e.g. 'Take a second photo of the lot code and best-by date on the lid.' Empty if nothing to add.",
  ),
});

export async function identifyProduct(base64Jpeg) {
  return parse(
    {
      system:
        "You identify food products from phone photos so they can be checked against U.S. food recall lists (FDA and USDA). Read every visible word: brand, product name, flavor, size, the barcode number, lot codes, best-by dates and USDA establishment numbers. Prefer the exact brand and product name printed on the package. If unsure, give your best guess and say so in notes.",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Jpeg } },
            { type: "text", text: "What food product is this? Fill in every field." },
          ],
        },
      ],
    },
    Product,
  );
}

// ---------------------------------------------------------------------------

const Assessment = z.object({
  verdict: z.enum(["recalled", "possible", "no_recall_found"]).describe(
    "recalled = a recall clearly covers this exact product; possible = a recall covers this brand/product type but it depends on lot/model/date; no_recall_found = nothing relevant",
  ),
  summary: z.string().describe("One or two plain-English sentences for a busy parent, no jargon. If recalled, say what the problem is (e.g. Listeria) and the usual advice: don't eat it; return it or throw it away."),
  what_to_check: z.string().describe("Exactly what to look for on the package (lot code, UPC, best-by date range, size) to confirm, or empty"),
  matches: z.array(
    z.object({
      id: z.string(),
      relevance: z.enum(["likely", "possible"]),
      why: z.string().describe("Short reason this recall may apply"),
    }),
  ).describe("Only recalls that plausibly apply; omit unrelated ones. Most relevant first, at most 8."),
});

export async function assessRecalls(product, candidates) {
  const list = candidates.slice(0, 60).map((c) => ({
    id: c.id,
    source: c.source,
    date: c.date,
    firm: c.firm,
    product: c.product,
    reason: c.hazard,
    codes: c.codes,
  }));
  return parse(
    {
      system:
        "You decide which FDA and USDA food recall notices apply to a specific product a shopper is holding. Keyword search returns many unrelated notices; be strict. A recall applies only if the brand and product type match (a different brand of the same food does not count, but store brands and co-packers named in the notice do). If the recall is limited to certain lots, UPCs, sizes, best-by dates or establishment numbers, compare them against the codes from the shopper's photo (ignore spaces and dashes in UPCs); if you can't confirm, mark it 'possible' and say exactly which code to look for and where it usually is on the package. 'FDA announcement' entries are company press releases and can be the only notice for very recent recalls. The same recall may appear as both an announcement and an FDA report; list it once, preferring the report. If a matching recall is old enough that the product would normally be past its shelf life, still include it but say so in 'why'. Today's date is " +
        new Date().toISOString().slice(0, 10) +
        ".",
      messages: [
        {
          role: "user",
          content:
            `Product the shopper photographed:\n${JSON.stringify(product, null, 2)}\n\n` +
            `Candidate recall notices from keyword search (${list.length}):\n${JSON.stringify(list)}`,
        },
      ],
    },
    Assessment,
  );
}
