// Build: transpile src/ -> dist/ (esbuild, no bundling — imports already use
// .js specifiers), copy room assets, then assemble bundle/ for `mcpb pack`
// (manifest + dist + production node_modules).
import { build } from "esbuild";
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "src");
const dist = path.join(here, "dist");
const bundle = path.join(here, "bundle");

rmSync(dist, { recursive: true, force: true });

const entries = readdirSync(src, { recursive: true })
  .map(String)
  .filter(
    (f) =>
      f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.startsWith("room_assets"),
  )
  .map((f) => path.join(src, f));

await build({
  entryPoints: entries,
  outdir: dist,
  outbase: src,
  platform: "node",
  format: "esm",
  target: "node18",
  sourcemap: false,
  bundle: false,
});

cpSync(path.join(src, "room_assets"), path.join(dist, "room_assets"), {
  recursive: true,
});

// UI apps: bundle each ui/<name>/<name>.ts into a single self-contained
// dist/ui/<name>.html. The host CSP blocks all external origins by default,
// so every script/style/font must live inside the one HTML resource.
const uiSrc = path.join(here, "ui");

// Brand fonts inlined as data: URIs where a template asks for them via the
// /*__FONTS__*/ placeholder. Currently EMPTY: all card text uses the host's
// UI font (webfonts hint poorly at 12-14px on Windows). Jost 600 shipped
// while the card had its uppercase eyebrow title; the title is gone, so no
// font ships. Lora (ui/fonts/lora-600-latin.woff2) is deliberately NOT
// inlined: serif headings turn muddy at card-chrome sizes — re-add fonts
// only for a view with 18px+ headings, e.g.
// { file: "jost-latin.woff2", family: "Jost", weight: "600" }. Each entry
// embeds the full file, so add weights sparingly.
const FONTS = [];
function fontFaceCss() {
  const rules = [];
  for (const { file, family, weight } of FONTS) {
    const p = path.join(uiSrc, "fonts", file);
    if (!existsSync(p)) continue;
    const b64 = readFileSync(p).toString("base64");
    rules.push(
      `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};` +
        `font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2');}`,
    );
  }
  return rules.join("\n");
}
if (existsSync(uiSrc)) {
  for (const dirent of readdirSync(uiSrc, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const name = dirent.name;
    const entry = path.join(uiSrc, name, `${name}.ts`);
    const template = path.join(uiSrc, name, `${name}.html`);
    if (!existsSync(entry) || !existsSync(template)) continue;
    const bundled = await build({
      entryPoints: [entry],
      bundle: true,
      platform: "browser",
      format: "iife",
      target: "es2020",
      minify: true,
      write: false,
    });
    // "</script" inside the inlined JS would terminate the script element
    const js = bundled.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
    const html = readFileSync(template, "utf-8")
      .replace("/*__FONTS__*/", fontFaceCss)
      .replace("<!--__SCRIPT__-->", () => `<script>${js}</script>`);
    if (!html.includes(js)) {
      throw new Error(`ui/${name}/${name}.html is missing <!--__SCRIPT__-->`);
    }
    mkdirSync(path.join(dist, "ui"), { recursive: true });
    writeFileSync(path.join(dist, "ui", `${name}.html`), html);
    console.log(
      `ui bundle: dist/ui/${name}.html (${Math.round(Buffer.byteLength(html) / 1024)} KB)`,
    );
  }
}

// build stamp: the server prints this at boot, so a Claude Desktop log always
// says exactly which build is running — a stale re-packed artifact can no
// longer masquerade as the current code
const srcHash = createHash("sha256");
// ui/ is included so ui:// resource URIs (versioned by this hash) change
// whenever the app bundle changes — hosts cache those URIs aggressively
for (const root of [src, uiSrc].filter(existsSync)) {
  for (const f of readdirSync(root, { recursive: true }).sort()) {
    const full = path.join(root, String(f));
    try {
      srcHash
        .update(path.basename(root) + "/" + String(f))
        .update(readFileSync(full));
    } catch {
      /* directory */
    }
  }
}
writeFileSync(
  path.join(dist, "build-info.json"),
  JSON.stringify({
    builtAt: new Date().toISOString(),
    srcHash: srcHash.digest("hex").slice(0, 12),
  }),
);

if (process.argv.includes("--no-bundle")) {
  console.log("dist/ built (bundle skipped)");
  process.exit(0);
}

rmSync(bundle, { recursive: true, force: true });
mkdirSync(bundle, { recursive: true });
copyFileSync(
  path.join(here, "manifest.json"),
  path.join(bundle, "manifest.json"),
);
copyFileSync(
  path.join(here, "package.json"),
  path.join(bundle, "package.json"),
);
copyFileSync(
  path.join(here, "package-lock.json"),
  path.join(bundle, "package-lock.json"),
);
copyFileSync(path.join(here, "LICENSE"), path.join(bundle, "LICENSE"));
cpSync(dist, path.join(bundle, "dist"), { recursive: true });
// pure-JS production deps only; platform-independent, so a bundle built on
// Windows runs on macOS
execSync("npm ci --omit=dev --ignore-scripts", {
  cwd: bundle,
  stdio: "inherit",
});
console.log("bundle/ ready — run `npx mcpb pack bundle messageoperator.mcpb`");
