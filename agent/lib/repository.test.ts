import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import { validateBranch } from "./github/git-remote.js";
import {
  extractRepositories,
  extractRepositoryUrls,
  parseRepository,
  remoteUrl,
  resolveRepository,
  resolveRepositoryInput,
  stampRepository,
} from "./repository.js";

const auth: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "user:1",
  principalType: "user",
};
const NO_REPOSITORY_PATTERN = /No repository is selected/u;
const RETARGET_PATTERN = /cannot retarget/u;
const PROTECTED_BRANCH_PATTERN = /not allowed/u;
const INVALID_BRANCH_PATTERN = /not a valid branch|plain branch/u;
const AMBIGUOUS_REPOSITORY_PATTERN = /ambiguous/u;

describe("repository targeting", () => {
  it("parses explicit slugs and GitHub URLs without hidden fallbacks", () => {
    assert.deepEqual(parseRepository("Acquisity/Foreman"), {
      owner: "Acquisity",
      repo: "Foreman",
      slug: "Acquisity/Foreman",
    });
    assert.equal(parseRepository("github.com/Acquisity/Foreman"), null);
    assert.deepEqual(
      extractRepositories(
        "Use https://github.com/Acquisity/Foreman.git please"
      ).map(({ slug }) => slug),
      ["Acquisity/Foreman"]
    );
    process.env.REPOSITORY = "stale/wrong";
    assert.throws(
      () => resolveRepository(undefined, auth),
      NO_REPOSITORY_PATTERN
    );
    delete process.env.REPOSITORY;
    assert.throws(
      () => resolveRepositoryInput("Acquisity/Foreman and example/other", auth),
      AMBIGUOUS_REPOSITORY_PATTERN
    );
  });

  it("never reads a channel repository out of a bare slug", () => {
    const message =
      "please begin work and use review bot loop skill but remember github tools are found in channels/github.ts";
    assert.deepEqual(extractRepositoryUrls(message), []);
    assert.deepEqual(
      extractRepositories(message).map(({ slug }) => slug),
      ["channels/github.ts"]
    );
    assert.deepEqual(
      extractRepositoryUrls(
        "ship it from https://github.com/Acquisity/Foreman, see channels/github.ts"
      ).map(({ slug }) => slug),
      ["Acquisity/Foreman"]
    );
    assert.deepEqual(
      extractRepositoryUrls(
        JSON.stringify({ url: "https://github.com/Acquisity/Foreman" })
      ).map(({ slug }) => slug),
      ["Acquisity/Foreman"]
    );
    assert.deepEqual(
      extractRepositoryUrls(
        "<https://github.com/Acquisity/Foreman> and `https://github.com/Acquisity/Foreman`"
      ).map(({ slug }) => slug),
      ["Acquisity/Foreman"]
    );
  });

  it("makes signed GitHub repository context authoritative", () => {
    const bound = stampRepository(auth, "Acquisity/Foreman", "github-webhook");
    assert.equal(resolveRepository(undefined, bound).slug, "Acquisity/Foreman");
    assert.throws(
      () => resolveRepository("attacker/redirect", bound),
      RETARGET_PATTERN
    );
  });

  it("builds literal validated remotes and rejects protected branches", () => {
    assert.equal(
      remoteUrl("Acquisity/Foreman"),
      "https://github.com/Acquisity/Foreman.git"
    );
    assert.match(validateBranch("main") ?? "", PROTECTED_BRANCH_PATTERN);
    assert.match(
      validateBranch("refs/heads/feature") ?? "",
      INVALID_BRANCH_PATTERN
    );
    assert.equal(validateBranch("foreman/fix-routing"), null);
  });
});
