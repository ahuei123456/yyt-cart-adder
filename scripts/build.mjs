import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const metadataPath = resolve(projectRoot, "src/metadata.txt");
const entryPoint = resolve(projectRoot, "src/main.js");
const outputPath = resolve(projectRoot, "dist/yyt-cart-adder.user.js");

// package.json is the single source of the version; Tampermonkey only offers
// an update when @version increases.
const { version } = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
const metadata = (await readFile(metadataPath, "utf8")).trimEnd().replace("{{VERSION}}", version);
await mkdir(dirname(outputPath), { recursive: true });

await build({
  absWorkingDir: projectRoot,
  entryPoints: [entryPoint],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  outfile: outputPath,
  banner: { js: metadata },
  legalComments: "none",
  sourcemap: false,
});

console.log(`Built ${outputPath}`);
