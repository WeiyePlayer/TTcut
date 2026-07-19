import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders the TTcut product page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html[^>]+lang="zh-CN"/i);
  assert.match(html, /<title>TTcut/);
  assert.match(html, /识别每个回合/);
  assert.match(html, /四步完成/);
  assert.match(html, /所有回合/);
  assert.match(html, /精彩回合/);
  assert.match(html, /自定义/);
  assert.match(html, /历史剪辑/);
  assert.match(html, /不上传视频/);
  assert.match(html, /github\.com\/WeiyePlayer\/TTcut\/releases\/tag\/v1\.0\.0/);
});

test("does not expose implementation architecture", async () => {
  const response = await render();
  const html = await response.text();
  const visibleHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<link[^>]*>/gi, "");

  assert.doesNotMatch(visibleHtml, /Electron|React|TypeScript|Preload|Renderer|PyTorch|FFmpeg|TrackNet/i);
  assert.doesNotMatch(visibleHtml, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});
