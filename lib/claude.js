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
  name: z.string().describe("Short human-friendly product name, e.g. 'Graco Pack 'n Play Playard'"),
  brand: z.string().describe("Brand or manufacturer, empty string if unknown"),
  model_or_variety: z.string().describe("Model number, flavor, size or variety if visible, else empty"),
  category: z.enum(["food", "pet_food", "drug", "supplement", "cosmetic", "medical_device", "vehicle", "consumer_product", "other"]),
  codes_visible: z.string().describe("Any UPC, lot, batch, best-by, serial or model codes readable in the photo, else empty"),
  search_terms: z.array(z.string()).describe("2-4 short keyword phrases (1-3 words each) most likely to appear in a government recall notice for this product. Most specific first, e.g. brand + product type."),
  vehicle: z.object({ make: z.string(), model: z.string(), year: z.string() }).describe("Only for vehicles; empty strings otherwise"),
  notes: z.string().describe("One short sentence to the shopper about what you saw or what would help, e.g. 'Photograph the back label to read the lot code.'"),
});

export async function identifyProduct(base64Jpeg) {
  return parse(
    {
      system:
        "You identify consumer products from phone photos so they can be checked against U.S. government recall databases (CPSC, FDA, USDA, NHTSA). Read every visible word, logo, model number and code. Prefer the exact brand and product name printed on the item. If unsure, give your best guess and say so in notes.",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Jpeg } },
            { type: "text", text: "What product is this? Fill in every field." },
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
  summary: z.string().describe("One or two plain-English sentences for a busy parent, no jargon"),
  what_to_check: z.string().describe("Exactly what to look for on the package (lot code, model #, best-by date range…) to confirm, or empty"),
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
        "You decide which government recall notices apply to a specific product a shopper is holding. Keyword search returns many unrelated notices; be strict. A recall applies only if the brand/manufacturer and product type match (a different brand of the same food does not count). If the recall is limited to certain lots, models or dates, compare against any codes the shopper's photo shows; if you can't confirm, mark it 'possible' and explain what to check. Today's date is " +
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
