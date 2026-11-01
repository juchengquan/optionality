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

  it("has nothing to read where there is no [project] table", () => {
    expect(versionIn('[tool.only]\nversion = "9"\n')).toBe(null);
  });

  it("reads the project's version past a decoy, not the first one in the file", () => {
    // the read has to be scoped for the same reason the write does, and a sweep showed the
    // no-[project] case above cannot prove it: that one returns early and never reaches the match
    const decoyFirst = '[tool.something]\nversion = "9.9.9"\n\n[project]\nversion = "0.1.0"\n';
    expect(versionIn(decoyFirst)).toBe("0.1.0");
  });

  it("finds the table by its own line, not by a comment that mentions it", () => {
    // this repo's TOML is heavily commented, and an unanchored match would start the span inside
    // the comment and end it at the real header — reading no version at all, which reads as
    // "py-cut was never run" and refuses a release that was perfectly fine
    const commented = '# the [project] table carries the version\n[project]\nversion = "2026.11.1"\n';
    expect(versionIn(commented)).toBe("2026.11.1");
    expect(withVersion(commented, "2026.12.4")).toContain('version = "2026.12.4"');
  });

  it("rewrites the project's own version, not the first thing that looks like one", () => {
    // TOML does not order its tables, so a decoy can precede [project] — and an unanchored
    // replace takes the FIRST match, which is how a release would silently bump a tool's pin and
    // ship the package still calling itself 0.1.0. A mutation sweep found the old fixture put the
    // decoy last, where either version of the code passed.
    const decoyFirst = [
      "[tool.something]",
      'version = "9.9.9"',
      "",
      "[project]",
      'name = "optionality"',
      'version = "0.1.0"',
    ].join("\n");
    const next = withVersion(decoyFirst, "2026.11.1");
    expect(next).toContain('version = "9.9.9"');
    expect(next).toContain('version = "2026.11.1"');
    expect(next).not.toContain('version = "0.1.0"');
  });
});
