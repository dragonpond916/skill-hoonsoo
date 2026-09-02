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
  const skill = await read("skills/sherpa/SKILL.md");

  assert.match(skill, /\$sherpa <filepath> <prompt>/);
  assert.match(skill, /\/skill-sherpa:sherpa <filepath> <prompt>/);
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

  assert.match(skill, /세르파의 \{n\}번째 조언 :/);
  assert.match(skill, /Do not display `revision:`/);
  assert.doesNotMatch(skill, /revision: \{revision\}/);
  assert.match(
    skill,
    /1분간 작업이 감지되지 않았습니다\. 30초 더 기다린 후 세르파 모드가 정지됩니다\./,
  );
  assert.doesNotMatch(skill, /gpt-5\.6-luna|gpt-5\.6-sol|sherpa-field-checker|sherpa-advisor/);
  assert.doesNotMatch(skill, /\$hoonsoo|\/skill-hoonsoo:hoonsoo|\bHoonsoo\b/);
  assert.doesNotMatch(skill, /전용 검토 에이전트가.*세션 메모리를 공유하지 못하는 환경/);
  assert.doesNotMatch(skill, /settleMs|pendingMeaningfulChange|ignore-whitespace-only/);
  assert.doesNotMatch(skill, /<context \| grammar>|\/sherpa:context|\/sherpa:grammar/);
});

test("retired subagent definitions are not packaged", async () => {
  await assert.rejects(read("agents/sherpa-field-checker.md"), { code: "ENOENT" });
  await assert.rejects(read("agents/sherpa-advisor.md"), { code: "ENOENT" });
});

test("documentation describes Sherpa as the sole product identity", async () => {
  const readme = await read("README.md");
  const packageMetadata = JSON.parse(await read("package.json"));
  const manifest = JSON.parse(await read("examples/sherpa.manifest.json"));
  const schema = JSON.parse(await read("schemas/sherpa.manifest.schema.json"));
  const serializedManifest = JSON.stringify(manifest);

  assert.equal(packageMetadata.version, "0.5.0");
  assert.equal(manifest.schemaVersion, "0.5.0");
  assert.equal(manifest.kind, "SherpaSkill");
  assert.equal(manifest.metadata.name, "sherpa");
  assert.match(schema.$id, /0\.5\.0$/);
  assert.equal(manifest.command.codexInvocation, "$sherpa <filePath> <prompt>");
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

  assert.match(readme, /^# skill-sherpa$/m);
  assert.match(readme, /\$sherpa <filepath> <prompt>/);
  assert.match(readme, /\/skill-sherpa:sherpa <filepath> <prompt>/);
  assert.match(readme, /세르파의 \{n\}번째 조언 :/);
  assert.match(readme, /dragonpond916\/skill-sherpa/);
  assert.match(readme, /현재 동작 구조의 설계 reference/);
  assert.match(readme, /수동 Save와 autosave를 구분하지 못합니다/);
  assert.doesNotMatch(
    readme,
    /hoonsoo|훈수중지|이름 변경|성능 개선|breaking rename|0\.3\.0|0\.4\.0|0\.5\.0/iu,
  );
  assert.doesNotMatch(readme, /gpt-5\.6-luna|gpt-5\.6-sol|sherpa-field-checker|sherpa-advisor/);
});

test("Codex skill metadata keeps only Sherpa as a hard dependency", async () => {
  const metadata = await read("skills/sherpa/agents/openai.yaml");
  assert.equal((metadata.match(/^    - type: "mcp"$/gm) ?? []).length, 1);
  assert.match(metadata, /^      value: "sherpa"$/m);
  assert.match(metadata, /\$sherpa/);
  assert.match(metadata, /one current-host pass/);
  assert.match(metadata, /without subagents/i);
});
