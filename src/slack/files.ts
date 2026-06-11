import type { ImageMediaType, InboundImage } from "../cma/client.js";
import { logger } from "../logger.js";

export interface SlackFile {
  mimetype?: string;
  url_private_download?: string;
  url_private?: string;
  size?: number;
}

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 20;

const SUPPORTED: Record<string, ImageMediaType> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
};

export function isSupportedImageFile(file: SlackFile): boolean {
  return typeof file.mimetype === "string" && file.mimetype in SUPPORTED;
}

export async function downloadSlackImages(
  files: SlackFile[],
  botToken: string,
  fetchFn: typeof fetch,
): Promise<InboundImage[]> {
  const eligible = files
    .filter(isSupportedImageFile)
    .filter((f) => (f.size ?? 0) <= MAX_BYTES);

  if (eligible.length > MAX_IMAGES) {
    logger.warn({ total: eligible.length, cap: MAX_IMAGES }, "too many images; dropping the excess");
  }
  const capped = eligible.slice(0, MAX_IMAGES);

  const out: InboundImage[] = [];
  for (const file of capped) {
    const url = file.url_private_download ?? file.url_private;
    if (!url) continue;
    try {
      const res = await fetchFn(url, { headers: { Authorization: `Bearer ${botToken}` } });
      if (!res.ok) {
        logger.warn({ url, status: res.status }, "slack file download failed");
        continue;
      }
      const data = Buffer.from(await res.arrayBuffer()).toString("base64");
      out.push({ mediaType: SUPPORTED[file.mimetype as string]!, data });
    } catch (err) {
      logger.warn({ err, url }, "slack file download threw");
    }
  }
  return out;
}
