/** Reassemble deployment-only chunks without changing any measured DEM bytes. */
export async function fetchTerrainAsset(base: string, file: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const files = file === 'pole_dem_60s.bin' ? [`${file}.part0`, `${file}.part1`] : [file];
  const buffers = await Promise.all(files.map(async part => {
    const response = await fetch(`${base}/terrain-data/${part}`, { signal });
    if (!response.ok) throw new Error(`DEM HTTP ${response.status}`);
    return response.arrayBuffer();
  }));
  if (buffers.length === 1) return buffers[0];
  const combined = new Uint8Array(buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0));
  let offset = 0;
  for (const buffer of buffers) { combined.set(new Uint8Array(buffer), offset); offset += buffer.byteLength; }
  return combined.buffer;
}
