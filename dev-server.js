// Local development server: serves public/ and routes /api/<name> to the same
// handlers Vercel runs in production. Usage: npm run dev
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.env.PORT) || 3000;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const name = url.pathname.slice(5).replace(/[^a-z-]/g, "");
      const mod = await import(`./api/${name}.js`);
      const handler = mod[req.method];
      if (!handler) return void res.writeHead(405).end();
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      return void res.end(Buffer.from(await response.arrayBuffer()));
    }
    const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
    const body = await readFile(join("public", path));
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream" }).end(body);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ERR_MODULE_NOT_FOUND") return void res.writeHead(404).end("Not found");
    console.error(err);
    res.writeHead(500).end("Server error");
  }
}).listen(PORT, () => console.log(`Is This On Recall? → http://localhost:${PORT}`));
