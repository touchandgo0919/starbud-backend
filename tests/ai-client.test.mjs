import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

let buildDir;
let ai;

before(async () => {
  buildDir = await mkdtemp(join(tmpdir(), "starbud-ai-client-test-"));
  const output = join(buildDir, "ai.mjs");
  await build({
    entryPoints: [resolve("src/services/ai.ts")],
    bundle: true,
    format: "esm",
    outfile: output,
    platform: "browser",
    target: "es2022"
  });
  await readFile(output, "utf8");
  ai = await import(pathToFileURL(output));
});

after(async () => {
  if (buildDir) await rm(buildDir, { recursive: true, force: true });
});

test("uses the centralized Responses API configuration without storing responses", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return Response.json({ id: "response-test" });
  };

  try {
    const result = await ai.createAiResponse({
      OPENAI_API_KEY: "test-only-key",
      AI_PROVIDER: "OpenAI",
      AI_BASE_URL: "https://provider.example/",
      AI_RESPONSES_PATH: "v1/responses",
      AI_MODEL: "gpt-5.5",
      AI_REASONING_EFFORT: "xhigh"
    }, {
      instructions: "Return JSON.",
      input: "Summarize the metrics.",
      maxOutputTokens: 300
    });

    assert.equal(result.id, "response-test");
    assert.equal(captured.url, "https://provider.example/v1/responses");
    assert.equal(captured.init.headers.authorization, "Bearer test-only-key");
    assert.deepEqual(JSON.parse(captured.init.body), {
      model: "gpt-5.5",
      input: "Summarize the metrics.",
      instructions: "Return JSON.",
      max_output_tokens: 300,
      reasoning: { effort: "xhigh" },
      store: false
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requires a secret and rejects unsupported reasoning effort", async () => {
  await assert.rejects(
    ai.createAiResponse({}, { input: "test" }),
    /OPENAI_API_KEY is not configured/
  );
  assert.throws(
    () => ai.getAiConfig({ AI_REASONING_EFFORT: "maximum" }),
    /Unsupported AI_REASONING_EFFORT/
  );
});
