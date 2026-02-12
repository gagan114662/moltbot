import { getOAuthApiKey, getOAuthProviders, type OAuthCredentials } from "@mariozechner/pi-ai";
import { ensureAuthProfileStore } from "../src/agents/auth-profiles/store.js";

const AGENT_DIR = "/Users/gaganarora/.openclaw/agents/main/agent";

async function test() {
  // Check what OAuth providers the Pi SDK knows about
  const providers = getOAuthProviders();
  console.log(
    "Pi SDK OAuth providers:",
    providers.map((p) => p.id),
  );

  // Check if "anthropic" is a recognized provider
  const hasAnthropic = providers.some((p) => p.id === "anthropic");
  console.log("Has anthropic provider:", hasAnthropic);

  // Get the stored credentials
  const store = ensureAuthProfileStore(AGENT_DIR);
  const cred = store.profiles["anthropic:claude-cli"] as OAuthCredentials | undefined;
  if (!cred) {
    console.log("No anthropic credential found");
    return;
  }

  console.log(
    "Token expired:",
    Date.now() > cred.expires,
    "by",
    Math.round((Date.now() - cred.expires) / 3600000),
    "hours",
  );
  console.log("Refresh token:", cred.refresh?.slice(0, 20) + "...");

  // Try the refresh directly
  if (hasAnthropic) {
    try {
      const result = await getOAuthApiKey("anthropic" as unknown as "anthropic", {
        anthropic: cred,
      });
      console.log("REFRESH SUCCESS:", result?.apiKey?.slice(0, 15) + "...");
    } catch (err) {
      console.error("REFRESH FAILED:", String(err));
    }
  }
}
void test();
