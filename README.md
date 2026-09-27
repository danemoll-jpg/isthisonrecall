# Is This On Recall?

A phone-friendly web app: take a picture of a food product and it checks the U.S.
food recall lists to see if it has been recalled.

1. **Photo → product.** The photo is shrunk on the phone and sent to Claude, which
   reads the package: brand, product, flavor and size, the barcode (UPC) number, and
   any lot codes, best-by dates or USDA establishment numbers.
2. **Product → recall search.** The server searches three free public sources:
   - **FDA enforcement reports**: packaged food, drinks, produce, dairy, baby food,
     supplements and pet food. They have the most detail (lot codes, UPCs), but only
     appear once FDA classifies a recall, which is often a week or more after it's announced.
   - **FDA recall announcements**: the company press releases FDA posts the day a
     recall is announced. These catch brand-new recalls.
   - **USDA FSIS**: meat, poultry and egg products.
3. **Recall check.** A keyword search returns many unrelated notices. Claude compares
   each one with the product (brand, product type, UPC, lot codes and dates) and keeps
   only the ones that could apply. Each result says whether it's a likely or possible
   match, which code to look for on the package, and links to the official notice.

You can also type a food name or barcode number instead of taking a photo.

## Deploy it (about 10 minutes, free hosting)

You need an Anthropic API key from <https://console.anthropic.com/>. Each check costs
a few cents.

1. Sign in at <https://vercel.com> with GitHub and choose **Add New → Project**.
   Import this repository and keep the default settings.
2. Under **Environment Variables**, add:
   - `ANTHROPIC_API_KEY`: your key
   - `APP_PASSCODE` (recommended): any passcode you like. The app asks for it once
     per phone, so strangers who find the URL can't spend your API credits.
3. Click **Deploy**. Vercel gives you a URL like `https://isthisonrecall.vercel.app`.

### Put it on the iPhone home screen

Open the URL in **Safari** → tap **Share** → **Add to Home Screen**. It opens full-screen
like a normal app, and "Take a photo" opens the camera directly.

## Run locally

```sh
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
npm run dev          # http://localhost:3000
npm test
```

## Project layout

```
public/          the web page (HTML/CSS/JS, icons, manifest)
api/identify.js  POST photo → product details (Claude vision)
api/recalls.js   POST product or text / barcode query → matching recalls
lib/sources.js   FDA / USDA recall source clients
lib/claude.js    Claude prompts and structured-output schemas
dev-server.js    local server that mimics Vercel
```

## Limits

- Only U.S. food recalls are covered. Photos of things that aren't food are turned away.
- FDA's announcement feed only holds recent items, and its detailed reports can lag
  behind, so a recall announced in the last few days might show up with less detail.
- A "no recalls found" result means nothing matched in these databases, not a guarantee
  the product is safe. Always read the official notice before throwing anything away.
