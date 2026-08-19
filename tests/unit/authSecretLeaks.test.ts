import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");

function readSource(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

const ACTIONS_SRC = readSource("src/server/actions.ts");
const AUTH_TS_SRC = readSource("scripts/auth.ts");
const DOCTOR_TS_SRC = readSource("scripts/doctor.ts");

const TOKEN_SLICE_RE = /token\.slice\(0,\s*\d+\)/;
const COOKIE_SLICE_RE = /cookie\.slice\(0,\s*\d+\)/;
const AUTH_SLICE_RE = /auth\.token\.slice\(0,\s*\d+\)/;
const AUTH_SESSION_RE = /\/api\/v0\/auth\/session/;

describe("actions.ts — no secret leaks in messages", () => {
  it("checkAuthStatus does not include token.slice", () => {
    expect(ACTIONS_SRC).not.toMatch(TOKEN_SLICE_RE);
  });

  it("checkAuthStatus does not use auth/session endpoint", () => {
    const block = ACTIONS_SRC.slice(
      ACTIONS_SRC.indexOf("export async function checkAuthStatus"),
      ACTIONS_SRC.indexOf("/* ── QUICK DIAGNOSTICS"),
    );
    expect(block).not.toMatch(AUTH_SESSION_RE);
  });

  it("runDiagnosticsSSE auth_file step has no token.slice", () => {
    const block = ACTIONS_SRC.slice(
      ACTIONS_SRC.indexOf("check auth file"),
      ACTIONS_SRC.indexOf("Check upstream reachability"),
    );
    expect(block).not.toMatch(TOKEN_SLICE_RE);
    expect(block).not.toMatch(COOKIE_SLICE_RE);
  });

  it("runDiagnosticsSSE upstream check has no /api/v0/auth/session", () => {
    const block = ACTIONS_SRC.slice(
      ACTIONS_SRC.indexOf("Check upstream reachability"),
      ACTIONS_SRC.indexOf("Check bridge server health"),
    );
    expect(block).not.toMatch(AUTH_SESSION_RE);
  });

  it("runAuthSSE result message has no token.slice", () => {
    const block = ACTIONS_SRC.slice(
      ACTIONS_SRC.indexOf("Auth saved"),
      ACTIONS_SRC.indexOf("cleanup();\n        return auth;"),
    );
    expect(block).not.toMatch(AUTH_SLICE_RE);
  });
});

describe("auth.ts — no secret leaks in printSummary", () => {
  it("printSummary does not include token.slice", () => {
    expect(AUTH_TS_SRC).not.toMatch(TOKEN_SLICE_RE);
  });

  it("printSummary does not include cookie.slice", () => {
    expect(AUTH_TS_SRC).not.toMatch(COOKIE_SLICE_RE);
  });
});

describe("doctor.ts — no secret leaks or debug output", () => {
  it("does not use /api/v0/auth/session", () => {
    expect(DOCTOR_TS_SRC).not.toMatch(AUTH_SESSION_RE);
  });

  it("has no console.error DEBUG lines", () => {
    expect(DOCTOR_TS_SRC).not.toMatch(/console\.error\("DEBUG/);
  });
});
