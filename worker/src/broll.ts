const BROLL_CATALOG_KEY = 'broll/catalog.json';

export async function appendBrollAsset(
  bucket: R2Bucket,
  asset: Record<string, unknown>,
  maxAttempts = 5,
): Promise<number> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const current = await bucket.get(BROLL_CATALOG_KEY);
    let assets: Array<Record<string, unknown>> = [];
    const onlyIf: R2Conditional = current
      ? { etagMatches: current.etag }
      : { etagDoesNotMatch: '*' };

    if (current) {
      let catalogue: unknown;
      try {
        catalogue = JSON.parse(await current.text());
      } catch {
        throw new Error('The existing B-roll catalogue is not valid JSON.');
      }
      if (!catalogue || typeof catalogue !== 'object' || !Array.isArray((catalogue as { assets?: unknown }).assets)) {
        throw new Error('The existing B-roll catalogue has an invalid format.');
      }
      assets = (catalogue as { assets: Array<Record<string, unknown>> }).assets;
    }

    const saved = await bucket.put(
      BROLL_CATALOG_KEY,
      JSON.stringify({ assets: [...assets, asset] }, null, 2),
      {
        onlyIf,
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
      },
    );

    // Conditional writes are atomic in R2. A null result means another upload
    // updated the catalogue after our read; reload and append again.
    if (saved !== null) return assets.length + 1;
  }

  throw new Error('The B-roll catalogue is busy with other uploads. Please retry.');
}
