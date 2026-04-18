export async function fetchCamSnapshot(): Promise<Buffer> {
  const frigateUrl = process.env['FRIGATE_URL'];
  const coopCam = process.env['FRIGATE_COOP_CAM'];
  if (!frigateUrl || !coopCam) throw new Error('FRIGATE_URL / FRIGATE_COOP_CAM not configured');
  const url = `${frigateUrl}/api/${coopCam}/latest.jpg`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`Frigate snapshot fetch failed: ${resp.status} ${resp.statusText}`);
  return Buffer.from(await resp.arrayBuffer());
}
