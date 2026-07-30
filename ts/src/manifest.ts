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
