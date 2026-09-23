import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchEndpoint,
  downloadProduct,
  needsDownloadFallback,
} from '../../src/apple/downloadProduct';
import { appleRequest } from '../../src/apple/request';
import { buildPlist, parsePlist } from '../../src/apple/plist';
import type { Account, Software } from '../../src/types';

vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
vi.mock('../../src/apple/bag', () => ({
  fetchBag: async () => ({
    redownloadURL: 'https://downloaddispatch.itunes.apple.com/r/redownload',
    updateURL: 'https://downloaddispatch.itunes.apple.com/up/updateProduct',
  }),
}));

const account = {
  store: '143465',
  pod: '6',
  deviceIdentifier: 'test-device',
  directoryServicesIdentifier: 'test-dsid',
  cookies: [],
} as unknown as Account;
const app = { id: 736536022, bundleID: 'tv.danmaku.bilianime' } as Software;
const metadata = {
  itemId: app.id,
  softwareVersionBundleId: app.bundleID,
  softwareVersionExternalIdentifier: 891329111,
};
const response = (
  body: string,
  status = 200,
  headers: Record<string, string> = {},
  rawHeaders: [string, string][] = [],
) => ({
  status,
  body,
  statusText: '',
  headers,
  rawHeaders,
});

const productResponse = (overrides: Record<string, unknown> = {}) => response(
  buildPlist({ songList: [{ metadata: { ...metadata, ...overrides } }] }),
);

const catalogResponse = (offers: Record<string, unknown>[]) => response(
  JSON.stringify({ results: { [app.id]: { bundleId: app.bundleID, offers } } }),
);

const iosOffer = {
  assets: [{ flavor: 'iosSoftware' }],
  version: { externalId: metadata.softwareVersionExternalIdentifier },
};

beforeEach(() => {
  vi.mocked(appleRequest).mockReset();
});

describe('download recovery boundaries', () => {
  it.each([
    [{ status: 0, authorized: false, songList: [] }, true],
    [{ failureType: '5002', songList: [] }, true],
    [{ customerMessage: 'App No Longer Available', songList: [] }, true],
    [{ failureType: '2042' }, false],
    [{ failureType: '9610' }, false],
    [{ customerMessage: 'Accept new terms' }, false],
    [{ songList: [{}] }, false],
  ])(
    'classifies fallback eligibility for %j as %s',
    (dict, expected) => {
      expect(needsDownloadFallback(dict)).toBe(expected);
    },
  );

  it.each([
    'http://downloaddispatch.itunes.apple.com/up/updateProduct',
    'https://example.com/up/updateProduct',
    'https://downloaddispatch.itunes.apple.com/up/updateProduct?token=example',
    'https://user@downloaddispatch.itunes.apple.com/up/updateProduct',
  ])('rejects dispatch endpoint %s with DownloadError', (url) => {
    expect(() => dispatchEndpoint(url, 'update', 'device')).toThrow('Invalid download endpoint in Apple bag');
  });
});

// Captured failure shape: primary HTTP 200 with an empty songList, followed by
// redownload HTTP 500 with no body. Only pinned updateProduct returns the app.
// Wrong app/version metadata must never be accepted as a successful recovery.
it.each([
  { mismatch: false, redownloadCode: '' },
  { mismatch: true, redownloadCode: '' },
  { mismatch: false, redownloadCode: '5002' },
])(
  'recovers empty/5002 responses and validates metadata: %j',
  async ({ mismatch, redownloadCode }) => {
    vi.mocked(appleRequest).mockImplementation(async (request) => {
      if (request.host === 'uclient-api.itunes.apple.com') {
        expect(request.cookies).toBeUndefined();
        return response(
          JSON.stringify({
            results: {
              [app.id]: {
                bundleId: app.bundleID,
                offers: [
                  {
                    assets: [{ flavor: 'iosSoftware' }],
                    version: { externalId: 891329111 },
                  },
                ],
              },
            },
          }),
        );
      }
      const payload = parsePlist(request.body!);
      expect(payload.serialNumber).toBe('0');
      if (request.path.includes('volumeStoreDownloadProduct')) {
        return response(
          buildPlist({ status: 0, authorized: false, songList: [] }),
        );
      }
      expect(payload.appExtVrsId).toBe('891329111');
      expect(payload.externalVersionId).toBeUndefined();
      if (request.path.startsWith('/r/redownload'))
        return redownloadCode
          ? response(buildPlist({ failureType: redownloadCode }))
          : response('', 500);
      expect(request.path).toMatch(/^\/up\/updateProduct\?/);
      return response(
        buildPlist({
          status: 0,
          songList: [
            { metadata: { ...metadata, itemId: mismatch ? 1 : app.id } },
          ],
        }),
      );
    });
    if (mismatch) {
      await expect(downloadProduct(account, app)).rejects.toThrow(
        'does not match',
      );
    } else {
      const result = await downloadProduct(account, app);
      expect(result.dict.songList[0].metadata).toEqual(metadata);
    }
  },
);

describe('download catalog recovery', () => {
  // Regression: https://github.com/Lakr233/AssppWeb/pull/90 stopped at an
  // empty enterprise catalog even when a consumer catalog contained the app.
  it.each([
    { target: 'iphone', missing: 'app' },
    { target: 'ipad', missing: 'offers' },
    { target: 'ipad', missing: 'ios offer' },
  ])('uses $target when earlier catalogs lack $missing', async ({ target, missing }) => {
    const platforms: string[] = [];
    vi.mocked(appleRequest).mockImplementation(async (request) => {
      if (request.path.includes('volumeStoreDownloadProduct')) {
        return response(buildPlist({ failureType: '5002' }));
      }
      if (request.host === 'uclient-api.itunes.apple.com') {
        expect(request.cookies).toBeUndefined();
        expect(request.headers).toBeUndefined();
        const params = new URL(`https://${request.host}${request.path}`).searchParams;
        expect(params.get('cc')).toBe('cn');
        expect(params.get('id')).toBe(String(app.id));
        const platform = params.get('platform')!;
        platforms.push(platform);
        if (platform === target) return catalogResponse([iosOffer]);
        if (missing === 'app') return response(JSON.stringify({ results: {} }));
        return catalogResponse(missing === 'offers' ? [] : [
          { assets: [{ flavor: 'tvSoftware' }], version: { externalId: 999 } },
        ]);
      }
      expect(parsePlist(request.body!).appExtVrsId).toBe(String(metadata.softwareVersionExternalIdentifier));
      return productResponse();
    });

    await downloadProduct(account, app);

    expect(platforms).toEqual(target === 'iphone' ? ['ios', 'iphone'] : ['ios', 'iphone', 'ipad']);
  });

  it('reports catalog exhaustion after exactly three lookups', async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response(buildPlist({ songList: [] })))
      .mockResolvedValue(response(JSON.stringify({ results: {} })));

    await expect(downloadProduct(account, app)).rejects.toThrow(
      `No iOS version available for app ${app.id} in storefront CN (ios, iphone, ipad)`,
    );
    expect(appleRequest).toHaveBeenCalledTimes(4);
    expect(vi.mocked(appleRequest).mock.calls.slice(1).map(([request]) =>
      new URL(`https://${request.host}${request.path}`).searchParams.get('platform'),
    )).toEqual(['ios', 'iphone', 'ipad']);
  });

  it('rejects a catalog result with a different bundle identifier', async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response(buildPlist({ songList: [] })))
      .mockResolvedValueOnce(response(JSON.stringify({
        results: { [app.id]: { bundleId: 'different.bundle', offers: [iosOffer] } },
      })));

    await expect(downloadProduct(account, app)).rejects.toThrow('different app');
    expect(appleRequest).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, ''])('reads buyParams when externalId is %j', async (externalId) => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response(buildPlist({ songList: [] })))
      .mockResolvedValueOnce(catalogResponse([{
        assets: iosOffer.assets,
        version: { externalId },
        buyParams: `appExtVrsId=${metadata.softwareVersionExternalIdentifier}`,
      }]))
      .mockResolvedValueOnce(productResponse());

    await downloadProduct(account, app);

    expect(parsePlist(vi.mocked(appleRequest).mock.calls[2][0].body!).appExtVrsId)
      .toBe(String(metadata.softwareVersionExternalIdentifier));
  });
});

describe('pinned download recovery', () => {
  it('preserves the selected version through redownload and update without a catalog lookup', async () => {
    const version = '123456789';
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response(buildPlist({ failureType: '5002' })))
      .mockResolvedValueOnce(response('', 500))
      .mockResolvedValueOnce(productResponse({ softwareVersionExternalIdentifier: version }));

    await downloadProduct(account, app, version);

    const requests = vi.mocked(appleRequest).mock.calls.map(([request]) => request);
    expect(requests.map((request) => request.host)).toEqual([
      'p6-buy.itunes.apple.com',
      'downloaddispatch.itunes.apple.com',
      'downloaddispatch.itunes.apple.com',
    ]);
    expect(parsePlist(requests[0].body!).externalVersionId).toBe(version);
    expect(parsePlist(requests[1].body!).appExtVrsId).toBe(version);
    expect(parsePlist(requests[2].body!).appExtVrsId).toBe(version);
  });

  it.each([
    { itemId: 1 },
    { softwareVersionBundleId: 'different.bundle' },
    { softwareVersionExternalIdentifier: 999 },
  ])('rejects mismatched update metadata %j', async (mismatch) => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response(buildPlist({ songList: [] })))
      .mockResolvedValueOnce(response('', 500))
      .mockResolvedValueOnce(productResponse(mismatch));

    await expect(downloadProduct(account, app, String(metadata.softwareVersionExternalIdentifier)))
      .rejects.toThrow('does not match the requested app/version');
  });

  it.each(['2034', '2042', '9610'])('preserves failure %s without a fallback request', async (failureType) => {
    vi.mocked(appleRequest).mockResolvedValueOnce(response(buildPlist({ failureType })));

    await expect(downloadProduct(account, app)).rejects.toMatchObject({ code: failureType });
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });
});

describe('download redirects and cookies', () => {
  it.each([301, 302, 303, 307, 308])('carries rotated cookies through a %s redirect and endpoint recovery', async (status) => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response('', status, {
        location: 'https://p7-buy.itunes.apple.com/download',
      }, [['set-cookie', 'session=redirect; Path=/; Secure']]))
      .mockResolvedValueOnce(response(buildPlist({ failureType: '5002' }), 200, {}, [
        ['set-cookie', 'session=primary; Path=/; Secure'],
      ]))
      .mockResolvedValueOnce(response('', 500, {}, [
        ['set-cookie', 'session=redownload; Path=/; Secure'],
      ]))
      .mockResolvedValueOnce({
        ...productResponse(),
        rawHeaders: [['set-cookie', 'session=update; Path=/; Secure']],
      });

    const result = await downloadProduct(account, app, String(metadata.softwareVersionExternalIdentifier));

    const requests = vi.mocked(appleRequest).mock.calls.map(([request]) => request);
    expect(requests[1]).toMatchObject({ host: 'p7-buy.itunes.apple.com', path: '/download' });
    expect(requests.map((request) => request.cookies?.find((cookie) => cookie.name === 'session')?.value))
      .toEqual([undefined, 'redirect', 'primary', 'redownload']);
    expect(result.updatedCookies.find((cookie) => cookie.name === 'session')?.value).toBe('update');
    expect(account.cookies).toEqual([]);
  });

  it.each([
    'https://example.com/download',
    'https://buy.itunes.apple.com.example.com/download',
    'http://buy.itunes.apple.com/download',
    'https://buy.itunes.apple.com:8443/download',
    'https://user@buy.itunes.apple.com/download',
  ])('rejects redirect %s before forwarding account headers', async (location) => {
    vi.mocked(appleRequest).mockResolvedValueOnce(response('', 302, { location }));

    await expect(downloadProduct(account, app)).rejects.toThrow('Unsafe Apple download redirect');
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it('stops after three followed redirects', async () => {
    vi.mocked(appleRequest).mockResolvedValue(response('', 302, { location: '/download' }));

    await expect(downloadProduct(account, app)).rejects.toMatchObject({ name: 'DownloadError' });
    expect(appleRequest).toHaveBeenCalledTimes(4);
  });
});
