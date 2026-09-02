import { copyFile, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(currentDirectory, "..");
const packageDirectory = path.join(projectDirectory, "plugins", "skill-sherpa");

const packagedFiles = [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "claude.mcp.json",
  "scripts/sherpa-mcp.mjs",
  "skills/sherpa/SKILL.md",
  "skills/sherpa/agents/openai.yaml",
].sort();

async function assertRegularFile(filePath, label) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
}

async function listRegularFiles(directory, relativeDirectory = "") {
  const absoluteDirectory = path.join(directory, relativeDirectory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Symlinks are not allowed in the packaged plugin: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await listRegularFiles(directory, relativePath)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Special files are not allowed in the packaged plugin: ${relativePath}`);
    }
    files.push(relativePath);
  }

  return files.sort();
}

async function syncPackage() {
  await mkdir(packageDirectory, { recursive: true });

  for (const relativePath of packagedFiles) {
    const source = path.join(projectDirectory, relativePath);
    const destination = path.join(packageDirectory, relativePath);
    await assertRegularFile(source, "Package source");
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }

  const actualFiles = await listRegularFiles(packageDirectory);
  const unexpectedFiles = actualFiles.filter((file) => !packagedFiles.includes(file));
  if (unexpectedFiles.length > 0) {
    throw new Error(
      `Unexpected files already exist in the package; remove them explicitly: ${unexpectedFiles.join(", ")}`,
    );
  }

  console.log(`Packaged ${packagedFiles.length} files in ${packageDirectory}`);
}

async function checkPackage() {
  const actualFiles = await listRegularFiles(packageDirectory);
  if (JSON.stringify(actualFiles) !== JSON.stringify(packagedFiles)) {
    throw new Error(
      `Packaged file set is out of sync.\nExpected: ${packagedFiles.join(", ")}\nActual: ${actualFiles.join(", ")}`,
    );
  }

  for (const relativePath of packagedFiles) {
    const source = path.join(projectDirectory, relativePath);
    const destination = path.join(packageDirectory, relativePath);
    await assertRegularFile(source, "Package source");
    await assertRegularFile(destination, "Packaged file");
    const [sourceContent, destinationContent] = await Promise.all([
      readFile(source),
      readFile(destination),
    ]);
    if (!sourceContent.equals(destinationContent)) {
      throw new Error(`Packaged file differs from its source: ${relativePath}`);
    }
  }

  console.log(`Package is synchronized (${packagedFiles.length} files)`);
}

const argumentsList = process.argv.slice(2);
if (argumentsList.length === 0) {
  await syncPackage();
} else if (argumentsList.length === 1 && argumentsList[0] === "--check") {
  await checkPackage();
} else {
  throw new Error("Usage: node tools/package-plugin.mjs [--check]");
}
