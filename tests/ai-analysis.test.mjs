import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

let buildDir;
let analysis;

before(async () => {
  buildDir = await mkdtemp(join(tmpdir(), "starbud-ai-analysis-test-"));
  const output = join(buildDir, "ai-analysis.mjs");
  await build({
    entryPoints: [resolve("src/services/ai-analysis.ts")],
    bundle: true,
    format: "esm",
    outfile: output,
    platform: "browser",
    target: "es2022"
  });
  analysis = await import(pathToFileURL(output));
});

after(async () => {
  if (buildDir) await rm(buildDir, { recursive: true, force: true });
});

test("extracts text from supported Responses API payloads", () => {
  assert.equal(analysis.extractAiResponseText({ output_text: '{"ok":true}' }), '{"ok":true}');
  assert.equal(analysis.extractAiResponseText({
    output: [{ content: [{ type: "output_text", text: '{"nested":true}' }] }]
  }), '{"nested":true}');
  assert.equal(analysis.extractAiResponseText({ output: [] }), "");
});

test("runs the daily analysis only at the configured China-time hour", () => {
  const fourAmChina = new Date("2026-08-06T20:00:00.000Z");
  const fourOhOneChina = new Date("2026-08-06T20:01:00.000Z");
  assert.equal(analysis.shouldRunDailyAiAnalysis({ AI_ANALYSIS_HOUR: "4" }, fourAmChina), true);
  assert.equal(analysis.shouldRunDailyAiAnalysis({ AI_ANALYSIS_HOUR: "4" }, fourOhOneChina), false);
  assert.equal(analysis.shouldRunDailyAiAnalysis({ AI_ANALYSIS_HOUR: "5" }, fourAmChina), false);
});
