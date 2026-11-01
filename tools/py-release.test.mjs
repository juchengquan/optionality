import { describe, expect, it } from "vitest";

import { calver, DATED, versionIn, withVersion } from "./py-release.mjs";

/** The release arithmetic, which is where a version scheme goes wrong silently (ADR 0016). */
describe("the computed version", () => {
  it("is the date, with neither field padded", () => {
    // PEP 440 normalises 2026.09.0 to 2026.9.0, so a padded tag and `pip show` would disagree
    // for ever. Computing it is how that cannot be typed wrong.
    expect(calver(new Date(2026, 8, 1))).toBe("2026.9.1");
    expect(calver(new Date(2026, 10, 23))).toBe("2026.11.23");
  });

  it("does not pad a single-digit day either", () => {
    expect(calver(new Date(2026, 11, 4))).toBe("2026.12.4");
  });
});

describe("what py-tag will accept", () => {
  it("takes a date, and a second cut on the same day", () => {
    expect(DATED.test("2026.11.1")).toBe(true);
    expect(DATED.test("2026.11.23")).toBe(true);
    expect(DATED.test("2026.11.1.1")).toBe(true);
  });

  it("refuses the version that means py-cut was never run", () => {
    // the whole reason the check exists: 0.1.0 is what pyproject.toml says before any release
    expect(DATED.test("0.1.0")).toBe(false);
  });

  it("refuses anything that is not anchored to a date", () => {
    for (const bad of ["1.0.0", "v2026.11.1", "2026.11", "2026.11.1-rc1", "12026.11.1", ""]) {
      expect(DATED.test(bad), bad).toBe(false);
    }
  });
});

describe("rewriting pyproject.toml", () => {
  const toml = '[project]\nname = "optionality"\nversion = "0.1.0"\nrequires-python = ">=3.12"\n';

  it("reads the version back", () => {
    expect(versionIn(toml)).toBe("0.1.0");
  });

  it("replaces it and nothing else", () => {
    const next = withVersion(toml, "2026.11.1");
    expect(versionIn(next)).toBe("2026.11.1");
    expect(next).toContain('name = "optionality"');
    expect(next).toContain('requires-python = ">=3.12"');
  });

  it("leaves a dependency's own pin alone", () => {
    // `version = ` appears once at the top level; anchoring to the line start is what keeps a
    // future [tool.x] section's own version out of it
    const withDep = `${toml}\n[tool.something]\nother = "version = \\"9\\""\n`;
    expect(withVersion(withDep, "2026.11.1")).toContain('other = "version = \\"9\\""');
  });
});
