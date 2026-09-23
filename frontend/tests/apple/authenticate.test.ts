import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist } from "../../src/apple/plist";
import { authenticate } from "../../src/apple/authenticate";
import { appleRequest } from "../../src/apple/request";
import { fetchBag } from "../../src/apple/bag";
import { prepareSigner } from '../../src/apple/sap/client';
import type { SapSigner } from '../../src/apple/sap/signer';

vi.mock('../../src/apple/sap/client', () => ({ prepareSigner: vi.fn() }));

vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));

vi.mock("../../src/apple/bag", () => ({
  fetchBag: vi.fn(),
  defaultAuthURL:
    "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
}));

describe("apple/authenticate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets guid query exactly once from bag endpoint", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?foo=1&guid=old-value",
    });
    vi.mocked(appleRequest).mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      rawHeaders: [],
      body: buildPlist({
        accountInfo: {
          appleId: "test@example.com",
          address: {
            firstName: "Test",
            lastName: "User",
          },
        },
        passwordToken: "token",
        dsPersonId: "123",
      }),
    });

    await authenticate(
      "test@example.com",
      "password",
      undefined,
      undefined,
      "aabbccddeeff",
    );

    const requestCall = vi.mocked(appleRequest).mock.calls[0][0];
    const endpoint = new URL(`https://${requestCall.host}${requestCall.path}`);

    expect(endpoint.searchParams.get("guid")).toBe("aabbccddeeff");
    expect(endpoint.searchParams.getAll("guid")).toHaveLength(1);
    expect(endpoint.searchParams.get("foo")).toBe("1");
  });

  it('signs each exact UTF-8 request body when retrying with a verification code', async () => {
    const sapEndpoints = {
      certificateURL: 'https://s.mzstatic.com/sap/setupCert.plist',
      setupURL: 'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy',
      version: 200,
    };
    vi.mocked(fetchBag).mockResolvedValue({
      authURL: 'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate',
      sapEndpoints,
    });
    const sign = vi.fn().mockResolvedValueOnce('first-signature').mockResolvedValueOnce('2fa-signature');
    vi.mocked(prepareSigner).mockResolvedValue({ sign } as unknown as SapSigner);
    vi.mocked(appleRequest)
      .mockResolvedValueOnce({
        status: 200, statusText: 'OK', headers: {}, rawHeaders: [],
        body: buildPlist({ failureType: '', customerMessage: 'MZFinance.BadLogin.Configurator_message' }),
      })
      .mockResolvedValueOnce({
        status: 200, statusText: 'OK', headers: {}, rawHeaders: [],
        body: buildPlist({
          accountInfo: { appleId: 'test@example.com', address: { firstName: 'Test', lastName: 'User' } },
          passwordToken: 'token', dsPersonId: '123',
        }),
      });

    // A non-ASCII password exercises byte encoding as well as the 2FA suffix.
    const password = 'p\u00e4ss&word';
    await expect(authenticate('test@example.com', password, undefined, undefined, 'aabbccddeeff'))
      .rejects.toMatchObject({ codeRequired: true });
    const account = await authenticate('test@example.com', password, '123456', undefined, 'aabbccddeeff');

    expect(account.passwordToken).toBe('token');
    expect(prepareSigner).toHaveBeenNthCalledWith(1, 'aabbccddeeff', sapEndpoints);
    expect(prepareSigner).toHaveBeenNthCalledWith(2, 'aabbccddeeff', sapEndpoints);
    for (const [index, [request]] of vi.mocked(appleRequest).mock.calls.entries()) {
      expect(sign.mock.calls[index][0]).toEqual(new TextEncoder().encode(request.body));
      expect(request.headers?.['X-Apple-ActionSignature']).toBe(index === 0 ? 'first-signature' : '2fa-signature');
    }
    expect(new TextDecoder().decode(sign.mock.calls[1][0])).toContain('123456');
  });
});
