import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(currentDirectory, "../..");

async function read(relativePath) {
  return readFile(path.join(projectDirectory, relativePath), "utf8");
}

const publicTools = [
  "start_monitor",
  "read_review_context",
  "publish_feedback",
  "wait_for_save",
  "get_status",
  "stop_monitor",
];

const retiredTools = [
  "read_revision",
  "read_diff_artifact",
  "store_field_analysis",
  "read_field_analysis",
  "read_review_bundle",
  "store_feedback_draft",
  "read_feedback_artifact",
  "mark_feedback_published",
];

test("skill contract defines the six-tool single-pass fast path", async () => {
  const skill = await read("skills/hoonsoo/SKILL.md");

  assert.match(skill, /\$hoonsoo <filepath> <prompt>/);
  assert.match(skill, /content.*grammar|grammar.*content/is);
  assert.match(skill, /disk-backed|persisted to disk|saved revision/is);
  assert.match(skill, /metadata/is);
  assert.match(skill, /raw-content hash|raw content hash|contentHash/is);
  assert.match(skill, /whitespace-only/i);
  assert.match(skill, /same raw-content hash|same raw content hash|metadata-only save/is);
  assert.match(skill, /current host model/i);
  assert.match(skill, /one pass per published revision|one direct combined review|one.*review pass/is);
  assert.match(skill, /Never spawn or delegate to a subagent/i);
  assert.match(skill, /process-local/i);
  assert.match(skill, /analysis lease/i);
  assert.match(skill, /idle warning and automatic stop are paused/i);
  assert.match(skill, /timeoutMs: 45000/);
  for (const toolName of publicTools) assert.match(skill, new RegExp(`\\b${toolName}\\b`));
  for (const toolName of retiredTools) assert.doesNotMatch(skill, new RegExp(`\\b${toolName}\\b`));

  assert.match(skill, /\{n\} 번째 훈수 :/);
  assert.match(skill, /Do not display `revision:`/);
  assert.doesNotMatch(skill, /revision: \{revision\}/);
  assert.match(
    skill,
    /1분 간, 작업이 감지되지 않습니다\. 추가 30초 대기 후, 훈수모드가 정지됩니다\./,
  );
  assert.doesNotMatch(skill, /gpt-5\.6-luna|gpt-5\.6-sol|hoonsoo-field-checker|hoonsoo-advisor/);
  assert.doesNotMatch(skill, /전용 검토 에이전트가.*세션 메모리를 공유하지 못하는 환경/);
  assert.doesNotMatch(skill, /settleMs|pendingMeaningfulChange|ignore-whitespace-only/);
  assert.doesNotMatch(skill, /<context \| grammar>|\/hoonsoo:context|\/hoonsoo:grammar/);
});

test("retired subagent definitions are not packaged", async () => {
  await assert.rejects(read("agents/hoonsoo-field-checker.md"), { code: "ENOENT" });
  await assert.rejects(read("agents/hoonsoo-advisor.md"), { code: "ENOENT" });
});

test("documentation and design reference describe the 0.4.0 fast path", async () => {
  const readme = await read("README.md");
  const packageMetadata = JSON.parse(await read("package.json"));
  const manifest = JSON.parse(await read("examples/hoonsoo.manifest.json"));
  const schema = JSON.parse(await read("schemas/hoonsoo.manifest.schema.json"));
  const serializedManifest = JSON.stringify(manifest);

  assert.equal(packageMetadata.version, "0.4.0");
  assert.equal(manifest.schemaVersion, "0.4.0");
  assert.match(schema.$id, /0\.4\.0$/);
  assert.equal(manifest.command.codexInvocation, "$hoonsoo <filePath> <prompt>");
  assert.equal(manifest.command.reviewScope, "content-and-grammar");
  assert.equal(manifest.watch.pollIntervalMs, 250);
  assert.equal(manifest.watch.throttling.enabled, false);
  assert.equal(manifest.output.visibleLabels.length, 0);
  assert.ok(manifest.output.forbiddenLabels.includes("revision"));
  assert.equal(manifest.pipeline.reviewPassesPerRevision, 1);
  assert.match(serializedManifest, /current-host/i);
  assert.equal(manifest.pipeline.reviewLease.defaultMs, 180000);
  assert.match(serializedManifest, /45000/);
  assert.doesNotMatch(serializedManifest, /fieldCheckAgent|mainReviewAgent|gpt-5\.6-luna|gpt-5\.6-sol/);

  const configuredTools = Array.isArray(manifest.mcpTools)
    ? manifest.mcpTools
    : Object.values(manifest.mcpTools).flat();
  assert.deepEqual([...configuredTools].sort(), [...publicTools].sort());

  assert.match(readme, /0\.4\.0 성능 개선/);
  assert.match(readme, /MONITOR_NOT_FOUND/);
  assert.match(readme, /현재 host model이 직접 응답/);
  assert.match(readme, /한 번의 LLM pass/);
  assert.match(readme, /2초에서 250ms/);
  assert.match(readme, /분석 lease.*idle/is);
  assert.match(readme, /내부 `revision:` 라벨을 제거/);
  assert.match(readme, /수동 Save와 autosave를 구분하지 못합니다/);
  assert.doesNotMatch(readme, /gpt-5\.6-luna|gpt-5\.6-sol|hoonsoo-field-checker|hoonsoo-advisor/);
});

test("Codex skill metadata keeps only Hoonsoo as a hard dependency", async () => {
  const metadata = await read("skills/hoonsoo/agents/openai.yaml");
  assert.equal((metadata.match(/^    - type: "mcp"$/gm) ?? []).length, 1);
  assert.match(metadata, /^      value: "hoonsoo"$/m);
  assert.match(metadata, /\$hoonsoo/);
  assert.match(metadata, /one current-host pass/);
  assert.match(metadata, /without subagents/i);
});
