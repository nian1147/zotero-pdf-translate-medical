// Resize the avatar master for Zotero's preference and reader icons.
// Usage: node scripts/build-avatar-icons.cjs
// Requires sharp (the Codex workspace runtime also bundles it).
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const directory = path.resolve(__dirname, "../addon/chrome/content/icons");
const source = path.resolve(__dirname, "../assets/avatar.png");
const sizes = {
  "avatar-16.png": 16,
  "avatar-20.png": 20,
  "favicon.png": 48,
  "favicon@2x.png": 96,
};

async function main() {
  for (const [filename, size] of Object.entries(sizes)) {
    await sharp(source)
      .resize(size, size)
      .png()
      .toFile(path.join(directory, filename));
  }
  // SVG containers keep the original icon paths compatible for other consumers
  // while embedding the avatar, with no external image dependency.
  for (const size of [16, 20]) {
    const bytes = fs.readFileSync(path.join(directory, `avatar-${size}.png`));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><image width="${size}" height="${size}" href="data:image/png;base64,${bytes.toString("base64")}"/></svg>\n`;
    fs.writeFileSync(path.join(directory, `section-${size}.svg`), svg);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
