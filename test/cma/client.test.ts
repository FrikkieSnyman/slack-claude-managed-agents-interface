import { describe, it, expect } from "vitest";
import { buildSessionResources, isInvalidSessionError } from "../../src/cma/client.js";

describe("isInvalidSessionError", () => {
  it("returns false for non-objects", () => {
    expect(isInvalidSessionError(null)).toBe(false);
    expect(isInvalidSessionError("oops")).toBe(false);
  });

  it("returns true on 404 and 410", () => {
    expect(isInvalidSessionError({ status: 404 })).toBe(true);
    expect(isInvalidSessionError({ status: 410 })).toBe(true);
  });

  it("returns true on 400/409 only when message mentions archive/terminated/deleted", () => {
    expect(isInvalidSessionError({ status: 400, message: "Session has been archived" })).toBe(true);
    expect(isInvalidSessionError({ status: 409, message: "Session was deleted" })).toBe(true);
    expect(isInvalidSessionError({ status: 400, message: "session is terminated" })).toBe(true);
    expect(isInvalidSessionError({ status: 400, message: "validation error" })).toBe(false);
  });

  it("returns false for 500-class errors", () => {
    expect(isInvalidSessionError({ status: 500, message: "archived" })).toBe(false);
  });
});

describe("buildSessionResources", () => {
  it("returns empty array when no memory store and no github repo", () => {
    expect(buildSessionResources({ memoryStoreId: null, githubRepo: null })).toEqual([]);
  });

  it("includes memory store when set", () => {
    expect(buildSessionResources({ memoryStoreId: "memstore_1", githubRepo: null })).toEqual([
      { type: "memory_store", memory_store_id: "memstore_1", access: "read_write" },
    ]);
  });

  it("includes github repo with no checkout when only url and token set", () => {
    expect(
      buildSessionResources({
        memoryStoreId: null,
        githubRepo: {
          url: "https://github.com/o/r",
          authToken: "ghp_xxx",
          branch: null,
          commit: null,
          mountPath: null,
        },
      }),
    ).toEqual([
      {
        type: "github_repository",
        url: "https://github.com/o/r",
        authorization_token: "ghp_xxx",
      },
    ]);
  });

  it("uses branch checkout when branch is set", () => {
    const out = buildSessionResources({
      memoryStoreId: null,
      githubRepo: {
        url: "https://github.com/o/r",
        authToken: "t",
        branch: "develop",
        commit: null,
        mountPath: null,
      },
    });
    expect(out[0]).toMatchObject({
      type: "github_repository",
      checkout: { type: "branch", name: "develop" },
    });
  });

  it("uses commit checkout when commit is set (takes precedence over branch)", () => {
    const out = buildSessionResources({
      memoryStoreId: null,
      githubRepo: {
        url: "https://github.com/o/r",
        authToken: "t",
        branch: "develop",
        commit: "abc123",
        mountPath: null,
      },
    });
    expect(out[0]).toMatchObject({
      checkout: { type: "commit", sha: "abc123" },
    });
  });

  it("includes mount_path when set", () => {
    const out = buildSessionResources({
      memoryStoreId: null,
      githubRepo: {
        url: "https://github.com/o/r",
        authToken: "t",
        branch: null,
        commit: null,
        mountPath: "/workspace/r",
      },
    });
    expect(out[0]).toMatchObject({ mount_path: "/workspace/r" });
  });

  it("includes both memory store and github repo when both are set", () => {
    const out = buildSessionResources({
      memoryStoreId: "memstore_1",
      githubRepo: {
        url: "https://github.com/o/r",
        authToken: "t",
        branch: null,
        commit: null,
        mountPath: null,
      },
    });
    expect(out).toHaveLength(2);
    expect(out[0]?.type).toBe("memory_store");
    expect(out[1]?.type).toBe("github_repository");
  });
});
