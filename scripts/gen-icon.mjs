import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Master → distributable icons. `build/icon.svg` is the single source; this renders it through
// Chromium (pixel-perfect gradients/blur, no fragile SVG delegate) at every size the platforms
// need, then assembles build/icon.icns (macOS), build/icon.ico (Windows), and build/icon.png
// (1024, the cross-platform master electron-builder falls back to). Re-run after editing the SVG:
// `bun run gen:icon`.

const buildDir = join(dirname(fileURLToPath(import.meta.url)), "..", "build");
const svg = readFileSync(join(buildDir, "icon.svg"), "utf8");

// Superset of every size the three platforms consume: the macOS .iconset pairs, plus the small
// sizes Windows .ico carries. Rendered once each, reused across outputs.
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

/** Render the master SVG to an exact size×size transparent PNG. deviceScaleFactor stays 1 and the
 * viewport is the target size, so a pixel is a pixel — each size is a native render, not an upscale. */
async function renderSizes() {
  const browser = await chromium.launch();
  const pngs = new Map();
  try {
    for (const size of SIZES) {
      const page = await browser.newPage({ viewport: { width: size, height: size } });
      await page.setContent(
        `<!doctype html><meta charset="utf-8"><style>*{margin:0;padding:0}html,body{background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
        { waitUntil: "networkidle" },
      );
      pngs.set(size, await page.screenshot({ omitBackground: true }));
      await page.close();
    }
  } finally {
    await browser.close();
  }
  return pngs;
}

/** macOS .icns from the standard iconset name/size pairs, via the system `iconutil`. */
function buildIcns(pngs, scratch) {
  const iconset = join(scratch, "icon.iconset");
  mkdirSync(iconset);
  const pairs = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ];
  for (const [size, name] of pairs) {
    writeFileSync(join(iconset, name), pngs.get(size));
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(buildDir, "icon.icns")]);
}

/** Windows multi-resolution .ico via ImageMagick (`magick`), from the sizes a taskbar/explorer use. */
function buildIco(pngs, scratch) {
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const files = icoSizes.map((size) => {
    const file = join(scratch, `ico-${size}.png`);
    writeFileSync(file, pngs.get(size));
    return file;
  });
  execFileSync("magick", [...files, join(buildDir, "icon.ico")]);
}

const pngs = await renderSizes();
const scratch = mkdtempSync(join(tmpdir(), "reviewer-icon-"));
try {
  writeFileSync(join(buildDir, "icon.png"), pngs.get(1024));
  buildIcns(pngs, scratch);
  if (commandExists("magick")) {
    buildIco(pngs, scratch);
  } else {
    console.warn("magick (ImageMagick) not found — skipped build/icon.ico (Windows).");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

function commandExists(cmd) {
  try {
    execFileSync("command", ["-v", cmd], { shell: "/bin/bash", stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const wrote = ["icon.png", "icon.icns", "icon.ico"].filter((f) => existsSync(join(buildDir, f)));
console.log(`Wrote ${wrote.map((f) => `build/${f}`).join(", ")}`);
