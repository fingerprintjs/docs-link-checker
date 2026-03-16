import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkLinkWithFetch, checkLinkWithPlaywright } from "./link";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

    const sendHtml = (status: number, body: string) => {
      response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : body);
    };

    switch (requestUrl.pathname) {
      case "/ok":
        sendHtml(200, "<html><body><h1>OK</h1></body></html>");
        return;
      case "/hashes":
        sendHtml(
          200,
          `
            <html>
              <body>
                <h1 id="server-hash">Server hash</h1>
                <a href="#href-hash">Href hash</a>
              </body>
            </html>
          `
        );
        return;
      case "/accidental":
        sendHtml(200, "<html><body><h1>Accidental hash page</h1></body></html>");
        return;
      case "/text":
        sendHtml(200, "<html><body><p>This page contains human readable text.</p></body></html>");
        return;
      case "/client-rendered":
        sendHtml(
          200,
          `
            <html>
              <body>
                <script>
                  setTimeout(() => {
                    const heading = document.createElement("h1");
                    heading.id = "client-hash";
                    heading.textContent = "Client hash";
                    document.body.appendChild(heading);
                  }, 50);
                </script>
              </body>
            </html>
          `
        );
        return;
      default:
        sendHtml(404, "<html><body><h1>Not found</h1></body></html>");
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

const linkCheckMethods = [
  {
    function: checkLinkWithFetch,
    name: "checkLinkWithFetch()",
  },
  {
    function: checkLinkWithPlaywright,
    name: "checkLinkWithPlaywright()",
  },
];

for (const { function: checkLink, name } of linkCheckMethods) {
  describe(name, () => {
    /**
     * Simple response checks
     */
    it(`${name} should return OK for working links`, async () => {
      const result = await checkLink(`${baseUrl}/ok`);
      expect(result).toMatchObject({ ok: true, status: 200 });
    });

    it(`${name} should return broken link for 404 links`, async () => {
      const result = await checkLink(`${baseUrl}/missing`);
      expect(result).toMatchObject({ ok: false, error: "broken link", status: 404 });
    });

    it(`${name} should return broken link for malformed URLS`, async () => {
      const result = await checkLink("ttps://www.google.com");
      expect(result).toMatchObject({
        ok: false,
        error: "broken link",
        errorDetail: expect.any(String),
      });
    });

    /**
     * Hashes
     */
    it(`${name} should return OK for hashes that exist (server-rendered)`, async () => {
      const result = await checkLink(`${baseUrl}/hashes#server-hash`);
      expect(result).toMatchObject({ ok: true, status: 200 });
    });

    it(
      `${name} should return 'hash not found' for broken hash links (server-rendered)`,
      { timeout: 10000 },
      async () => {
        const result = await checkLink(`${baseUrl}/hashes#does-not-exist`);
        expect(result).toMatchObject({ ok: false, status: 200, error: "hash not found" });
      }
    );

    it(`${name} should return OK for hashes implemented using 'href', like on GitHub`, async () => {
      const result = await checkLink(`${baseUrl}/hashes#href-hash`);
      expect(result).toMatchObject({ ok: true, status: 200 });
    });

    it(`${name} should return OK for hashes implemented using 'href', like on GitHub, even despite different casing`, async () => {
      const result = await checkLink(`${baseUrl}/hashes#HrEf-HaSh`);
      expect(result).toMatchObject({ ok: true, status: 200 });
    });

    it(`${name} should return OK and ignore accidental hashes that Readme creates 🤦`, async () => {
      const result = await checkLink(`${baseUrl}/accidental#/`);
      expect(result).toMatchObject({ ok: true, status: 200 });
    });

    /**
     * Text fragments
     */
    it(`${name} should return OK for links with text fragment`, async () => {
      const result = await checkLink(`${baseUrl}/text#:~:text=human`);
      expect(result).toMatchObject({ ok: true, status: 200, note: "Text Fragment" });
    });

    // Skipping this edge case for
    it(`${name} should return OK for links with text fragment, even if its not there`, async () => {
      const result = await checkLink(`${baseUrl}/text#:~:text=IS_NOT_THERE_DKSOAPD`);
      expect(result).toMatchObject({ ok: true, status: 200, note: "Text Fragment" });
    });
  });
}

describe("checkLinkWithPlaywright()", () => {
  it("should return OK for hashes that exist (client-rendered)", async () => {
    const result = await checkLinkWithPlaywright(`${baseUrl}/client-rendered#client-hash`);
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it(
    "should return 'hash not found' for broken hash links (client-rendered)",
    { timeout: 10000 },
    async () => {
      const result = await checkLinkWithPlaywright(`${baseUrl}/client-rendered#this-hash-does-not-exist`);
      expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
    }
  );
});
