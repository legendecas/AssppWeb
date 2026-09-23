import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSapAssets } from '../../src/apple/sap/assets';
import { exchangeSetupBuffer, fetchSetupCertificate } from '../../src/apple/sap/protocol';

vi.mock('../../src/apple/sap/assets', () => ({ loadSapAssets: vi.fn() }));
vi.mock('../../src/apple/sap/protocol', () => ({
  fetchSetupCertificate: vi.fn(),
  exchangeSetupBuffer: vi.fn(),
}));

const endpoints = {
  certificateURL: 'https://s.mzstatic.com/sap/setupCert.plist',
  setupURL: 'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy',
  version: 200,
};

interface Request {
  type: string;
  id: number;
}

class FakeWorker {
  static instances: FakeWorker[] = [];
  static hangOn: string | null = null;
  onmessage: ((event: { data: Record<string, unknown> }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault: () => void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  private exchanges = 0;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage = vi.fn((request: Request) => {
    if (request.type === FakeWorker.hangOn) {
      return;
    }
    const response: Record<string, unknown> = { type: 'result', id: request.id };
    if (request.type === 'initialize') {
      response.contextValue = 123;
    }
    if (request.type === 'exchange') {
      response.state = this.exchanges++ === 0 ? 1 : 0;
      response.output = new Uint8Array([1]).buffer;
    }
    if (request.type === 'sign') {
      response.signature = new Uint8Array([1, 2, 3]).buffer;
    }
    queueMicrotask(() => this.onmessage?.({ data: response }));
  });

  crash() {
    this.onerror?.({ message: 'worker crashed', preventDefault: vi.fn() });
  }
}

describe('SAP worker lifecycle regressions', () => {
  let prepareSigner: typeof import('../../src/apple/sap/client').prepareSigner;

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers();
    FakeWorker.instances = [];
    FakeWorker.hangOn = null;
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    vi.mocked(loadSapAssets).mockResolvedValue({
      commerceKit: new Uint8Array(),
      commerceCore: new Uint8Array(),
      coreFP: new Uint8Array(),
      coreFPICXS: new Uint8Array(),
    });
    vi.mocked(fetchSetupCertificate).mockResolvedValue(new Uint8Array([1]));
    vi.mocked(exchangeSetupBuffer).mockResolvedValue(new Uint8Array([2]));
    ({ prepareSigner } = await import('../../src/apple/sap/client'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reuses the same device signer for a second authentication attempt', async () => {
    const signer = await prepareSigner('aabbccddeeff', endpoints);
    expect(await prepareSigner('aabbccddeeff', endpoints)).toBe(signer);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(await signer.sign(new Uint8Array([42]))).toBe('AQID');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects initialization after a worker crash and allows a fresh setup', async () => {
    FakeWorker.hangOn = 'initialize';
    const setup = prepareSigner('aabbccddeeff', endpoints);
    const rejected = expect(setup).rejects.toThrow('worker crashed');
    await vi.advanceTimersByTimeAsync(0);
    FakeWorker.instances[0].crash();
    await rejected;
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    FakeWorker.hangOn = null;
    const signer = await prepareSigner('aabbccddeeff', endpoints);
    expect(await signer.sign(new Uint8Array([42]))).toBe('AQID');
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('rejects every pending signature after a worker crash', async () => {
    const signer = await prepareSigner('aabbccddeeff', endpoints);
    FakeWorker.hangOn = 'sign';
    const signatures = [signer.sign(new Uint8Array([1])), signer.sign(new Uint8Array([2]))];
    const rejected = signatures.map((signature) => expect(signature).rejects.toThrow('worker crashed'));
    FakeWorker.instances[0].crash();
    await Promise.all(rejected);
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rebuilds the same device signer after an idle worker crashes', async () => {
    const signer = await prepareSigner('aabbccddeeff', endpoints);
    FakeWorker.instances[0].crash();
    expect(await prepareSigner('aabbccddeeff', endpoints)).not.toBe(signer);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('rejects a signature when the worker response cannot be decoded', async () => {
    const signer = await prepareSigner('aabbccddeeff', endpoints);
    FakeWorker.hangOn = 'sign';
    const rejected = expect(signer.sign(new Uint8Array([1]))).rejects.toThrow('could not be decoded');
    FakeWorker.instances[0].onmessageerror?.();
    await rejected;
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });

  it('rejects a stalled signature after two minutes and terminates its worker', async () => {
    const signer = await prepareSigner('aabbccddeeff', endpoints);
    FakeWorker.hangOn = 'sign';
    const rejected = expect(signer.sign(new Uint8Array([1]))).rejects.toThrow('SAP worker sign timed out');
    await vi.advanceTimersByTimeAsync(120_000);
    await rejected;
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });

  it('times out a stalled certificate exchange and allows a fresh setup', async () => {
    let finishCertificate!: (value: Uint8Array) => void;
    vi.mocked(fetchSetupCertificate).mockReturnValueOnce(new Promise((resolve) => {
      finishCertificate = resolve;
    }));
    const rejected = expect(prepareSigner('aabbccddeeff', endpoints)).rejects.toThrow('SAP signer setup timed out');
    await vi.advanceTimersByTimeAsync(120_000);
    await rejected;
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    const signer = await prepareSigner('aabbccddeeff', endpoints);
    finishCertificate(new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(0);
    expect(await prepareSigner('aabbccddeeff', endpoints)).toBe(signer);
  });

  it('terminates the worker when the WASM download fails', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('download failed'));
    await expect(prepareSigner('aabbccddeeff', endpoints)).rejects.toThrow('download failed');
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a failed postMessage and terminates the worker', async () => {
    const signer = await prepareSigner('aabbccddeeff', endpoints);
    FakeWorker.instances[0].postMessage.mockImplementationOnce(() => {
      throw new Error('could not send');
    });
    await expect(signer.sign(new Uint8Array([1]))).rejects.toThrow('could not send');
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('terminates the previous worker when switching device identifiers', async () => {
    await prepareSigner('aabbccddeeff', endpoints);
    await prepareSigner('112233445566', endpoints);
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    expect(FakeWorker.instances).toHaveLength(2);
  });
});
