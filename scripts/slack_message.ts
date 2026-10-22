// Writes the Slack message of a scheduled run (see `src/report/slack.ts`) to `slack-payload.json`, only when there is
// something to notify about. Usage: `tsx scripts/slack_message.ts <report.json>...`, with `PAGES_URL` (where the
// reports are published) set.
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseSlackReport, renderSlackMessage } from "../src/report/slack";

const { PAGES_URL } = process.env;
if (!PAGES_URL) {
  throw new Error("PAGES_URL must be set");
}

const message = renderSlackMessage(
  process.argv.slice(2).map((path) => ({
    report: parseSlackReport(JSON.parse(readFileSync(path, "utf8"))),
    url: `${PAGES_URL}/${basename(path, ".json")}.html`,
  })),
  { indexUrl: `${PAGES_URL}/` },
);

if (message) {
  console.log(message);
  // https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks
  writeFileSync(
    "slack-payload.json",
    JSON.stringify({ text: message, unfurl_links: false, unfurl_media: false }),
  );
} else {
  console.log("Nothing to notify about.");
}
