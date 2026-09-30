import { vi } from "vitest";

// Unit tests are offline: the destination guard (`src/destination.ts`) resolves host names before every request,
// resolve every name to a public address instantly. Tests of the guard override the mock.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.215.14", family: 4 }]),
}));
