import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface PbEvidence {
  id: string;
  expected: string;
  forbidden: string;
  file: string;
  testName: string;
}

export const PB_V1_DETERMINISTIC_EVIDENCE: PbEvidence[] = [
  { id: "PB01", expected: "Fresh cwd evidence", forbidden: "Invented cwd", file: "tests/unit/tools.test.ts", testName: "rejects a plausible correct cwd when no real tool_result exists" },
  { id: "PB02", expected: "Fresh concrete directory listing", forbidden: "Fabricated listing", file: "tests/unit/tools.test.ts", testName: "rejects fabricated plain listing for %s: %s" },
  { id: "PB03", expected: "Listing-capable tool supplies real structure", forbidden: "Generic prose structure", file: "tests/unit/tools.test.ts", testName: "accepts a real %s call for the exact typo request" },
  { id: "PB04", expected: "File existence requires tool evidence", forbidden: "Fabricated existence", file: "tests/unit/tools.test.ts", testName: "requires live evidence for checking file existence" },
  { id: "PB05", expected: "Informational directory question remains tool-free", forbidden: "Unnecessary tool requirement", file: "tests/unit/tools.test.ts", testName: "keeps informational or unrelated text tool-free: %s" },
  { id: "PB06", expected: "Create, edit, delete, then fresh absence proof", forbidden: "Skipped step or failed evidence", file: "tests/acceptance/pbv1Deterministic.test.ts", testName: "PB06 accepts final only after a fresh successful target-matching absence predicate" },
  { id: "PB07", expected: "Independent evidence for 2–5 targets", forbidden: "One result closes several targets", file: "tests/unit/tools.test.ts", testName: "keeps %i independent create target(s)" },
  { id: "PB08", expected: "Same-file additive values receive fresh verification", forbidden: "Destructive rewrite or stale Read", file: "tests/unit/tools.test.ts", testName: "synthesizes a final-state verification for two sequential clauses" },
  { id: "PB09", expected: "Same-kind obligations bind one-to-one", forbidden: "Evidence reuse across instances", file: "tests/unit/tools.test.ts", testName: "binds one evidence to a single same-kind instance only" },
  { id: "PB10", expected: "Changed recovery action may proceed", forbidden: "Identical failed replay", file: "tests/unit/tools.test.ts", testName: "blocks an identical failed Bash call with reordered JSON keys" },
  { id: "PB11", expected: "Real test pass/fail output is classified", forbidden: "Version probe or failed suite accepted", file: "tests/unit/tools.test.ts", testName: "does not fulfill test execution when a successful transport contains failed Jest output" },
  { id: "PB12", expected: "Fresh server verification follows launch", forbidden: "Launch alone proves health", file: "tests/unit/tools.test.ts", testName: "requires a new health result after a server restart" },
  { id: "PB13", expected: "Later mutation makes prior verification stale", forbidden: "Historical verification accepted", file: "tests/unit/tools.test.ts", testName: "keeps a successful read stale after a later mutation of that target" },
  { id: "PB14", expected: "Full nested schema and system blocks survive", forbidden: "Dropped schema/system content", file: "tests/unit/toolSchemaTransport.test.ts", testName: "preserves nested object requirements, descriptions, and additionalProperties" },
  { id: "PB15", expected: "Malformed call receives bounded canonical repair", forbidden: "Raw malformed syntax exposed", file: "tests/unit/tools.test.ts", testName: "retries malformed Edit JSON and returns the corrected call as tool_use" },
  { id: "PB16", expected: "Pseudo-XML is boundedly rejected/repaired", forbidden: "Pseudo-XML execution or final leak", file: "tests/unit/tools.test.ts", testName: "blocks executable pseudo-xml shapes without a wrapper" },
  { id: "PB17", expected: "Reasoning tool call receives normal schema validation", forbidden: "Reasoning leak or unvalidated call", file: "tests/unit/toolSchemaTransport.test.ts", testName: "PB17 keeps the full schema catalog when a valid tool call is selected from reasoning" },
  { id: "PB18", expected: "All advertised tools described; unknown rejected", forbidden: "Allowlist/catalog mismatch", file: "tests/unit/toolCatalogConsistency.test.ts", testName: "continues to reject an unknown tool" },
  { id: "PB19", expected: "Only correlated current result is selected", forbidden: "Orphan result linked", file: "tests/unit/lineageFreshness.test.ts", testName: "ignores an orphan result inside the current action cycle" },
  { id: "PB20", expected: "Sequential mixed tools retain evidence and order", forbidden: "Missing or replayed action", file: "tests/unit/tools.test.ts", testName: "completes a sequential Bash → Write → Read → tests → launch → fresh verify flow without blocking the final" },
  { id: "PB21", expected: "Failed evidence remains failed and recovery bounded", forbidden: "Failed result counted as success", file: "tests/unit/tools.test.ts", testName: "forbids a success final after a failed Bash result" },
  { id: "PB22", expected: "FINISHED assembles successful content", forbidden: "Truncated or fake terminal success", file: "tests/unit/deepseekStreamLifecycle.test.ts", testName: "T1: new FINISHED succeeds without waiting for EOF" },
  { id: "PB23", expected: "Upstream 502 is typed and attempted once", forbidden: "Empty/fake success or guard retry", file: "tests/unit/deepseekStreamLifecycle.test.ts", testName: "T11: HTTP %i is typed and attempted once" },
  { id: "PB24", expected: "Rate-limit hint becomes typed 429", forbidden: "Guard storm or empty completion", file: "tests/unit/deepseekRateLimit.test.ts", testName: "throws one retryable upstream rate-limit error without completion-guard retries" },
  { id: "PB25", expected: "Zero-byte HTTP 200 is incomplete", forbidden: "Empty successful final", file: "tests/unit/deepseekStreamLifecycle.test.ts", testName: "T3: zero-byte HTTP 200 is STREAM_INCOMPLETE" },
  { id: "PB26", expected: "Partial/INCOMPLETE response rejects", forbidden: "Partial final or parent advancement", file: "tests/unit/deepseekStreamLifecycle.test.ts", testName: "T5: explicit INCOMPLETE is a typed failure" },
  { id: "PB27", expected: "Stalled body aborts within deadline", forbidden: "Hang or background continuation", file: "tests/unit/deepseekStreamLifecycle.test.ts", testName: "T6: a stalled body is bounded and aborts and cancels" },
  { id: "PB28", expected: "Started Anthropic stream ends with one valid error terminal", forbidden: "Truncation, hang, or double terminal", file: "tests/unit/anthropicStreamErrorLifecycle.test.ts", testName: "T20: response closes boundedly after event:error" },
  { id: "PB29", expected: "Accepted parent advances once", forbidden: "Fresh session or skipped parent", file: "tests/unit/deepseekParentIsolation.test.ts", testName: "PB29: commits a normal accepted candidate 77 -> 1001" },
  { id: "PB30", expected: "Rejected candidate parents remain isolated", forbidden: "Rejected parent persisted/reused", file: "tests/unit/deepseekParentIsolation.test.ts", testName: "PB30: chains a rejected candidate locally and commits only the accepted retry" },
  { id: "PB31", expected: "Sessions and lineage survive restart", forbidden: "Lost sibling persistence state", file: "tests/unit/persistentSessionDocument.test.ts", testName: "T4: new owner and store instances restore sessions and lineage" },
  { id: "PB32", expected: "Newest fresh correlated result wins", forbidden: "Expired or stale result selected", file: "tests/unit/lineageFreshness.test.ts", testName: "PB32 selects the newest of two correlated current results" },
  { id: "PB33", expected: "Interleaved writers retain combined durable state", forbidden: "Lost sessions/links or invalid JSON", file: "tests/unit/persistentSessionDocument.test.ts", testName: "T3: interleaved session and lineage writes retain every field" },
  { id: "PB39", expected: "Tracked process terminates; untracked survives", forbidden: "Orphan tracked or broad kill", file: "tests/unit/nativeCliLaunch.test.ts", testName: "SHUTDOWN tracking stops only the terminal child created by Bridge" },
];

const REQUIRED_IDS = [
  ...Array.from({ length: 33 }, (_, index) => `PB${String(index + 1).padStart(2, "0")}`),
  "PB39",
];

describe("G8 current-baseline PB-v1 deterministic mapping", () => {
  it("accounts for PB01-PB33 and offline PB39 exactly once", () => {
    const ids = PB_V1_DETERMINISTIC_EVIDENCE.map(entry => entry.id);
    expect(ids).toHaveLength(34);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...REQUIRED_IDS].sort());
  });

  it.each(PB_V1_DETERMINISTIC_EVIDENCE)("$id maps to current executable evidence", entry => {
    const path = resolve(entry.file);
    expect(existsSync(path), entry.file).toBe(true);
    const source = readFileSync(path, "utf8");
    expect(source, `${entry.id}: ${entry.testName}`).toContain(entry.testName);
    expect(entry.expected.trim().length).toBeGreaterThan(0);
    expect(entry.forbidden.trim().length).toBeGreaterThan(0);
  });
});
