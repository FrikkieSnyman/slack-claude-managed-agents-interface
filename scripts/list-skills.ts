import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
async function main() {
  const c = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  for await (const s of (c.beta as any).skills.list({ source: "custom" })) {
    console.log(`${s.id}\t${s.display_title}\tlatest=${s.latest_version}`);
  }
}
main();
