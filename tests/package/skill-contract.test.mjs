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

test("skill contract exposes one combined saved-revision workflow", async () => {
  const skill = await read("skills/hoonsoo/SKILL.md");
  const toolNames = [
    "start_monitor",
    "read_revision",
    "wait_for_save",
    "read_diff_artifact",
    "store_field_analysis",
    "read_field_analysis",
    "read_review_bundle",
    "store_feedback_draft",
    "read_feedback_artifact",
    "mark_feedback_published",
    "get_status",
    "stop_monitor",
  ];

  assert.match(skill, /\$hoonsoo <filepath> <prompt>/);
  assert.match(skill, /content.*grammar|grammar.*content/is);
  assert.match(skill, /saved|save event|disk/is);
  assert.match(skill, /metadata/is);
  assert.match(skill, /raw content hash|rawContentHash|contentHash/is);
  assert.match(skill, /whitespace/is);
  assert.match(skill, /identical|same raw content hash|no-op save/is);
  assert.match(skill, /Reference-only|reference-only/i);
  assert.match(skill, /session memory|session-memory/i);
  assert.match(skill, /gpt-5\.6-luna/);
  assert.match(skill, /gpt-5\.6-sol/);
  for (const toolName of toolNames) assert.match(skill, new RegExp(`\\b${toolName}\\b`));

  assert.match(skill, /\{n\} 번째 훈수 :/);
  assert.match(skill, /revision: \{revision\}/);
  assert.match(
    skill,
    /1분 간, 작업이 감지되지 않습니다\. 추가 30초 대기 후, 훈수모드가 정지됩니다\./,
  );
  assert.doesNotMatch(skill, /settleMs|pendingMeaningfulChange|ignore-whitespace-only/);
  assert.doesNotMatch(skill, /<context \| grammar>|\/hoonsoo:context|\/hoonsoo:grammar/);
  assert.doesNotMatch(skill, /timeoutMs\s*=\s*50000|Send only a brief heartbeat/);
  assert.doesNotMatch(skill, /- revision: <integer>/);
});

test("Claude agents split low-cost field analysis from flagship review", async () => {
  const [fieldChecker, advisor] = await Promise.all([
    read("agents/hoonsoo-field-checker.md"),
    read("agents/hoonsoo-advisor.md"),
  ]);

  assert.match(fieldChecker, /^---\nname: hoonsoo-field-checker/m);
  assert.match(fieldChecker, /^model: haiku$/m);
  assert.match(fieldChecker, /^disallowedTools: Write, Edit, NotebookEdit, Bash$/m);
  assert.match(fieldChecker, /read_diff_artifact/);
  assert.match(fieldChecker, /store_field_analysis/);
  assert.match(fieldChecker, /revision/i);
  assert.match(fieldChecker, /Never edit|never edit/i);

  assert.match(advisor, /^---\nname: hoonsoo-advisor/m);
  assert.match(advisor, /^model: fable$/m);
  assert.match(advisor, /^effort: high$/m);
  assert.match(advisor, /^disallowedTools: Write, Edit, NotebookEdit, Bash$/m);
  assert.match(advisor, /read_review_bundle/);
  assert.match(advisor, /store_feedback_draft/);
  assert.match(advisor, /content.*grammar|grammar.*content/is);
  assert.match(advisor, /Never edit|never edit/i);
});

test("documentation and design reference describe the 0.3.0 save pipeline", async () => {
  const readme = await read("README.md");
  const packageMetadata = JSON.parse(await read("package.json"));
  const manifest = JSON.parse(await read("examples/hoonsoo.manifest.json"));
  const schema = JSON.parse(await read("schemas/hoonsoo.manifest.schema.json"));
  const serializedManifest = JSON.stringify(manifest);

  assert.equal(packageMetadata.version, "0.3.0");
  assert.equal(manifest.schemaVersion, "0.3.0");
  assert.match(schema.$id, /0\.3\.0$/);
  assert.equal(manifest.command.codexInvocation, "$hoonsoo <filePath> <prompt>");
  assert.equal(manifest.command.reviewScope, "content-and-grammar");
  assert.equal(manifest.watch.throttling.enabled, false);
  assert.doesNotMatch(
    serializedManifest,
    /settleMs|ignore-whitespace-only|\/hoonsoo:context|\/hoonsoo:grammar/,
  );

  assert.equal(manifest.agents.monitoringAgent.implementation, "deterministic-worker");
  assert.equal(manifest.agents.diffCheckAgent.implementation, "deterministic-worker");
  assert.equal(manifest.agents.fieldCheckAgent.implementation, "llm-agent");
  assert.equal(manifest.agents.mainReviewAgent.modelClass, "flagship");
  assert.ok(
    manifest.pipeline.sequence.indexOf("monitoringAgent") <
      manifest.pipeline.sequence.indexOf("diffCheckAgent"),
  );
  assert.ok(
    manifest.pipeline.sequence.indexOf("diffCheckAgent") <
      manifest.pipeline.sequence.indexOf("fieldCheckAgent"),
  );
  assert.ok(
    manifest.pipeline.sequence.indexOf("fieldCheckAgent") <
      manifest.pipeline.sequence.indexOf("mainReviewAgent"),
  );
  assert.match(serializedManifest, /metadata/i);
  assert.match(serializedManifest, /content[- ]?hash|contentHash/i);
  assert.match(serializedManifest, /session[- ]?memory/i);
  assert.equal(
    manifest.permissions.dataHandling.documentInterAgentPassing,
    "references-only",
  );

  assert.match(readme, /\$hoonsoo \/absolute\/path\/to\/design\.md/);
  assert.match(readme, /내용·구조와 문법·맞춤법을 한 번에 검토/);
  assert.match(readme, /metadata와 raw content hash/);
  assert.match(readme, /공백·탭·줄바꿈만 변경한 저장도/);
  assert.match(readme, /동일한 내용을 다시 저장한 경우에는.*LLM 호출/);
  assert.match(readme, /수동 Save 버튼과 에디터 autosave를 구분하지 못합니다/);
  assert.match(readme, /Agent 사이에는 문서 본문이나 diff 내용을 복사하지 않습니다/);
  assert.doesNotMatch(readme, /3초|settleMs|ignore-whitespace-only/);
  assert.doesNotMatch(readme, /\$hoonsoo context|\$hoonsoo grammar/);
});

test("Codex skill metadata keeps only Hoonsoo as a hard dependency", async () => {
  const metadata = await read("skills/hoonsoo/agents/openai.yaml");
  assert.equal((metadata.match(/^    - type: "mcp"$/gm) ?? []).length, 1);
  assert.match(metadata, /^      value: "hoonsoo"$/m);
  assert.match(metadata, /\$hoonsoo/);
  assert.match(metadata, /saved|save/i);
  assert.match(metadata, /content.*grammar|grammar.*content/is);
});
