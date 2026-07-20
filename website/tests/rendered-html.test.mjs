import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  return readFile(new URL("../.next/server/app/index.html", import.meta.url), "utf8");
}

test("renders the TTcut product page", async () => {
  const html = await render();
  assert.match(html, /<html[^>]+lang="zh-CN"/i);
  assert.match(html, /<title>TTcut/);
  assert.match(html, /识别每个回合/);
  assert.match(html, /四步完成/);
  assert.match(html, /所有回合/);
  assert.match(html, /精彩回合/);
  assert.match(html, /自定义/);
  assert.match(html, /历史剪辑/);
  assert.match(html, /不上传视频/);
  assert.match(html, /TTcut\.mp4/);
  assert.match(html, /https:\/\/ttcut\.vercel\.app\/og\.png/);
  const visibleHtml = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  const downloadUrl = "https://github.com/WeiyePlayer/TTcut/releases/download/v1.0.0/TTcut-1.0.0-x64-Setup.exe";
  assert.equal(visibleHtml.match(new RegExp(`href="${downloadUrl.replaceAll(".", "\\.")}"`, "g"))?.length, 4);
  assert.doesNotMatch(visibleHtml, /releases\/tag\/v1\.0\.0/);
  assert.equal(visibleHtml.match(/>前往Github(?:\s|<)/g)?.length, 1);
  assert.match(visibleHtml, /href="https:\/\/github\.com\/WeiyePlayer\/TTcut"[^>]*>前往Github/);
  assert.doesNotMatch(visibleHtml, /1-193\.mp4/);
  assert.doesNotMatch(visibleHtml, /板数.*真实击球次数/);
  assert.doesNotMatch(visibleHtml, /回合前后.*都留一点呼吸/);
});

test("does not expose implementation architecture", async () => {
  const html = await render();
  const visibleHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<link[^>]*>/gi, "");

  assert.doesNotMatch(visibleHtml, /Electron|React|TypeScript|Preload|Renderer|PyTorch|FFmpeg|TrackNet/i);
  assert.doesNotMatch(visibleHtml, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});
