export interface BrollMetadataInput {
  description: string;
  tags: string[];
  source_url: string;
  license: string;
  rights_confirmed: boolean;
}

export interface BrollCatalogAsset extends BrollMetadataInput {
  id: string;
  key: string;
  rights_verified: true;
}

function normaliseWhitespace(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

export function validateBrollMetadata(input: unknown): Omit<BrollCatalogAsset, "id" | "key" | "rights_verified"> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("B-roll metadata must be an object.");
  }

  const row = input as Record<string, unknown>;
  const description = normaliseWhitespace(row.description);
  if (description.length < 12 || description.length > 500) {
    throw new Error("Description must be between 12 and 500 characters.");
  }

  if (!Array.isArray(row.tags)) {
    throw new Error("Tags must be a list.");
  }
  const tags = [...new Set(row.tags.map((tag) => normaliseWhitespace(tag).toLowerCase()).filter(Boolean))];
  if (tags.length < 1 || tags.length > 12) {
    throw new Error("Add between 1 and 12 tags.");
  }
  if (tags.some((tag) => tag.length > 32 || !/^[a-z0-9][a-z0-9 -]*$/.test(tag))) {
    throw new Error("Tags may contain letters, numbers, spaces and hyphens only (32 characters max).");
  }

  const source_url = normaliseWhitespace(row.source_url);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(source_url);
  } catch {
    throw new Error("Enter the original source webpage URL.");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol) || !parsedUrl.hostname.includes(".")) {
    throw new Error("Source URL must be an HTTP or HTTPS webpage.");
  }

  const license = normaliseWhitespace(row.license);
  if (license.length < 8 || license.length > 300) {
    throw new Error("Licence details must be between 8 and 300 characters.");
  }

  if (row.rights_confirmed !== true) {
    throw new Error("Confirm that you checked the footage's usage rights before publishing.");
  }

  return {
    description,
    tags,
    source_url: parsedUrl.toString(),
    license,
    rights_confirmed: true,
  };
}

export async function appendBrollAsset(
  bucket: R2Bucket,
  asset: BrollCatalogAsset,
  catalogKey = "broll/catalog.json",
  retries = 5,
): Promise<number> {
  if (!asset.key.startsWith("broll/uploads/")) {
    throw new Error("B-roll asset key must be inside broll/uploads/.");
  }
  if (asset.rights_verified !== true) {
    throw new Error("B-roll asset must have confirmed usage rights.");
  }

  for (let attempt = 0; attempt < retries; attempt += 1) {
    const current = await bucket.get(catalogKey);
    let catalog: { assets: Array<Record<string, unknown>> } = { assets: [] };

    if (current) {
      try {
        const parsed = await current.json<{ assets?: unknown }>();
        if (!parsed || !Array.isArray(parsed.assets)) {
          throw new Error("B-roll catalogue must contain an assets array.");
        }
        catalog = { assets: parsed.assets as Array<Record<string, unknown>> };
      } catch (error) {
        if (error instanceof Error && error.message.includes("B-roll catalogue")) throw error;
        throw new Error("broll/catalog.json contains invalid JSON. Fix it before publishing another asset.");
      }
    }

    const duplicate = catalog.assets.find((row) => row?.id === asset.id || row?.key === asset.key);
    if (duplicate) {
      if (duplicate.id === asset.id && duplicate.key === asset.key) return catalog.assets.length;
      throw new Error("This B-roll asset ID or R2 key is already registered.");
    }

    const next = { assets: [...catalog.assets, asset] };
    const options: R2PutOptions = {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      onlyIf: current
        ? { etagMatches: current.httpEtag }
        : { etagDoesNotMatch: "*" },
    };

    const saved = await bucket.put(catalogKey, JSON.stringify(next, null, 2) + "\n", options);
    if (saved) return next.assets.length;
  }

  throw new Error("The B-roll catalogue changed repeatedly. Please retry publishing.");
}
