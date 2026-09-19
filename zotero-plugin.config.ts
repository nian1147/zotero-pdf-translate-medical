import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";
import { copyFileSync, existsSync } from "fs";

export default defineConfig({
  source: ["src", "addon"],
  dist: "build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  // Hardcoded to this fork: the {{owner}}/{{repo}} template resolves from
  // package.json, which pointed at the upstream repo and made every install
  // check upstream's update.json instead of ours.
  updateURL: `https://raw.githubusercontent.com/nian1147/zotero-pdf-translate-medical/main/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/nian1147/zotero-pdf-translate-medical/releases/download/v{{version}}/{{xpiName}}.xpi",

  server: {
    asProxy: false,
  },

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    esbuildOptions: [
      {
        entryPoints: [
          { in: "src/index.ts", out: pkg.config.addonRef },
          { in: "src/extras/*.*", out: "" },
        ],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox115",
        outdir: "build/addon/chrome/content/scripts",
      },
    ],
    // Generate update.json and check it into the repository so Zotero's
    // auto-update mechanism picks up new releases.
    makeUpdateJson: {
      hash: false,
    },
    hooks: {
      "build:makeUpdateJSON": () => {
        copyFileSync("build/update.json", "update.json");
        if (existsSync("build/update-beta.json")) {
          copyFileSync("build/update-beta.json", "update-beta.json");
        }
      },
    },
  },
  // release: {
  //   bumpp: {
  //     execute: "npm run build",
  //   },
  // },

  // If you need to see a more detailed build log, uncomment the following line:
  // logLevel: "trace",
});
