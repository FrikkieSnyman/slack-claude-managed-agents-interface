import "dotenv/config";
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { createReadStream, readdirSync, statSync, mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, relative, resolve, isAbsolute, dirname } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";

type SkillSource =
  | { type: "github"; repo: string; path: string; ref?: string }
  | { type: "local"; path: string };

interface SkillEntry {
  displayTitle: string;
  source: SkillSource;
}

interface SkillsConfig {
  skills: SkillEntry[];
}

function parseConfig(raw: unknown, configPath: string): SkillsConfig {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { skills?: unknown }).skills)) {
    throw new Error(`${configPath}: expected an object with a "skills" array`);
  }
  const skills = (raw as { skills: unknown[] }).skills.map((entry, i): SkillEntry => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`${configPath}: skills[${i}] is not an object`);
    }
    const e = entry as { displayTitle?: unknown; source?: unknown };
    if (typeof e.displayTitle !== "string" || !e.displayTitle.trim()) {
      throw new Error(`${configPath}: skills[${i}].displayTitle must be a non-empty string`);
    }
    if (!e.source || typeof e.source !== "object") {
      throw new Error(`${configPath}: skills[${i}].source must be an object`);
    }
    const s = e.source as { type?: unknown; repo?: unknown; path?: unknown; ref?: unknown };
    if (s.type === "github") {
      if (typeof s.repo !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(s.repo)) {
        throw new Error(`${configPath}: skills[${i}].source.repo must be "owner/repo"`);
      }
      if (typeof s.path !== "string" || !s.path) {
        throw new Error(`${configPath}: skills[${i}].source.path is required for github sources`);
      }
      const out: SkillSource = { type: "github", repo: s.repo, path: s.path };
      if (typeof s.ref === "string" && s.ref) out.ref = s.ref;
      return { displayTitle: e.displayTitle, source: out };
    }
    if (s.type === "local") {
      if (typeof s.path !== "string" || !s.path) {
        throw new Error(`${configPath}: skills[${i}].source.path is required for local sources`);
      }
      return { displayTitle: e.displayTitle, source: { type: "local", path: s.path } };
    }
    throw new Error(`${configPath}: skills[${i}].source.type must be "github" or "local"`);
  });
  return { skills };
}

function loadConfigFromCli(): { config: SkillsConfig; configDir: string; configPath: string } {
  const args = process.argv.slice(2);
  let configPath = "skills.config.json";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" || args[i] === "-c") {
      const next = args[i + 1];
      if (!next) throw new Error("--config requires a path argument");
      configPath = next;
      i++;
    }
  }
  const abs = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath);
  if (!existsSync(abs)) {
    throw new Error(`Config file not found: ${abs}`);
  }
  const raw = JSON.parse(readFileSync(abs, "utf-8")) as unknown;
  return { config: parseConfig(raw, abs), configDir: dirname(abs), configPath: abs };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    out.push(...(statSync(abs).isDirectory() ? walk(abs) : [abs]));
  }
  return out;
}

function readSkillName(skillMdPath: string): string {
  const content = readFileSync(skillMdPath, "utf-8");
  const fm = /^---\s*\n([\s\S]*?)\n---/m.exec(content);
  if (!fm) throw new Error(`No YAML frontmatter in ${skillMdPath}`);
  const m = /^name:\s*(.+)$/m.exec(fm[1]!);
  if (!m) throw new Error(`No name: field in ${skillMdPath}`);
  return m[1]!.trim();
}

async function listExistingTitles(client: Anthropic): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  type SkillsApi = { skills: { list: (p: { source: string }) => AsyncIterable<{ id: string; display_title: string }> } };
  for await (const s of (client.beta as never as SkillsApi).skills.list({ source: "custom" })) {
    map.set(s.display_title, s.id);
  }
  return map;
}

function resolveSourceDir(entry: SkillEntry, cloneRoot: string, configDir: string): string {
  if (entry.source.type === "local") {
    return isAbsolute(entry.source.path) ? entry.source.path : resolve(configDir, entry.source.path);
  }
  return join(cloneRoot, entry.source.repo.replace("/", "-"), entry.source.path);
}

async function uploadSkill(client: Anthropic, entry: SkillEntry, skillDir: string): Promise<{ id: string; latest_version: string }> {
  const skillMd = join(skillDir, "SKILL.md");
  if (!existsSync(skillMd)) throw new Error(`SKILL.md missing in ${skillDir}`);
  const skillName = readSkillName(skillMd);
  const files = walk(skillDir);
  const uploads = await Promise.all(
    files.map((abs) => toFile(createReadStream(abs), `${skillName}/${relative(skillDir, abs)}`)),
  );
  type SkillsCreate = { skills: { create: (p: unknown) => Promise<{ id: string; latest_version: string }> } };
  return (client.beta as never as SkillsCreate).skills.create({
    display_title: entry.displayTitle,
    files: uploads,
  });
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");
  const client = new Anthropic({ apiKey });

  const { config, configDir, configPath } = loadConfigFromCli();
  console.log(`Loaded ${config.skills.length} skills from ${configPath}`);

  console.log("Listing existing skills…");
  const existing = await listExistingTitles(client);

  const tmp = mkdtempSync(join(tmpdir(), "cma-skills-"));
  try {
    const todo = config.skills.filter((s) => !existing.has(s.displayTitle));
    if (todo.length === 0) {
      console.log("All skills already uploaded.");
    } else {
      const reposToClone = new Map<string, string | undefined>();
      for (const s of todo) {
        if (s.source.type === "github") reposToClone.set(s.source.repo, s.source.ref);
      }
      for (const [repo, ref] of reposToClone) {
        const target = join(tmp, repo.replace("/", "-"));
        const refSuffix = ref ? ` (ref ${ref})` : "";
        console.log(`Cloning ${repo}${refSuffix}…`);
        const refArg = ref ? `--branch ${ref}` : "";
        execSync(`git clone --depth 1 ${refArg} https://github.com/${repo}.git ${target}`, { stdio: "inherit" });
      }

      for (const entry of todo) {
        const skillDir = resolveSourceDir(entry, tmp, configDir);
        if (!existsSync(skillDir)) throw new Error(`Skill directory not found: ${skillDir}`);
        const fileCount = walk(skillDir).length;
        console.log(`Uploading ${entry.displayTitle} (${fileCount} files)…`);
        const uploaded = await uploadSkill(client, entry, skillDir);
        console.log(`  → ${uploaded.id} (version ${uploaded.latest_version})`);
        existing.set(entry.displayTitle, uploaded.id);
      }
    }

    console.log("\nAll configured skills:");
    for (const s of config.skills) {
      console.log(`  ${s.displayTitle}: ${existing.get(s.displayTitle) ?? "(missing)"}`);
    }
    console.log("\nAttach by adding entries like the following to your CMA agent's `skills` array:");
    console.log(`  { "type": "custom", "skill_id": "skill_…", "version": "latest" }`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
