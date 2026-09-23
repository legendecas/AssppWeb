import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist } from "../../src/apple/plist";
import {
  defaultAuthURL,
  fetchBag,
  normalizeAuthURL,
} from "../../src/apple/bag";

describe("apple/bag", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses authenticateAccount from urlBag", async () => {
    const xml = buildPlist({
      urlBag: {
        authenticateAccount:
          "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => xml,
      }),
    );

    const result = await fetchBag("aabbccddeeff");

    expect(result.authURL).toBe(
      "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    );
  });

  it("normalizes a native auth endpoint at the plist root to the /fast/ path", async () => {
    const xml = buildPlist({
      authenticateAccount: "https://auth.itunes.apple.com/auth/v1/native",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => xml,
      }),
    );

    const result = await fetchBag("aabbccddeeff");

    expect(result.authURL).toBe(
      "https://auth.itunes.apple.com/auth/v1/native/fast/",
    );
  });

  it("falls back when authenticateAccount is missing", async () => {
    const xml = buildPlist({
      urlBag: {
        Ghostrider: "YES",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => xml,
      }),
    );

    const result = await fetchBag("aabbccddeeff");

    expect(result.authURL).toBe(defaultAuthURL);
  });

  it('reads SAP setup endpoints and the integer protocol version from urlBag', async () => {
    const setupURL = 'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy';
    const certificateURL = 'https://s.mzstatic.com/sap/setupCert.plist';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => buildPlist({
        urlBag: {
          'sign-sap-setup': setupURL,
          'sign-sap-setup-cert': certificateURL,
          'sign-sap-version': 200,
        },
      }),
    }));

    expect(await fetchBag('aabbccddeeff')).toEqual({
      authURL: defaultAuthURL,
      sapEndpoints: { setupURL, certificateURL, version: 200 },
    });
  });

  it("falls back when bag proxy returns non-OK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        json: async () => ({ error: "upstream failed" }),
      }),
    );

    const result = await fetchBag("aabbccddeeff");

    expect(result.authURL).toBe(defaultAuthURL);
  });

  describe("normalizeAuthURL", () => {
    it("appends /fast/ to a bare native auth endpoint", () => {
      expect(
        normalizeAuthURL("https://auth.itunes.apple.com/auth/v1/native"),
      ).toBe("https://auth.itunes.apple.com/auth/v1/native/fast/");
    });

    it("adds the trailing slash when /fast is already present", () => {
      expect(
        normalizeAuthURL("https://auth.itunes.apple.com/auth/v1/native/fast"),
      ).toBe("https://auth.itunes.apple.com/auth/v1/native/fast/");
    });

    it("is idempotent on an already-normalized endpoint", () => {
      expect(
        normalizeAuthURL("https://auth.itunes.apple.com/auth/v1/native/fast/"),
      ).toBe("https://auth.itunes.apple.com/auth/v1/native/fast/");
    });

    it("leaves legacy endpoints on other hosts unchanged", () => {
      const legacy =
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate";
      expect(normalizeAuthURL(legacy)).toBe(legacy);
    });
  });
});
