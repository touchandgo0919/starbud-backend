import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

let buildDir;
let learningIssues;

before(async () => {
  buildDir = await mkdtemp(join(tmpdir(), "starbud-learning-issues-test-"));
  const output = join(buildDir, "ai-learning-issues.mjs");
  await build({
    entryPoints: [resolve("src/services/ai-learning-issues.ts")],
    bundle: true,
    format: "esm",
    outfile: output,
    platform: "browser",
    target: "es2022"
  });
  learningIssues = await import(pathToFileURL(output));
});

after(async () => {
  if (buildDir) await rm(buildDir, { recursive: true, force: true });
});

test("normalizes model issues and preserves confidence for display filtering", () => {
  const result = learningIssues.normalizeLearningIssueResult({
    summary: "本次主要需要巩固进位计算。",
    issues: [
      { topic: "进位加法", category: "calculation", summary: "进位步骤遗漏", evidence: "批改图标出计算错误", confidence: "high" },
      { topic: "疑似审题", category: "unknown", summary: "条件可能遗漏", evidence: "证据不足", confidence: "low" },
      { topic: "", category: "concept", summary: "无主题记录", evidence: "", confidence: "medium" }
    ]
  });

  assert.equal(result.summary, "本次主要需要巩固进位计算。");
  assert.equal(result.issues.length, 2);
  assert.equal(result.issues[0].category, "calculation");
  assert.equal(result.issues[1].category, "other");
  assert.equal(result.issues[1].confidence, "low");
});

test("returns a neutral empty result when the model has no reliable issue", () => {
  const result = learningIssues.normalizeLearningIssueResult({ issues: [] });
  assert.deepEqual(result.issues, []);
  assert.match(result.summary, /未识别到/);
});

test("never selects homework or review images unless the family opted in", () => {
  const reviewedImages = [{ object_key: "review/1.png", content_type: "image/png", byte_size: 10 }];
  const originalPhotos = [{ object_key: "photo/1.png", content_type: "image/png", byte_size: 0 }];
  assert.deepEqual(learningIssues.selectLearningIssueImageRows({ allowMediaAnalysis: false, reviewedImages, originalPhotos }), []);
  assert.deepEqual(learningIssues.selectLearningIssueImageRows({ allowMediaAnalysis: true, reviewedImages, originalPhotos }), reviewedImages);
  assert.deepEqual(learningIssues.selectLearningIssueImageRows({ allowMediaAnalysis: true, reviewedImages: [], originalPhotos }), originalPhotos);
});

test("skips the model when there is neither an allowed image nor text feedback", () => {
  assert.equal(learningIssues.shouldSkipLearningIssueModel({ imageCount: 0, reviewFeedback: "  " }), true);
  assert.equal(learningIssues.shouldSkipLearningIssueModel({ imageCount: 0, reviewFeedback: "第二题进位错误" }), false);
  assert.equal(learningIssues.shouldSkipLearningIssueModel({ imageCount: 2, reviewFeedback: "" }), false);
});
