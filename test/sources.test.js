import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Each test imports a fresh copy so the in-memory caches don't leak between tests.
let n = 0;
const load = () => import(`../lib/sources.js?t=${n++}`).then((m) => m.searchAll);

// Fake the recall sources with response shapes taken from their docs.
function mockFetch(handlers) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    const h = handlers[u.host];
    if (!h) return new Response("nope", { status: 500 });
    const [status, body] = h(u);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return calls;
}

const RSS = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Recalls</title>
<item>
  <title><![CDATA[Acme Foods Recalls Creamy Peanut Butter Because of Possible Salmonella]]></title>
  <link>https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts/acme-foods-recalls-peanut-butter</link>
  <description>Acme Foods is recalling 16 oz jars of Acme Creamy Peanut Butter &amp; Honey.</description>
  <pubDate>Fri, 26 Sep 2026 14:00:00 EDT</pubDate>
</item>
<item>
  <title>Zeta Recalls Blood Pressure Monitors</title>
  <link>https://www.fda.gov/zeta</link>
  <description>Device issue.</description>
  <pubDate>Thu, 25 Sep 2026 10:00:00 EDT</pubDate>
</item>
</channel></rss>`;

test("combines FDA reports, FDA announcements and USDA, newest first", async () => {
  const searchAll = await load();
  const calls = mockFetch({
    "api.fda.gov": () => [200, { results: [{
      recall_number: "F-1-2025", event_id: "999", product_description: "Acme Peanut Butter 16oz, UPC 0 12345 67890 5",
      recalling_firm: "Acme Foods", report_date: "20250110", classification: "Class I",
      reason_for_recall: "Salmonella", status: "Ongoing", code_info: "Lot 1234",
    }] }],
    "www.fda.gov": () => [200, RSS],
    "www.fsis.usda.gov": () => [200, [
      { field_title: "Bar Co. Recalls Beef Jerky", field_recall_number: "002-2025", langcode: "English" },
    ]],
  });

  const { results, errors, searched } = await searchAll({
    search_terms: ["Acme peanut butter", "peanut butter"], brand: "Acme", upc: "0 12345-67890 5",
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(searched, ["FDA", "FDA announcements", "USDA"]);
  assert.deepEqual(results.map((r) => r.source), ["FDA announcement", "FDA"]);

  const [news, report] = results;
  assert.equal(news.date, "2026-09-26");
  assert.equal(news.title, "Acme Foods Recalls Creamy Peanut Butter Because of Possible Salmonella");
  assert.match(news.product, /Peanut Butter & Honey/);
  assert.match(news.url, /acme-foods-recalls-peanut-butter$/);
  assert.equal(report.date, "2025-01-10");
  assert.equal(report.codes, "Lot 1234");
  assert.match(report.url, /Event=999/);

  const fdaCall = calls.find((c) => c.includes("api.fda.gov/food"));
  assert.match(fdaCall, /product_description:%22Acme%20peanut%20butter%22\+OR\+/);
  assert.match(fdaCall, /recalling_firm:%22Acme%22/);
  assert.match(fdaCall, /code_info:%22012345678905%22/);
});

test("USDA list is filtered locally; English only; failures are reported", async () => {
  const searchAll = await load();
  mockFetch({
    "api.fda.gov": () => [404, { error: { code: "NOT_FOUND" } }],
    "www.fsis.usda.gov": () => [200, [
      { field_title: "Foo Farms Recalls Chicken Nuggets", field_recall_number: "001-2025", field_recall_date: "2025-03-01",
        field_product_items: "Foo Farms chicken nuggets 2lb", langcode: "English", field_recall_reason: "Extraneous material" },
      { field_title: "Bar Co. Recalls Beef", field_recall_number: "002-2025", langcode: "English" },
      { field_title: "Foo Farms retira nuggets", field_recall_number: "001-2025", langcode: "Spanish" },
    ]],
  });
  const { results, errors } = await searchAll({ search_terms: ["chicken nuggets"] });
  assert.equal(results.length, 1);
  assert.equal(results[0].source, "USDA");
  assert.equal(results[0].id, "fsis-001-2025");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^FDA announcements:/);
});

test("nothing to search for → no requests", async () => {
  const searchAll = await load();
  const calls = mockFetch({});
  const out = await searchAll({ search_terms: ["", "a"], brand: "" });
  assert.equal(calls.length, 0);
  assert.deepEqual(out.results, []);
});
