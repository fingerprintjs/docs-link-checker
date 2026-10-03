import type { Corpus } from "./types";

/**
 * Serializes a `Corpus` with its metadata pretty-printed and one link per line (instead of one per field): with
 * tens of thousands of links, pretty-printing every link's fields makes the file many times longer than it needs
 * to be and the diff of a refresh unreadable. The result is still plain JSON, read back with a regular `JSON.parse`.
 */
export const serializeCorpus = (corpus: Corpus): string => {
  const { links, ...metadata } = corpus;
  const metadataLines = JSON.stringify(metadata, null, 2).split("\n");
  // JSON.stringify(object, null, 2) always starts with "{" and ends with "}" on their own line
  const metadataBody = metadataLines.slice(1, -1).join("\n");
  if (links.length === 0) {
    return `{\n${metadataBody},\n  "links": []\n}\n`;
  }
  const linkLines = links.map((link) => `    ${JSON.stringify(link)}`).join(",\n");
  return `{\n${metadataBody},\n  "links": [\n${linkLines}\n  ]\n}\n`;
};
