export type CommitIdentity = { readonly name: string; readonly email: string };
export type PrFile = {
  readonly filename: string;
  readonly status: string;
  readonly patch?: string;
  readonly previous_filename?: string;
};
export type PrCommit = {
  readonly sha: string;
  readonly commit: {
    readonly message: string;
    readonly author: CommitIdentity | null;
    readonly committer: CommitIdentity | null;
  };
  readonly files: readonly PrFile[];
  readonly parents?: readonly { readonly sha: string }[];
};
export type PrSnapshot = {
  readonly repo: string;
  readonly number: number;
  readonly body: string | null;
  readonly head: string;
  readonly commits: readonly PrCommit[];
  readonly files: readonly PrFile[];
};
export type VerifyPrOptions = {
  readonly expectedIdentity?: CommitIdentity;
  readonly loopCount?: number;
  readonly cwd?: string;
};
export type VerifyPrResult = {
  readonly ok: boolean;
  readonly repo: string;
  readonly number: number;
  readonly head?: string;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly asyncUiTests: readonly string[];
  readonly loopCommand?: string;
};

// Fixture, helper, fake and mock directories never hold counted tests; a file with one of those names counts
// only when it is named as a test (helpers.test.ts), not when it merely sits in a test directory (test/fakes.ts).
const isTest = (path: string): boolean =>
  !/(?:^|\/)(?:fixtures?|__fixtures__|__snapshots__|helpers?|fakes?|mocks?)\//i.test(path) &&
  (/(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?[jt]sx?|py|go|rs|rb|sh|java|kt|swift)$/i.test(path) ||
    /(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.(?:go|py))$/i.test(path) ||
    (/(?:^|\/)(?:tests?|__tests__)\//i.test(path) &&
      /\.(?:[cm]?[jt]sx?|py|go|rs|rb|sh|java|kt|swift)$/i.test(path) &&
      !/(?:^|\/)(?:(?:setup|conftest|test-utils)[./]|(?:fixtures?|helpers?|fakes?|mocks?)\.[^/]*$)/i.test(path)));

const isSource = (path: string): boolean =>
  !isTest(path) &&
  !/(?:^|\/)(?:docs?|fixtures?|__fixtures__|__snapshots__)\//i.test(path) &&
  /\.(?:[cm]?[jt]sx?|css|scss|sass|less|html|vue|svelte|py|go|rs|rb|sh|sql|c|cpp|h|java|kt|swift)$/i.test(path);

// A diff cannot prove a test is synchronous: include UI test candidates even
// when its async setup is outside the patch. This intentionally errs wide.
const isUiTest = (file: PrFile): boolean =>
  isTest(file.filename) &&
  file.status !== "removed" &&
  (/\.[jt]sx$/i.test(file.filename) ||
    /(?:^|\/)(?:components?|features?|ui|e2e|browser|playwright)\//i.test(file.filename) ||
    /\b(?:WebView|document|window|page\.(?:goto|locator)|render|screen\.|waitFor|userEvent|fireEvent)\b/.test(
      file.patch ?? "",
    ));

const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
export const failed = (repo: string, number: number, errors: readonly string[]): VerifyPrResult => ({
  ok: false,
  repo,
  number,
  errors,
  warnings: [],
  asyncUiTests: [],
});

export const optionErrors = (repo: string, number: number, options: VerifyPrOptions): string[] => {
  const errors: string[] = [];
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) errors.push("repository must be owner/repo");
  if (!Number.isSafeInteger(number) || number < 1) errors.push("PR number must be a positive integer");
  if (!Number.isSafeInteger(options.loopCount ?? 20) || (options.loopCount ?? 20) < 1)
    errors.push("loop count must be a positive integer");
  const identity = options.expectedIdentity;
  if (
    typeof identity?.name !== "string" ||
    !identity.name.trim() ||
    typeof identity.email !== "string" ||
    !identity.email.trim()
  )
    errors.push(`missing expected author/committer identity for ${repo}; add it to repoIdentities in the config`);
  return errors;
};

export const checkPr = (snapshot: PrSnapshot, options: VerifyPrOptions = {}): VerifyPrResult => {
  const { repo, number } = snapshot;
  const errors = optionErrors(repo, number, options);
  const identity = options.expectedIdentity;
  if (errors.length || !identity) return failed(repo, number, errors);
  const warnings: string[] = [];
  const noTestReason = /^No test:[ \t]*(\S[^\r\n]*)$/m.exec(snapshot.body ?? "")?.[1]?.trim();
  if (!snapshot.commits.length) errors.push("PR has no commits to verify");
  let fixesSource = false;
  const changesTest = (file: PrFile): boolean =>
    ["added", "modified", "renamed", "copied", "changed"].includes(file.status) && isTest(file.filename);
  for (const c of snapshot.commits) {
    for (const role of ["author", "committer"] as const) {
      const actual = c.commit[role];
      if (
        typeof actual?.name !== "string" ||
        !actual.name.trim() ||
        typeof actual?.email !== "string" ||
        !actual.email.trim()
      )
        errors.push(`${c.sha}: missing ${role} identity; expected ${identity.name} <${identity.email}>`);
      else if (
        actual.email.toLowerCase() === "noreply@github.com"
          ? !(role === "committer" && Array.isArray(c.parents) && c.parents.length > 1)
          : actual.email.toLowerCase() !== identity.email.toLowerCase()
      ) {
        errors.push(
          `${c.sha}: wrong ${role} email ${actual.email}; expected ${identity.email}${role === "committer" ? " (or noreply@github.com for a merge commit)" : ""}`,
        );
      }
    }
    if (
      /^fix(?:\([^)]+\))?!?:/.test(c.commit.message) &&
      c.files.some((f) => isSource(f.filename) || (f.previous_filename !== undefined && isSource(f.previous_filename)))
    ) {
      fixesSource = true;
      if (!c.files.some(changesTest))
        warnings.push(
          `${c.sha}: fix commit changes source without its own added/changed test; coverage is evaluated across the PR`,
        );
    }
  }
  if (fixesSource && !snapshot.files.some(changesTest)) {
    const message = "PR has source fix commits but no added/changed test";
    if (noTestReason) warnings.push(`${message}; No test: ${noTestReason}`);
    else errors.push(`${message}; add a test or an explicit nonempty "No test: <reason>" PR-body line`);
  }
  const candidates = new Set<string>();
  for (const c of snapshot.commits)
    for (const f of c.files) {
      if (f.status === "removed") candidates.delete(f.filename);
      if (f.previous_filename) candidates.delete(f.previous_filename);
      if (isUiTest(f)) candidates.add(f.filename);
    }
  const asyncUiTests = [...candidates].sort();
  const loopCount = options.loopCount ?? 20;
  const loopCommand = asyncUiTests.length
    ? `i=0; while [ "$i" -lt ${loopCount} ]; do bun --no-env-file test ${asyncUiTests.map((f) => quote(`./${f}`)).join(" ")} || exit $?; i=$((i + 1)); done`
    : undefined;
  return {
    ok: !errors.length,
    repo,
    number,
    head: snapshot.head,
    errors,
    warnings,
    asyncUiTests,
    ...(loopCommand !== undefined ? { loopCommand } : {}),
  };
};
