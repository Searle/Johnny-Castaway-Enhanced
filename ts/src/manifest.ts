// Shape of anim/manifest.json produced by tools/tsextract.

export interface ManifestSprite {
  file: string;
  w: number;
  h: number;
}

export interface ManifestSheet {
  name: string; // e.g. "MJJOG1.BMP" or "ISLETEMP.SCR"
  sprites: ManifestSprite[];
}

export interface Op {
  op: number;
  args?: number[];
  str?: string;
}

export interface Manifest {
  ttm: string;
  palette: string[]; // 16 CSS colors, indexed by color index & 0x0f
  screens?: ManifestSheet[];
  sheets: ManifestSheet[];
  ops: Op[];
}

// A decoded sheet with its sprite frames loaded as ImageBitmaps, indexed by
// the same sprite number the TTM opcodes use.
export interface LoadedSheet {
  name: string;
  frames: ImageBitmap[];
}

// index.json (from `tsextract -all`): the catalog the scene browser lists.
export interface IndexEntry {
  name: string; // "MJJOG.TTM"
  dir: string; // subdir under the anim root
  tags: number[]; // scene entry tags
  defaultTag: number; // first tag that draws (skips bootstrap tags)
  sheets: number;
}
export interface AdsIndexEntry {
  name: string; // "MARY.ADS"
  dir: string;
  tags: number[]; // ADS entry tags (scene sequences)
}

export interface AnimIndex {
  ttms: IndexEntry[];
  ads: AdsIndexEntry[];
  skipped?: string[];
}

// ads/<NAME>/ads.json: the slot→TTM map and decoded ADS bytecode.
export interface AdsRes {
  id: number; // TTM slot id
  name: string; // TTM resource name
}
export interface AdsFile {
  name: string;
  res: AdsRes[];
  ops: Op[];
}

export function loadAdsFile(baseUrl: string, dir: string): Promise<AdsFile> {
  return fetch(`${baseUrl}/ads/${dir}/ads.json`).then((r) => {
    if (!r.ok) throw new Error(`ads/${dir}/ads.json: HTTP ${r.status}`);
    return r.json();
  });
}

export function loadIndex(baseUrl: string): Promise<AnimIndex> {
  return fetch(`${baseUrl}/index.json`).then((r) => {
    if (!r.ok) throw new Error(`index.json: HTTP ${r.status}`);
    return r.json();
  });
}

// Load the manifest and every referenced PNG (screens + sprite sheets) as
// ImageBitmaps, keyed by uppercase resource name.
export async function loadAnimation(
  baseUrl: string,
): Promise<{ manifest: Manifest; sheets: Map<string, LoadedSheet> }> {
  const manifest: Manifest = await fetch(`${baseUrl}/manifest.json`).then((r) => {
    if (!r.ok) throw new Error(`manifest.json: HTTP ${r.status}`);
    return r.json();
  });

  const sheets = new Map<string, LoadedSheet>();
  const allSheets = [...(manifest.screens ?? []), ...manifest.sheets];

  await Promise.all(
    allSheets.map(async (sheet) => {
      const frames = await Promise.all(
        sheet.sprites.map(async (s) => {
          const blob = await fetch(`${baseUrl}/${s.file}`).then((r) => {
            if (!r.ok) throw new Error(`${s.file}: HTTP ${r.status}`);
            return r.blob();
          });
          return createImageBitmap(blob);
        }),
      );
      sheets.set(sheet.name.toUpperCase(), { name: sheet.name, frames });
    }),
  );

  return { manifest, sheets };
}
