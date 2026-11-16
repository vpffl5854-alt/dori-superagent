import { formatRef, parseRef, type SessionRef } from "./runtime/types.ts";

/**
 * A ref as Dori stores and prints it beside records written before runtimes existed: a herdr pane bare (`w1:p3`), any
 * other runtime with its prefix (`hc:t7`). roles.json values, inbox file names and delivery notices use this form.
 */
export const refText = (ref: SessionRef): string => (ref.runtime === "herdr" ? ref.id : formatRef(ref));

/** Reads refText back. A stored value no runtime parses is a pane id an older herdr wrote. */
export const refFromText = (text: string): SessionRef => parseRef(text) ?? { runtime: "herdr", id: text };

export const sameSession = (a: SessionRef, b: SessionRef): boolean => a.runtime === b.runtime && a.id === b.id;
