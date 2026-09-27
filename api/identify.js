import { identifyProduct } from "../lib/claude.js";
import { checkPasscode, json, readBody } from "../lib/http.js";

// POST { image: "data:image/jpeg;base64,..." } -> product description
export async function POST(request) {
  const denied = checkPasscode(request);
  if (denied) return denied;

  const { image } = await readBody(request);
  const base64 = typeof image === "string" ? image.replace(/^data:image\/\w+;base64,/, "") : "";
  if (!base64) return json({ error: "bad_request", message: "No photo received." }, 400);
  if (base64.length > 4_000_000) return json({ error: "bad_request", message: "Photo is too large." }, 413);

  try {
    return json(await identifyProduct(base64));
  } catch (err) {
    console.error("identify failed", err);
    return json({ error: "identify_failed", message: err.message || "Couldn't identify the item." }, 502);
  }
}
