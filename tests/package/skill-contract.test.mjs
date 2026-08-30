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

test("skill contract uses event-driven idle handling and natural-language advice", async () => {
  const skill = await read("skills/hoonsoo/SKILL.md");

  assert.match(skill, /\{n\} 번째 훈수 :/);
  assert.match(skill, /revision: \{revision\}/);
  assert.match(
    skill,
    /1분 간, 작업이 감지되지 않습니다\. 추가 30초 대기 후, 훈수모드가 정지됩니다\./,
  );
  assert.match(skill, /During normal monitoring omit `timeoutMs`/);
  assert.match(skill, /pendingMeaningfulChange/);
  assert.match(skill, /gpt-5\.6-sol/);
  assert.match(skill, /`fable` alias/);
  assert.match(skill, /Reference-only delegation/);
  assert.match(skill, /changedRanges/);
  assert.doesNotMatch(skill, /timeoutMs\s*=\s*50000/);
  assert.doesNotMatch(skill, /Send only a brief heartbeat/);
  assert.doesNotMatch(skill, /- revision: <integer>/);
});

test("Claude Advisor is read-only, path-based, and requests the flagship alias", async () => {
  const advisor = await read("agents/hoonsoo-advisor.md");

  assert.match(advisor, /^---\nname: hoonsoo-advisor/m);
  assert.match(advisor, /^model: fable$/m);
  assert.match(advisor, /^effort: high$/m);
  assert.match(advisor, /^disallowedTools: Write, Edit, NotebookEdit$/m);
  assert.match(advisor, /Read the referenced file yourself/);
  assert.match(advisor, /Never edit, patch, format, create, rename, or delete files/);
});

test("documentation and design reference describe the runtime policy", async () => {
  const readme = await read("README.md");
  const manifest = JSON.parse(await read("examples/hoonsoo.manifest.json"));
  JSON.parse(await read("schemas/hoonsoo.manifest.schema.json"));

  assert.match(readme, /공백·탭·줄바꿈만 바뀐 저장/);
  assert.match(readme, /1분간 실제 내용 변경이 없으면 안내하고, 추가 30초 뒤 자동 종료/);
  assert.match(readme, /timeout 없는 event-driven local wait/);
  assert.match(readme, /Agent 사이에는 문서 본문을 복사하지 않습니다/);

  assert.equal(manifest.schemaVersion, "0.2.0");
  assert.equal(manifest.watch.settleMs, 3_000);
  assert.equal(manifest.watch.meaningfulChangePolicy, "ignore-whitespace-only");
  assert.equal(manifest.watch.idleWarningMs, 60_000);
  assert.equal(manifest.watch.idleStopMs, 90_000);
  assert.equal(manifest.agents.idleGuard.implementation, "deterministic-worker");
  assert.equal(manifest.agents.revisionGate.implementation, "deterministic-worker");
  assert.equal(manifest.agents.fieldChecker.implementation, "deterministic-worker");
  assert.equal(manifest.agents.adviceAdvisor.modelClass, "capable");
  assert.equal(manifest.agents.mainReviewer.modelClass, "fast");
  assert.equal(manifest.output.advice.presentation, "natural-language");
  assert.equal(manifest.permissions.dataHandling.interAgentContentPassing, "references-only");
  assert.equal(
    manifest.extensions["hoonsoo.model-routing"].hostProfiles.codex.advisor,
    "gpt-5.6-sol",
  );
  assert.equal(
    manifest.extensions["hoonsoo.model-routing"].hostProfiles["claude-code"].advisor,
    "fable",
  );
});

test("Codex skill metadata keeps only the Hoonsoo MCP as a hard dependency", async () => {
  const metadata = await read("skills/hoonsoo/agents/openai.yaml");
  assert.equal((metadata.match(/^    - type: "mcp"$/gm) ?? []).length, 1);
  assert.match(metadata, /^      value: "hoonsoo"$/m);
  assert.match(metadata, /numbered natural-language advice/);
});
