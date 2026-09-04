import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(currentDirectory, "../..");
const expectedVersion = "0.6.0";
const canonicalRepository = "https://github.com/dragonpond916/skill-sherpa";
const legacyIdentity = /hoonsoo|훈수/iu;

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
  assert.match(skill, /start_monitor.{0,240}reviewContext|reviewContext.{0,240}start_monitor/is);
  assert.match(skill, /wait_for_save.{0,240}reviewContext|reviewContext.{0,240}wait_for_save/is);
  assert.match(
    skill,
    /read_review_context.{0,240}recover|recover.{0,240}read_review_context/is,
  );
  for (const toolName of publicTools) assert.match(skill, new RegExp(`\\b${toolName}\\b`));
  for (const toolName of retiredTools) assert.doesNotMatch(skill, new RegExp(`\\b${toolName}\\b`));

  assert.match(skill, /세르파의 \{n\}번째 조언 :/);
  assert.match(skill, /Do not display `revision:`/);
  assert.doesNotMatch(skill, /revision: \{revision\}/);
  assert.match(
    skill,
    /1분간 작업이 감지되지 않았습니다\. 30초 더 기다린 후 세르파 모드가 정지됩니다\./,
  );
  assert.match(skill, /gpt-5\.6-luna/);
  assert.match(skill, /low reasoning effort/i);
  assert.match(skill, /\/fast on/);
  assert.match(skill, /cannot select or change the host task's model/i);
  assert.doesNotMatch(skill, /gpt-5\.6-sol|sherpa-field-checker|sherpa-advisor/);
  assert.doesNotMatch(skill, legacyIdentity);
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
  const codexPlugin = JSON.parse(await read(".codex-plugin/plugin.json"));
  const claudePlugin = JSON.parse(await read(".claude-plugin/plugin.json"));
  const pluginExample = JSON.parse(await read("examples/plugin.json"));
  const manifest = JSON.parse(await read("examples/sherpa.manifest.json"));
  const schema = JSON.parse(await read("schemas/sherpa.manifest.schema.json"));
  const serializedManifest = JSON.stringify(manifest);
  const serializedSchema = JSON.stringify(schema);

  for (const metadata of [packageMetadata, codexPlugin, claudePlugin, pluginExample]) {
    assert.equal(metadata.version, expectedVersion);
    assert.equal(metadata.homepage, canonicalRepository);
    assert.equal(metadata.repository, canonicalRepository);
  }
  assert.equal(manifest.schemaVersion, expectedVersion);
  assert.equal(manifest.metadata.version, expectedVersion);
  assert.equal(manifest.metadata.homepage, canonicalRepository);
  assert.equal(manifest.metadata.repository, canonicalRepository);
  assert.equal(manifest.kind, "SherpaSkill");
  assert.equal(manifest.metadata.name, "sherpa");
  assert.equal(
    schema.$id,
    `${canonicalRepository}/schemas/sherpa.manifest/${expectedVersion}`,
  );
  assert.equal(manifest.command.codexInvocation, "$sherpa <filePath> <prompt>");
  assert.equal(manifest.command.reviewScope, "content-and-grammar");
  assert.equal(manifest.watch.pollIntervalMs, 25);
  assert.equal(manifest.watch.throttling.enabled, false);
  assert.equal(manifest.output.visibleLabels.length, 0);
  assert.ok(manifest.output.forbiddenLabels.includes("revision"));
  assert.equal(manifest.pipeline.reviewPassesPerRevision, 1);
  assert.equal(manifest.pipeline.baseline.contextDelivery, "embedded-in-start_monitor");
  assert.equal(manifest.pipeline.savedRevision.contextDelivery, "embedded-in-wait_for_save");
  assert.deepEqual(manifest.pipeline.recoveryReviewContext, {
    tool: "read_review_context",
    usage: "recovery-only",
  });
  assert.match(serializedManifest, /current-host/i);
  assert.equal(manifest.pipeline.reviewLease.defaultMs, 180000);
  assert.match(serializedManifest, /45000/);
  assert.doesNotMatch(serializedManifest, /fieldCheckAgent|mainReviewAgent|gpt-5\.6-luna|gpt-5\.6-sol/);
  assert.doesNotMatch(serializedManifest, legacyIdentity);
  assert.doesNotMatch(serializedSchema, legacyIdentity);

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
    /hoonsoo|훈수|이름 변경|성능 개선|breaking rename|version history|migration/iu,
  );
  assert.match(readme, /gpt-5\.6-luna/);
  assert.match(readme, /reasoning effort: `low`/i);
  assert.match(readme, /fast mode: `\/fast on`/i);
  assert.doesNotMatch(readme, /gpt-5\.6-sol|sherpa-field-checker|sherpa-advisor/);
});

test("Codex skill metadata keeps only Sherpa as a hard dependency", async () => {
  const metadata = await read("skills/sherpa/agents/openai.yaml");
  assert.equal((metadata.match(/^    - type: "mcp"$/gm) ?? []).length, 1);
  assert.match(metadata, /^      value: "sherpa"$/m);
  assert.match(metadata, /\$sherpa/);
  assert.match(metadata, /one .*current-host pass/);
  assert.match(metadata, /without subagents/i);
});
