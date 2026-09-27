# Is This On Recall?

A phone-friendly web app: take a picture of a product and it checks the U.S.
government recall databases to see if it has been recalled.

1. **Photo → product.** The photo is shrunk on the phone and sent to Claude, which
   reads the label and works out the brand, product, category and any lot or model codes.
2. **Product → recall search.** The server searches the free public recall databases:
   - **CPSC**: toys, baby gear, furniture, appliances, electronics
   - **FDA**: food, pet food, drugs, supplements, medical devices
   - **USDA FSIS**: meat, poultry, egg products
   - **NHTSA**: vehicles (when make, model and year are known)
3. **Recall check.** A keyword search returns many unrelated notices. Claude compares
   each one with the product (brand, product type, lot or model codes) and keeps only
   the ones that could apply. Each result says whether it's a likely or possible match,
   what to look for on the package, and links to the official notice.

You can also type a product name instead of taking a photo.

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
api/recalls.js   POST product or text query → matching recalls
lib/sources.js   CPSC / FDA / USDA / NHTSA API clients
lib/claude.js    Claude prompts and structured-output schemas
dev-server.js    local server that mimics Vercel
```

## Limits

- Only U.S. recall databases are covered. Car seats and tires (NHTSA equipment
  recalls) aren't searched yet.
- A "no recalls found" result means nothing matched in these databases, not a guarantee
  the product is safe. Always read the official notice before throwing anything away.
