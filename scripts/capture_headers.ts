import { CdpConnection, createPage, launchChrome, waitForDebugger } from "../scripts/cdp.js";
import fs from "node:fs";

const CDP_PORT = 9222;

async function main() {
  const child = launchChrome({
    profileDir: "D:\\Проекты\\test router deepseek\\data\\chrome-profile",
    remoteDebugPort: CDP_PORT,
  });
  process.on("exit", () => { child.kill(); });

  await waitForDebugger(CDP_PORT, 20_000);
  const debugUrl = await createPage(CDP_PORT);
  const conn = await CdpConnection.connect(debugUrl);

  await conn.send("Page.enable");
  await conn.send("Network.enable");
  await conn.send("Fetch.enable", {
    patterns: [{ urlPattern: "*://chat.deepseek.com/api/v0/chat/completion" }],
  });

  const allHeaders: Record<string, string> = {};
  const allCookies: Array<{ name: string; value: string }> = [];

  conn.on("Fetch.requestPaused", (params) => {
    const req = params.request as { url?: string; headers?: Record<string, string> } | undefined;
    const requestId = params.requestId as string;
    conn.send("Fetch.continueRequest", { requestId }).catch(() => {});

    if (req?.url?.includes("chat/completion") && req?.headers) {
      console.log("\n=== CAPTURED COMPLETION REQUEST HEADERS ===");
      for (const [k, v] of Object.entries(req.headers)) {
        allHeaders[k] = v;
        console.log(`  ${k}: ${v}`);
      }
    }
  });

  await conn.send("Page.navigate", { url: "https://chat.deepseek.com" });

  console.log("");
  console.log("======================================================================");
  console.log("  Log in to chat.deepseek.com and send a message.");
  console.log("  The script will capture ALL headers from the completion request.");
  console.log("  Waiting up to 5 minutes...");
  console.log("======================================================================");

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    if (Object.keys(allHeaders).length > 0) {
      await new Promise(r => setTimeout(r, 2000));

      // Get cookies from jar
      const cookieResult = await conn.send("Network.getCookies", { urls: ["https://chat.deepseek.com"] });
      const cookies = cookieResult.cookies as Array<{ name: string; value: string }> || [];
      console.log("\n=== BROWSER COOKIE JAR ===");
      for (const c of cookies) {
        console.log(`  ${c.name}=${c.value.slice(0, 40)}... (${c.value.length} chars)`);
      }

      // Write captured data to file
      const data = {
        headers: allHeaders,
        cookies: cookies.map(c => ({ name: c.name, value: c.value })),
        cookieString: cookies.map(c => `${c.name}=${c.value}`).join("; "),
      };
      fs.writeFileSync("D:\\Проекты\\test router deepseek\\data\\captured_headers.json", JSON.stringify(data, null, 2));
      console.log("\nSaved to data/captured_headers.json");
      break;
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  conn.close();
  child.kill();
}

main().catch(e => { console.error(e.message); process.exit(1); });
