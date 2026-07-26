import { createHash } from "node:crypto";
import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const version = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")).version;
const releaseDirectory = join(projectRoot, "out", "make", "squirrel.windows", "x64");
const installerPath = join(releaseDirectory, `TTcut-${version}-x64-Setup.exe`);
const sbomSourcePath = join(projectRoot, ".runtime", "release-metadata", "sbom.cdx.json");
const sbomDestinationPath = join(releaseDirectory, "sbom.cdx.json");
const sumsPath = join(releaseDirectory, "SHA256SUMS.txt");

async function sha256(path) {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

await stat(installerPath);
await stat(sbomSourcePath);
await copyFile(sbomSourcePath, sbomDestinationPath);

const releaseFiles = [installerPath, sbomDestinationPath];
const lines = [];
for (const filePath of releaseFiles) {
  lines.push(`${await sha256(filePath)}  ${basename(filePath)}`);
}
await writeFile(sumsPath, `${lines.join("\n")}\n`, "utf8");

console.log(`Release assets prepared in ${dirname(installerPath)}`);
for (const filePath of [...releaseFiles, sumsPath]) {
  const fileStat = await stat(filePath);
  console.log(`${basename(filePath)}: ${fileStat.size} bytes, sha256=${await sha256(filePath)}`);
}
