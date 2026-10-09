// Server-side render of the whole portal. Catches crashes that a successful
// build does not — e.g. a variable used before its declaration (TDZ), which
// left the browser with a blank white page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

test("App renders without throwing", async () => {
  globalThis.window = { ENV: { PVE_ENDPOINTS: "test=pve-test01.example.internal:8006" },
                        location: { href: "http://localhost/" } };
  globalThis.document = { cookie: "" };
  // inside node_modules so the bundle resolves react from the project
  const out = fileURLToPath(new URL(`../node_modules/.cache/smoke/app-${Date.now()}.mjs`, import.meta.url));
  await build({
    entryPoints: [fileURLToPath(new URL("../src/App.jsx", import.meta.url))],
    bundle: true, format: "esm", platform: "node", jsx: "automatic",
    external: ["react", "react-dom", "react/jsx-runtime"], outfile: out, logLevel: "error",
  });
  const { default: App } = await import(out);
  const { createElement } = await import("react");
  const { renderToString } = await import("react-dom/server");
  const html = renderToString(createElement(App));
  assert.ok(html.length > 1000, "suspiciously small render");
  for (const probe of ["DC1", "Create"]) assert.ok(html.includes(probe), `missing "${probe}"`);
});
