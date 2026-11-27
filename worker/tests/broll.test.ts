import { describe, expect, it } from 'vitest';
import { appendBrollAsset, validateBrollMetadata, BrollCatalogAsset } from '../src/broll';

function makeAsset(overrides: Partial<BrollCatalogAsset> = {}): BrollCatalogAsset {
  return {
    id: 'broll_12345',
    key: 'broll/uploads/123/broll_12345/phone.mp4',
    description: 'A person scrolling through a social media feed on a smartphone.',
    tags: ['technology', 'smartphone', 'social media'],
    source_url: 'https://www.pexels.com/video/example',
    license: 'Pexels License; commercial use permitted',
    rights_confirmed: true,
    rights_verified: true,
    ...overrides,
  };
}

function makeBucket(initial?: string): R2Bucket {
  let body = initial;
  let etag = initial ? '"etag-1"' : null;
  let revision = 1;

  return {
    async get() {
      if (body === undefined) return null;
      const storedBody = body;
      const storedEtag = etag;
      return {
        httpEtag: storedEtag!,
        async json<T>() {
          return JSON.parse(storedBody) as T;
        },
      } as unknown as R2ObjectBody;
    },
    async put(
      _key: string,
      value: string | ArrayBuffer | ArrayBufferView | ReadableStream | Blob | null,
      options?: R2PutOptions,
    ) {
      const condition = options?.onlyIf as R2Conditional | undefined;
      if (condition?.etagMatches !== undefined && condition.etagMatches !== etag) return null;
      if (condition?.etagDoesNotMatch === '*' && etag !== null) return null;
      body = typeof value === 'string' ? value : String(value);
      revision += 1;
      etag = '"etag-' + revision + '"';
      return { key: 'broll/catalog.json', httpEtag: etag } as R2Object;
    },
    async head() { return null; },
    async delete() {},
    async list() {
      return { objects: [], truncated: false, delimitedPrefixes: [] };
    },
    async createMultipartUpload() { throw new Error('not used'); },
    async resumeMultipartUpload() { throw new Error('not used'); },
  } as unknown as R2Bucket;
}

describe('B-roll metadata validation', () => {
  it('normalises descriptions, tags and source URLs', () => {
    const metadata = validateBrollMetadata({
      description: '  A person   scrolling through a feed on a phone. ',
      tags: ['Technology', ' smartphone ', 'technology'],
      source_url: 'https://example.com/source',
      license: '  Owned footage; commercial use permitted ',
      rights_confirmed: true,
    });

    expect(metadata.description).toBe('A person scrolling through a feed on a phone.');
    expect(metadata.tags).toEqual(['technology', 'smartphone']);
    expect(metadata.source_url).toBe('https://example.com/source');
    expect(metadata.license).toBe('Owned footage; commercial use permitted');
    expect(metadata.rights_confirmed).toBe(true);
  });

  it('requires explicit usage-rights confirmation', () => {
    expect(() => validateBrollMetadata({
      description: 'A person using a laptop in a modern office.',
      tags: ['business'],
      source_url: 'https://example.com/source',
      license: 'Commercial use permitted under creator licence',
      rights_confirmed: false,
    })).toThrow(/usage rights/);
  });

  it('rejects non-HTTP source URLs and invalid tags', () => {
    const base = {
      description: 'A person using a laptop in a modern office.',
      tags: ['business'],
      source_url: 'javascript:alert(1)',
      license: 'Commercial use permitted under creator licence',
      rights_confirmed: true,
    };
    expect(() => validateBrollMetadata(base)).toThrow(/HTTP or HTTPS/);
    expect(() => validateBrollMetadata({ ...base, source_url: 'https://example.com', tags: ['not/allowed'] })).toThrow(/Tags may contain/);
  });

  it('limits description, tag and licence lengths', () => {
    expect(() => validateBrollMetadata({
      description: 'too short',
      tags: ['business'],
      source_url: 'https://example.com/source',
      license: 'Valid commercial-use licence',
      rights_confirmed: true,
    })).toThrow(/Description/);
    expect(() => validateBrollMetadata({
      description: 'A person using a laptop in a modern office.',
      tags: ['business'],
      source_url: 'https://example.com/source',
      license: 'short',
      rights_confirmed: true,
    })).toThrow(/Licence/);
  });
});

describe('B-roll catalogue updates', () => {
  it('creates the first catalogue and appends further assets without overwriting', async () => {
    const bucket = makeBucket();
    expect(await appendBrollAsset(bucket, makeAsset())).toBe(1);
    expect(await appendBrollAsset(bucket, makeAsset({
      id: 'broll_67890',
      key: 'broll/uploads/123/broll_67890/meeting.mp4',
      description: 'A team meeting around a table in a bright office.',
      tags: ['business', 'meeting'],
    }))).toBe(2);

    const stored = await bucket.get('broll/catalog.json');
    const catalog = await stored!.json<{ assets: BrollCatalogAsset[] }>();
    expect(catalog.assets).toHaveLength(2);
    expect(catalog.assets[0].rights_verified).toBe(true);
    expect(catalog.assets[1].key).toContain('broll/uploads/');
  });

  it('treats a repeated publish as idempotent', async () => {
    const bucket = makeBucket();
    const asset = makeAsset();
    expect(await appendBrollAsset(bucket, asset)).toBe(1);
    expect(await appendBrollAsset(bucket, asset)).toBe(1);
  });

  it('rejects objects outside the B-roll upload prefix', async () => {
    await expect(appendBrollAsset(
      makeBucket(),
      makeAsset({ key: 'uploads/123/source.mp4' }),
    )).rejects.toThrow(/broll\/uploads/);
  });

  it('does not overwrite a malformed existing catalogue', async () => {
    await expect(appendBrollAsset(makeBucket('{broken'), makeAsset()))
      .rejects.toThrow(/invalid JSON/);
  });
});
