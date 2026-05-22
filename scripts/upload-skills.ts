import "dotenv/config";
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { createReadStream, readdirSync, statSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";

interface SkillSource {
  displayTitle: string;
  repo: string;
  subPath: string;
}

const SKILLS: SkillSource[] = [
  { displayTitle: "Brainstorming", repo: "obra/superpowers", subPath: "skills/brainstorming" },
  { displayTitle: "Frontend Design", repo: "anthropics/skills", subPath: "skills/frontend-design" },
  { displayTitle: "Vercel React Best Practices", repo: "vercel-labs/agent-skills", subPath: "skills/react-best-practices" },
  { displayTitle: "Vercel Composition Patterns", repo: "vercel-labs/agent-skills", subPath: "skills/composition-patterns" },
];

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
  for await (const s of (client.beta as never as { skills: { list: (p: { source: string }) => AsyncIterable<{ id: string; display_title: string }> } }).skills.list({ source: "custom" })) {
    map.set(s.display_title, s.id);
  }
  return map;
}

async function uploadSkill(client: Anthropic, source: SkillSource, skillDir: string): Promise<{ id: string; latest_version: string }> {
  const skillName = readSkillName(join(skillDir, "SKILL.md"));
  const files = walk(skillDir);
  const uploads = await Promise.all(
    files.map((abs) => toFile(createReadStream(abs), `${skillName}/${relative(skillDir, abs)}`)),
  );
  const created = await (client.beta as never as { skills: { create: (p: unknown) => Promise<{ id: string; latest_version: string }> } }).skills.create({
    display_title: source.displayTitle,
    files: uploads,
  });
  return created;
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");
  const client = new Anthropic({ apiKey });

  console.log("Listing existing skills…");
  const existing = await listExistingTitles(client);

  const tmp = mkdtempSync(join(tmpdir(), "cma-skills-"));
  try {
    const todo = SKILLS.filter((s) => !existing.has(s.displayTitle));
    if (todo.length === 0) {
      console.log("All skills already uploaded.");
    } else {
      const repos = Array.from(new Set(todo.map((s) => s.repo)));
      for (const repo of repos) {
        const target = join(tmp, repo.replace("/", "-"));
        console.log(`Cloning ${repo}…`);
        execSync(`git clone --depth 1 https://github.com/${repo}.git ${target}`, { stdio: "inherit" });
      }

      for (const skill of todo) {
        const skillDir = join(tmp, skill.repo.replace("/", "-"), skill.subPath);
        const fileCount = walk(skillDir).length;
        console.log(`Uploading ${skill.displayTitle} (${fileCount} files)…`);
        const uploaded = await uploadSkill(client, skill, skillDir);
        console.log(`  → ${uploaded.id} (version ${uploaded.latest_version})`);
        existing.set(skill.displayTitle, uploaded.id);
      }
    }

    console.log("\nAll skills (attach these to your CMA agent):");
    for (const s of SKILLS) {
      const id = existing.get(s.displayTitle);
      console.log(`  ${s.displayTitle}: ${id ?? "(missing)"}`);
    }
    console.log("\nAttach by setting agent.skills entries like:");
    console.log(`  { "type": "custom", "skill_id": "skill_…", "version": "latest" }`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
