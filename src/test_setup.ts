import { vi } from "vitest";

// Unit tests are offline. The destination guard (`src/destination.ts`) resolves host names when connecting,
// resolve every name to a public address instantly. Tests of the guard override the mock.
vi.mock("node:dns", () => ({
  lookup: vi.fn(
    (
      _hostname: string,
      _options: object,
      callback: (error: null, addresses: Array<{ address: string; family: number }>) => void,
    ) => callback(null, [{ address: "93.184.215.14", family: 4 }]),
  ),
}));

// undici's `fetch` calls the global `fetch`, so tests can stub it (`vi.stubGlobal("fetch", ...)`).
// Tests of real connections use `vi.importActual("undici")`.
vi.mock("undici", async (importActual) => ({
  ...(await importActual<typeof import("undici")>()),
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
}));
