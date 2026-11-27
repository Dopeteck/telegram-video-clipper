import { describe, expect, it, vi } from 'vitest';
import { appendBrollAsset } from '../src/broll';

function mockBucket(initial: string | null = null) {
  let payload = initial;
  let revision = 0;

  const get = vi.fn(async () => {
    // Capture before yielding so parallel appenders can both observe the same
    // revision and exercise the conditional-write retry path.
    const snapshot = payload;
    const snapshotRevision = revision;
    await Promise.resolve();
    if (snapshot === null) return null;
    return {
      etag: 'etag-' + snapshotRevision,
      text: async () => snapshot,
    } as unknown as R2ObjectBody;
  });

  const put = vi.fn(async (_key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream | Blob | null, options?: R2PutOptions) => {
    const onlyIf = options?.onlyIf as R2Conditional | undefined;
    if (onlyIf?.etagMatches && onlyIf.etagMatches !== 'etag-' + revision) return null;
    if (onlyIf?.etagDoesNotMatch === '*' && payload !== null) return null;
    payload = String(value);
    revision += 1;
    return { etag: 'etag-' + revision } as unknown as R2Object;
  });

  return {
    bucket: { get, put } as unknown as R2Bucket,
    get,
    put,
    read: () => payload,
  };
}

const asset = (id: string) => ({
  id,
  key: 'broll/uploads/123/' + id + '.mp4',
  description: 'A sample B-roll clip',
  tags: ['sample'],
  source_url: 'https://example.com/source',
  license: 'Permission confirmed',
  rights_verified: true,
});

describe('appendBrollAsset', () => {
  it('creates the catalogue when it does not exist', async () => {
    const store = mockBucket();
    await expect(appendBrollAsset(store.bucket, asset('one'))).resolves.toBe(1);
    expect(JSON.parse(store.read()!).assets).toHaveLength(1);
    expect(store.put).toHaveBeenCalledWith(
      'broll/catalog.json',
      expect.any(String),
      expect.objectContaining({ onlyIf: { etagDoesNotMatch: '*' } }),
    );
  });

  it('appends to an existing catalogue without discarding prior assets', async () => {
    const store = mockBucket(JSON.stringify({ assets: [asset('existing')] }));
    await expect(appendBrollAsset(store.bucket, asset('new'))).resolves.toBe(2);
    expect(JSON.parse(store.read()!).assets.map((row: { id: string }) => row.id)).toEqual(['existing', 'new']);
  });

  it('preserves both assets when two uploads finish concurrently', async () => {
    const store = mockBucket(JSON.stringify({ assets: [] }));
    const counts = await Promise.all([
      appendBrollAsset(store.bucket, asset('first')),
      appendBrollAsset(store.bucket, asset('second')),
    ]);
    const ids = JSON.parse(store.read()!).assets.map((row: { id: string }) => row.id).sort();
    expect(ids).toEqual(['first', 'second']);
    expect(counts.sort()).toEqual([1, 2]);
    expect(store.put).toHaveBeenCalledTimes(3);
  });

  it('rejects an invalid existing catalogue rather than overwriting it', async () => {
    const store = mockBucket('not-json');
    await expect(appendBrollAsset(store.bucket, asset('new'))).rejects.toThrow('not valid JSON');
    expect(store.put).not.toHaveBeenCalled();
  });
});
