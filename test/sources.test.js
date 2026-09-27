import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { searchAll } from "../lib/sources.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Fake the government APIs with response shapes taken from their docs.
function mockFetch(handlers) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    const h = handlers[u.host];
    if (!h) return new Response("nope", { status: 500 });
    const [status, body] = h(u);
    return new Response(JSON.stringify(body), { status });
  };
  return calls;
}

test("normalizes CPSC and FDA results and sorts newest first", async () => {
  const calls = mockFetch({
    "www.saferproducts.gov": () => [200, [{
      RecallID: 1, RecallNumber: "24123", RecallDate: "2024-05-02T00:00:00",
      Title: "Acme Recalls Baby Loungers Due to Suffocation Hazard",
      Description: "This recall involves Acme loungers.",
      URL: "https://www.cpsc.gov/Recalls/2024/acme",
      Products: [{ Name: "Acme Baby Lounger", Model: "AL-100" }],
      Manufacturers: [{ Name: "Acme Inc." }],
      Hazards: [{ Name: "Suffocation hazard." }],
      Remedies: [{ Name: "Refund" }],
      Images: [{ URL: "https://www.cpsc.gov/img.jpg" }],
    }]],
    "api.fda.gov": (u) => u.pathname.startsWith("/food")
      ? [200, { results: [{
          recall_number: "F-1-2025", event_id: "999", product_description: "Acme Peanut Butter 16oz",
          recalling_firm: "Acme Foods", report_date: "20250110", classification: "Class I",
          reason_for_recall: "Salmonella", status: "Ongoing", code_info: "Lot 1234",
        }] }]
      : [404, { error: { code: "NOT_FOUND" } }],
    "www.fsis.usda.gov": () => [200, []],
  });

  const { results, errors } = await searchAll({ search_terms: ["Acme lounger"], brand: "Acme", category: "other" });
  assert.deepEqual(errors, []);
  assert.equal(results.length, 2);
  assert.equal(results[0].source, "FDA (food)");
  assert.equal(results[0].date, "2025-01-10");
  assert.equal(results[0].codes, "Lot 1234");
  assert.match(results[0].url, /Event=999/);
  assert.equal(results[1].source, "CPSC");
  assert.equal(results[1].codes, "AL-100");
  assert.equal(results[1].image, "https://www.cpsc.gov/img.jpg");

  const fdaCall = calls.find((c) => c.includes("api.fda.gov/food"));
  assert.match(fdaCall, /product_description:%22Acme%20lounger%22\+OR\+recalling_firm:%22Acme%22/);
});

test("filters USDA list locally and tolerates a failing source", async () => {
  mockFetch({
    "www.saferproducts.gov": () => [503, {}],
    "api.fda.gov": () => [404, {}],
    "www.fsis.usda.gov": () => [200, [
      { field_title: "Foo Farms Recalls Chicken Nuggets", field_recall_number: "001-2025", field_recall_date: "2025-03-01",
        field_product_items: "Foo Farms chicken nuggets 2lb", langcode: "English", field_recall_reason: "Extraneous material" },
      { field_title: "Bar Co. Recalls Beef", field_recall_number: "002-2025", langcode: "English" },
      { field_title: "Foo Farms retira nuggets", field_recall_number: "001-2025", langcode: "Spanish" },
    ]],
  });
  const { results } = await searchAll({ search_terms: ["chicken nuggets"], category: "food" });
  assert.equal(results.length, 1);
  assert.equal(results[0].source, "USDA");
  assert.equal(results[0].id, "fsis-001-2025");
});

test("vehicles go to NHTSA only", async () => {
  const calls = mockFetch({
    "api.nhtsa.gov": () => [200, { results: [{
      NHTSACampaignNumber: "24V123000", Component: "AIR BAGS", Summary: "Inflator may rupture.",
      Consequence: "Injury", Remedy: "Dealers will replace", Manufacturer: "Honda", ReportReceivedDate: "15/03/2024",
    }] }],
  });
  const { results } = await searchAll({ category: "vehicle", search_terms: [], vehicle: { make: "Honda", model: "Accord", year: "2018" } });
  assert.equal(calls.length, 1);
  assert.equal(results[0].source, "NHTSA");
  assert.match(results[0].url, /24V123000/);
});

test("reports a source as failed when every query to it fails", async () => {
  mockFetch({});
  const { results, errors, searched } = await searchAll({ search_terms: ["crib"], category: "consumer_product" });
  assert.equal(results.length, 0);
  assert.deepEqual(searched, ["CPSC"]);
  assert.equal(errors.length, 1);
});
