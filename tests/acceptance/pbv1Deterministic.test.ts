import { describe, expect, it } from "vitest";
import type { CanonicalMessage } from "../../src/api/canonical.js";
import { inferToolObligations, inspectCurrentToolCycle } from "../../src/tools/toolParser.js";
import { shouldRetry } from "../../src/deepseek/client.js";

const PB06_PROMPT = [
  "Создай файл pb06-current.txt с точным содержимым PB06-INITIAL.",
  "Затем измени PB06-INITIAL на PB06-EDITED в этом файле.",
  "Затем удали pb06-current.txt через Bash командой `rm pb06-current.txt`.",
  "После удаления проверь через Bash `test ! -e pb06-current.txt`, что pb06-current.txt отсутствует.",
  "Только после успешной проверки отсутствия ответь PB06-OK.",
].join("\n");

const PB06_LIVE_PROMPT = "Используя инструменты, создай файл pb06-live.txt с точным содержимым PB06-LIVE-INITIAL. Затем отредактируй этот файл, заменив PB06-LIVE-INITIAL на PB06-LIVE-FINAL. Затем удали этот файл через Bash командой `rm pb06-live.txt`. После удаления через Bash выполни `test ! -e pb06-live.txt`, чтобы проверить, что файл pb06-live.txt отсутствует. Только после успешного выполнения всех четырёх действий ответь ровно PB06-LIVE-PASS.";

const TOOLS = ["Write", "Edit", "Read", "Bash"];

function call(
  messages: CanonicalMessage[],
  id: string,
  name: string,
  argumentsValue: Record<string, unknown>,
  result: string,
  isError = false,
): void {
  messages.push({
    role: "assistant",
    parts: [{ type: "tool_use", toolCall: { id, type: "function", name, arguments: argumentsValue } }],
  });
  messages.push({
    role: "user",
    parts: [{ type: "tool_result", toolResult: { toolUseId: id, content: result, isError } }],
  });
}

function throughDelete(): CanonicalMessage[] {
  const messages: CanonicalMessage[] = [{ role: "user", parts: [{ type: "text", text: PB06_PROMPT }] }];
  call(messages, "pb06-write", "Write", {
    file_path: "pb06-current.txt",
    content: "PB06-INITIAL",
  }, "created pb06-current.txt");
  call(messages, "pb06-edit", "Edit", {
    file_path: "pb06-current.txt",
    old_string: "PB06-INITIAL",
    new_string: "PB06-EDITED",
  }, "updated pb06-current.txt");
  call(messages, "pb06-delete", "Bash", {
    command: "rm pb06-current.txt",
  }, "deleted pb06-current.txt");
  return messages;
}

describe("PB-v1 current-baseline deterministic acceptance", () => {
  it("PB06 exact live wording has no duplicate mutation or software-test obligation", () => {
    const obligations = inferToolObligations(PB06_LIVE_PROMPT, TOOLS);
    expect(obligations.filter(obligation => obligation.kind === "file_mutation"))
      .toHaveLength(3);
    expect(obligations.filter(obligation => obligation.kind === "file_verification"))
      .toEqual([expect.objectContaining({
        argumentLiterals: ["pb06-live.txt"],
        expectedFileState: "absent",
      })]);
    expect(obligations.some(obligation => obligation.kind === "test_execution")).toBe(false);
  });

  it("PB06 exact live chain reaches final only after fresh absence evidence", () => {
    const messages: CanonicalMessage[] = [{ role: "user", parts: [{ type: "text", text: PB06_LIVE_PROMPT }] }];
    call(messages, "live-write", "Write", {
      file_path: "C:\\pb06-fixture\\pb06-live.txt",
      content: "PB06-LIVE-INITIAL",
    }, "created");
    call(messages, "live-edit", "Edit", {
      file_path: "C:\\pb06-fixture\\pb06-live.txt",
      old_string: "PB06-LIVE-INITIAL",
      new_string: "PB06-LIVE-FINAL",
    }, "edited");
    call(messages, "live-delete", "Bash", {
      command: "rm pb06-live.txt",
      description: "Delete the requested file",
    }, "deleted");

    const afterDelete = inspectCurrentToolCycle(messages, TOOLS);
    expect(afterDelete.fulfilledObligationIds.filter(id => id.startsWith("file_mutation")))
      .toHaveLength(3);
    expect(afterDelete.missingObligations.map(obligation => obligation.kind))
      .toEqual(["file_verification"]);
    expect(shouldRetry(true, null, "PB06-LIVE-PASS", "", TOOLS, afterDelete)).toBe(true);

    call(messages, "live-absence", "Bash", {
      command: "test ! -e pb06-live.txt",
      description: "Verify the requested file is absent",
    }, "pb06-live.txt absent");
    const complete = inspectCurrentToolCycle(messages, TOOLS);
    expect(complete.missingObligations).toEqual([]);
    expect(complete.requiresActionToolResult).toBe(false);
    expect(shouldRetry(true, null, "PB06-LIVE-PASS", "", TOOLS, complete)).toBe(false);
  });

  it("PB06 retains create, edit, delete and final absence verification as distinct obligations", () => {
    const obligations = inferToolObligations(PB06_PROMPT, TOOLS);
    expect(obligations.filter(obligation => obligation.kind === "file_mutation")).toHaveLength(3);
    expect(obligations.filter(obligation => obligation.kind === "file_verification"))
      .toEqual([expect.objectContaining({
        argumentLiterals: ["pb06-current.txt"],
        expectedFileState: "absent",
      })]);
  });

  it("PB06 does not let one successful mutation satisfy unrelated mutation instances", () => {
    const messages: CanonicalMessage[] = [{ role: "user", parts: [{ type: "text", text: PB06_PROMPT }] }];
    call(messages, "pb06-write", "Write", {
      file_path: "pb06-current.txt",
      content: "PB06-INITIAL",
    }, "created pb06-current.txt");
    const evidence = inspectCurrentToolCycle(messages, TOOLS);
    expect(evidence.fulfilledObligationIds.filter(id => id.startsWith("file_mutation"))).toHaveLength(1);
    expect(evidence.missingObligations.filter(obligation => obligation.kind === "file_mutation")).toHaveLength(2);
  });

  it("PB06 keeps final verification missing after successful delete", () => {
    const evidence = inspectCurrentToolCycle(throughDelete(), TOOLS);
    expect(evidence.fulfilledObligationIds.filter(id => id.startsWith("file_mutation"))).toHaveLength(3);
    expect(evidence.missingObligations.some(obligation => obligation.kind === "file_verification")).toBe(true);
    expect(shouldRetry(true, null, "PB06-OK", "", TOOLS, evidence)).toBe(true);
  });

  it("PB06 accepts final only after a fresh successful target-matching absence predicate", () => {
    const messages = throughDelete();
    const before = inspectCurrentToolCycle(messages, TOOLS);
    expect(shouldRetry(true, {
      id: "pb06-absence-candidate",
      type: "function",
      name: "Bash",
      arguments: { command: "test ! -e pb06-current.txt" },
    }, "", "", TOOLS, before)).toBe(false);
    call(messages, "pb06-absence", "Bash", {
      command: "test ! -e pb06-current.txt",
    }, "pb06-current.txt absent");
    const evidence = inspectCurrentToolCycle(messages, TOOLS);
    expect(evidence.missingObligations).toEqual([]);
    expect(shouldRetry(true, null, "PB06-OK", "", TOOLS, evidence)).toBe(false);
  });

  it.each([
    ["wrong target", "test ! -e other-current.txt"],
    ["positive existence", "test -e pb06-current.txt"],
    ["arbitrary Bash", "echo pb06-current.txt"],
    ["chained absence command", "test ! -e pb06-current.txt && echo absent"],
  ])("PB06 rejects %s as final absence evidence", (_name, command) => {
    const messages = throughDelete();
    call(messages, `pb06-${_name}`, "Bash", { command }, "success");
    const evidence = inspectCurrentToolCycle(messages, TOOLS);
    expect(evidence.missingObligations)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        kind: "file_verification",
        expectedFileState: "absent",
      })]));
    expect(shouldRetry(true, null, "PB06-OK", "", TOOLS, evidence)).toBe(true);
  });

  it("PB06 supports an exact quoted Unicode target", () => {
    const prompt = [
      "Создай файл каталог/ёжик.txt.",
      "Затем удали каталог/ёжик.txt.",
      "После удаления проверь, что каталог/ёжик.txt отсутствует.",
    ].join("\n");
    const messages: CanonicalMessage[] = [{ role: "user", parts: [{ type: "text", text: prompt }] }];
    call(messages, "unicode-write", "Write", { file_path: "каталог/ёжик.txt", content: "x" }, "created");
    call(messages, "unicode-delete", "Bash", { command: "rm 'каталог/ёжик.txt'" }, "deleted");
    call(messages, "unicode-absence", "Bash", { command: "test ! -e 'каталог/ёжик.txt'" }, "absent");
    expect(inspectCurrentToolCycle(messages, TOOLS).missingObligations).toEqual([]);
  });

  it("PB06 rejects failed delete and failed absence evidence", () => {
    const failedDelete = throughDelete();
    failedDelete.at(-1)!.parts = [{
      type: "tool_result",
      toolResult: { toolUseId: "pb06-delete", content: "delete failed", isError: true },
    }];
    expect(inspectCurrentToolCycle(failedDelete, TOOLS).missingObligations)
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: "file_mutation" })]));

    const failedAbsence = throughDelete();
    call(failedAbsence, "pb06-absence-failed", "Bash", {
      command: "test ! -e pb06-current.txt",
    }, "predicate failed", true);
    expect(inspectCurrentToolCycle(failedAbsence, TOOLS).missingObligations)
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: "file_verification" })]));
  });

  it("PB06 rejects stale pre-delete verification and wrong correlation", () => {
    const messages: CanonicalMessage[] = [{ role: "user", parts: [{ type: "text", text: PB06_PROMPT }] }];
    call(messages, "pb06-write", "Write", {
      file_path: "pb06-current.txt",
      content: "PB06-INITIAL",
    }, "created pb06-current.txt");
    call(messages, "pb06-edit", "Edit", {
      file_path: "pb06-current.txt",
      old_string: "PB06-INITIAL",
      new_string: "PB06-EDITED",
    }, "updated pb06-current.txt");
    call(messages, "pb06-read-before-delete", "Read", {
      file_path: "pb06-current.txt",
    }, "PB06-EDITED");
    call(messages, "pb06-delete", "Bash", {
      command: "rm pb06-current.txt",
    }, "deleted pb06-current.txt");
    messages.push({
      role: "user",
      parts: [{ type: "tool_result", toolResult: { toolUseId: "unknown-call", content: "absent", isError: false } }],
    });
    const evidence = inspectCurrentToolCycle(messages, TOOLS);
    expect(evidence.missingObligations.some(obligation => obligation.kind === "file_verification")).toBe(true);
    expect(shouldRetry(true, null, "PB06-OK", "", TOOLS, evidence)).toBe(true);
  });
});
