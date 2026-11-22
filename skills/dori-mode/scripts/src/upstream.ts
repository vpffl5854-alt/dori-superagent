/**
 * Keeping the owner's fork level with the original repository: new upstream commits are merged in a throwaway
 * worktree and the full CI runs there, never in the live checkout. A clean, green merge is pushed as a branch and
 * offered to the owner; a conflicted or red one is described and handed to a lane through the backlog. Nothing
 * reaches the live branch until the owner says yes.
 */
export type SyncResult =
  | { readonly kind: "level" }
  | { readonly kind: "ready"; readonly branch: string; readonly commits: readonly string[] }
  | { readonly kind: "conflict"; readonly files: readonly string[]; readonly commits: readonly string[] }
  | { readonly kind: "red"; readonly branch: string; readonly tail: string; readonly commits: readonly string[] };

/** Changes that need a closer look than "tests pass": the toolchain moving a major version, or a revert. */
export const riskyCommits = (commits: readonly string[]): string[] =>
  commits.filter((c) => /\bRevert\b|typescript.{0,12}\^?[1-9]\d*\.0|major|breaking|!:/i.test(c));

export const syncKey = (upstreamHead: string): string => `upstream-${upstreamHead.slice(0, 8)}`;

export const syncMessage = (r: SyncResult, key: string): string | null => {
  if (r.kind === "level") return null;
  const n = r.commits.length;
  const risky = riskyCommits(r.commits);
  const head = [
    `🔄 [원본 따라잡기] 원본(sisyphuslabs)에 새 변경 ${n}개.`,
    ...r.commits.slice(0, 6).map((c) => `- ${c.slice(0, 90)}`),
    ...(n > 6 ? [`- …외 ${n - 6}개`] : []),
    ...(risky.length ? [`⚠️ 주의할 변경 ${risky.length}개 (버전 대폭 변경·되돌리기)`] : []),
  ];
  if (r.kind === "ready")
    return [
      ...head,
      `합쳐 보니 충돌 없고 전체 테스트 통과 (브랜치 ${r.branch}). 반영할까? 지브가 "ㅇㅇ"하면 반영한다 (${key}).`,
    ].join("\n");
  if (r.kind === "conflict")
    return [
      ...head,
      `내 변경과 충돌 ${r.files.length}곳: ${r.files.slice(0, 5).join(", ")}`,
      `레인이 풀고 테스트까지 돌려도 될까? 지브가 "ㅇㅇ"하면 시작한다 (${key}).`,
    ].join("\n");
  return [...head, `합쳐지긴 하는데 테스트가 깨진다 (브랜치 ${r.branch}). 레인이 고쳐도 될까? (${key})`].join("\n");
};

export const syncBrief = (r: SyncResult, key: string, upstream: string): string =>
  [
    `# ${key}: 원본(${upstream}) 따라잡기`,
    "",
    r.kind === "conflict"
      ? `충돌 파일: ${r.files.join(", ")}`
      : r.kind === "red"
        ? `테스트 실패 끝부분:\n\n\`\`\`\n${r.tail}\n\`\`\``
        : "",
    "",
    "## 할 일",
    "1. 라이브 체크아웃(~/dori-superagent)은 건드리지 말고 `git worktree add`로 새 작업 폴더를 만든다.",
    "2. `discord-lane-answer`에 `origin/main`을 merge한다. 충돌은 양쪽 의도를 다 살려 푼다(원본의 개선 + 형 기능: 라우터 꼬리표, 쇼츠, SNS, 의무실 등).",
    "3. 루트와 `skills/dori-mode/scripts`에서 `bun install`, 그다음 `bun run ci`가 통과할 때까지 고친다.",
    `4. 결과를 \`${key}\` 브랜치로 형 저장소(mine)에 push하고 리드에게 보고한다. 라이브 브랜치 반영은 지브 승인 뒤 리드가 한다.`,
    "",
  ].join("\n");
