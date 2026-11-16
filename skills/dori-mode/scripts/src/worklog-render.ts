import type { WorklogItem } from "./worklog.ts";

/** First line of a worklog.md this module wrote. A file without it is someone's notes and is never replaced. */
export const WORKLOG_MARKER = "<!-- written by dori worklog from worklog.jsonl; change it with the command -->";

/**
 * Publish a view of an append-only record until the record stopped growing during the publish. Another writer that
 * appended meanwhile may have published before us, leaving our older view last, so we publish again. The last publish
 * to finish therefore always holds every record, without a lock. The sizes are compared in bytes as read: decoding a
 * line cut inside a multi-byte character changes its length, and the sizes would then never match.
 */
export const renderUntilStable = (
  read: () => Buffer,
  publish: (record: string) => void,
  size: () => number,
): string => {
  for (;;) {
    const bytes = read();
    const record = bytes.toString("utf8");
    publish(record);
    if (size() === bytes.length) return record;
  }
};

const itemBlock = (item: WorklogItem): string =>
  [
    `### ${item.id} ${item.title}`,
    `- Source: ${item.source}`,
    `- Opened: ${item.openedAt}`,
    `- Next: ${item.next ?? "(none yet)"}`,
    ...(item.notes.length ? ["- Notes:", ...item.notes.map((note) => `  - ${note.at} ${note.text}`)] : []),
    ...(item.closedAt !== undefined ? [`- Closed: ${item.closedAt}`, `- Result: ${item.result ?? ""}`] : []),
  ].join("\n");

export const renderWorklog = (items: readonly WorklogItem[]): string => {
  const open = items.filter((item) => item.closedAt === undefined);
  const closed = items.filter((item) => item.closedAt !== undefined).reverse();
  const section = (title: string, list: readonly WorklogItem[]) =>
    `## ${title}\n\n${list.length ? list.map(itemBlock).join("\n\n") : "(none)"}\n`;
  return `${WORKLOG_MARKER}\n# Worklog\n\n${section("Open", open)}\n${section("Closed", closed)}`;
};

export const worklogLines = (items: readonly WorklogItem[]): string[] => {
  const open = items.filter((item) => item.closedAt === undefined);
  return [
    `WORKLOG open=${open.length}`,
    ...open.map(
      (item) =>
        `OPEN ${item.id} ${JSON.stringify(item.title)} source=${JSON.stringify(item.source)} next=${JSON.stringify(item.next ?? "")}`,
    ),
  ];
};
