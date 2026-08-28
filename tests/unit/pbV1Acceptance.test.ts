import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface CoverageReference {
  file: string;
  anchors: string[];
}

interface PbCoverage {
  id: `PB${number}`;
  references: CoverageReference[];
}

const coverage: PbCoverage[] = [
  { id: "PB07", references: [{ file: "tests/unit/tools.test.ts", anchors: ["D13 multi-target obligation fidelity", "keeps %i independent create target(s)"] }] },
  { id: "PB08", references: [{ file: "tests/unit/tools.test.ts", anchors: ["D19 semantic tool admission", "marks Read evidence stale after a later mutation"] }] },
  { id: "PB09", references: [{ file: "tests/unit/tools.test.ts", anchors: ["multiple obligation instances per kind", "binds one evidence to a single same-kind instance only"] }] },
  { id: "PB10", references: [{ file: "tests/unit/tools.test.ts", anchors: ["repeated failed tool call evidence", "blocks an identical failed Bash call with reordered JSON keys", "allows changed arguments after a failure"] }] },
  { id: "PB11", references: [{ file: "tests/unit/tools.test.ts", anchors: ["does not treat a Jest version probe as test execution", "does not fulfill test execution when a successful transport contains failed Jest output"] }] },
  { id: "PB12", references: [{ file: "tests/unit/tools.test.ts", anchors: ["requires a new health result after a server restart", "completes a sequential Bash → Write → Read → tests → launch → fresh verify flow without blocking the final"] }] },
  { id: "PB13", references: [{ file: "tests/unit/tools.test.ts", anchors: ["keeps stale verification blocking until fresh evidence arrives", "does not use a historical successful result as current action evidence"] }] },
  { id: "PB14", references: [
    { file: "tests/unit/toolSchemaTransport.test.ts", anchors: ["preserves root type, required, property types, and enums", "preserves nested object requirements, descriptions, and additionalProperties"] },
    { file: "tests/unit/normalize.test.ts", anchors: ["joins top-level system text blocks in order with one newline", "preserves internal whitespace and newlines in every system block"] },
    { file: "tests/unit/tools.test.ts", anchors: ["D12 nested array tool arguments", "CompletionHandler exposes exact arrays as Anthropic tool_use"] },
  ] },
  { id: "PB15", references: [{ file: "tests/unit/tools.test.ts", anchors: ["retries malformed Edit JSON and returns the corrected call as tool_use", "never leaks malformed raw tool JSON after bounded retries"] }] },
  { id: "PB16", references: [{ file: "tests/unit/tools.test.ts", anchors: ["pseudo-xml tool intent leakage", "blocks executable pseudo-xml shapes without a wrapper"] }] },
  { id: "PB17", references: [{ file: "tests/unit/toolSchemaTransport.test.ts", anchors: ["PB17 keeps the full schema catalog when a valid tool call is selected from reasoning"] }] },
  { id: "PB18", references: [{ file: "tests/unit/toolCatalogConsistency.test.ts", anchors: ["describes tools beyond the former 32-tool boundary", "continues to reject an unknown tool"] }] },
  { id: "PB19", references: [
    { file: "tests/unit/tools.test.ts", anchors: ["tool_result name correlation (buildToolUseIdMap)", "unknown id returns fallback"] },
    { file: "tests/unit/lineageFreshness.test.ts", anchors: ["ignores an orphan result inside the current action cycle"] },
  ] },
  { id: "PB20", references: [
    { file: "tests/unit/tools.test.ts", anchors: ["completes a sequential Bash → Write → Read → tests → launch → fresh verify flow without blocking the final"] },
    { file: "tests/unit/observabilityCorrelation.test.ts", anchors: ["correlates selected/exposed tool and its linked tool_result using call_ref only"] },
  ] },
  { id: "PB21", references: [{ file: "tests/unit/tools.test.ts", anchors: ["bounds identical failed tool retries without returning them to the client", "allows a different tool after a failed Bash call"] }] },
  { id: "PB22", references: [
    { file: "tests/unit/deepseekStreamLifecycle.test.ts", anchors: ["T1: new FINISHED succeeds without waiting for EOF", "T21: old-format content, parent, and usage extraction remains compatible"] },
    { file: "tests/unit/sse.test.ts", anchors: ["D15b Anthropic streaming usage", "omits terminal usage when exact completion usage is unavailable"] },
  ] },
  { id: "PB23", references: [{ file: "tests/unit/deepseekStreamLifecycle.test.ts", anchors: ["T11: HTTP %i is typed and attempted once"] }] },
  { id: "PB24", references: [{ file: "tests/unit/deepseekRateLimit.test.ts", anchors: ["recognizes the explicit rate_limit_reached hint", "throws one retryable upstream rate-limit error without completion-guard retries"] }] },
  { id: "PB25", references: [{ file: "tests/unit/deepseekStreamLifecycle.test.ts", anchors: ["T3: zero-byte HTTP 200 is STREAM_INCOMPLETE"] }] },
  { id: "PB26", references: [
    { file: "tests/unit/deepseekStreamLifecycle.test.ts", anchors: ["T4: partial content followed by EOF is STREAM_INCOMPLETE", "T5: explicit INCOMPLETE is a typed failure"] },
    { file: "tests/unit/deepseekParentIsolation.test.ts", anchors: ["candidate followed by INCOMPLETE leaves the accepted parent unchanged"] },
  ] },
  { id: "PB27", references: [{ file: "tests/unit/deepseekStreamLifecycle.test.ts", anchors: ["T6: a stalled body is bounded and aborts and cancels"] }] },
  { id: "PB28", references: [{ file: "tests/unit/anthropicStreamErrorLifecycle.test.ts", anchors: ["T3: timeout after message_start ends with timeout_error and no success terminal", "T20: response closes boundedly after event:error"] }] },
  { id: "PB29", references: [{ file: "tests/unit/deepseekParentIsolation.test.ts", anchors: ["PB29: commits a normal accepted candidate 77 -> 1001", "PB29: the next request after success uses the accepted candidate"] }] },
  { id: "PB30", references: [{ file: "tests/unit/deepseekParentIsolation.test.ts", anchors: ["PB30: chains a rejected candidate locally and commits only the accepted retry", "PB30: guard exhaustion leaves the accepted parent unchanged"] }] },
  { id: "PB31", references: [
    { file: "tests/unit/persistentSessionDocument.test.ts", anchors: ["T4: new owner and store instances restore sessions and lineage"] },
    { file: "tests/unit/lineageFreshness.test.ts", anchors: ["PB31/PB32 prunes expired links durably during restart init"] },
  ] },
  { id: "PB32", references: [{ file: "tests/unit/lineageFreshness.test.ts", anchors: ["rejects and removes a link at TTL+1 during lookup", "PB32 selects the newest of two correlated current results"] }] },
  { id: "PB33", references: [{ file: "tests/unit/persistentSessionDocument.test.ts", anchors: ["T3: interleaved session and lineage writes retain every field", "FIFO serialization prevents a delayed older write from erasing a completed mutation"] }] },
  { id: "PB39", references: [
    { file: "tests/unit/nativeCliLaunch.test.ts", anchors: ["SHUTDOWN tracking stops only the terminal child created by Bridge"] },
    { file: "tests/unit/shutdownLifecycle.test.ts", anchors: ["accepts taskkill success only after the target exits", "bounds a hanging operation with one absolute deadline"] },
    { file: "tests/unit/bridgeConsoleShutdown.test.ts", anchors: ["does not delete auth credentials while accepting shutdown"] },
  ] },
];

const expectedIds = [
  ...Array.from({ length: 27 }, (_, index) => `PB${String(index + 7).padStart(2, "0")}`),
  "PB39",
];

describe("R4 PB-v1 deterministic acceptance map", () => {
  it("declares the exact resumed frozen scope", () => {
    expect(coverage.map(entry => entry.id)).toEqual(expectedIds);
  });

  it.each(coverage)("$id maps to existing deterministic regression anchors", entry => {
    expect(entry.references.length).toBeGreaterThan(0);
    for (const reference of entry.references) {
      const source = readFileSync(resolve(reference.file), "utf8");
      for (const anchor of reference.anchors) expect(source).toContain(anchor);
    }
  });
});
