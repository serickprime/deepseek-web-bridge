import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { launchProcess } from "../../src/server/actions.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.promises.rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })));
});

describe("launchProcess Unicode cwd integration", () => {
  it("starts a real child process with the exact Unicode working directory", async () => {
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bridge-launch-Тестовая папка ёжик-"));
    tempDirs.push(cwd);
    const probeFile = path.join(cwd, "cwd-probe.cjs");
    const resultFile = path.join(cwd, "cwd-check.txt");
    await fs.promises.writeFile(
      probeFile,
      'require("node:fs").writeFileSync("cwd-check.txt", process.cwd(), "utf8");\n',
      "utf8",
    );

    const events: string[] = [];
    const child = launchProcess("node", [path.basename(probeFile)], cwd, event => {
      if (event.message) events.push(event.message);
    });

    expect(child).not.toBeNull();
    const childClosed = new Promise<void>(resolve => {
      child!.once("close", () => resolve());
      child!.once("error", () => resolve());
    });
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(resultFile) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    const reportedCwd = await fs.promises.readFile(resultFile, "utf8");
    expect(await fs.promises.realpath(reportedCwd)).toBe(await fs.promises.realpath(cwd));
    expect(path.basename(reportedCwd)).toBe(path.basename(cwd));
    expect(events).toContain(`Working directory: ${cwd}`);
    await Promise.race([
      childClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("child did not exit")), 10_000)),
    ]);
  });
});
