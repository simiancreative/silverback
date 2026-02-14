import { Logger } from '../../logging/logger';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const logger = new Logger('file-downloader');

export interface SlackFileInfo {
  id: string;
  name: string;
  filetype: string;
  mimetype: string;
  url_private_download?: string;
  size: number;
  mode?: string;
}

export interface DownloadedFile {
  filename: string;
  content: string;
  truncated: boolean;
}

export interface DownloadedImage {
  filename: string;
  localPath: string;
  mimetype: string;
}

const TEXT_MIMETYPES = [
  'text/',
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
];

const IMAGE_MIMETYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Download text files from Slack attachments.
 * Only processes text-compatible files up to configured limits.
 */
export async function downloadTextFiles(
  files: SlackFileInfo[],
  botToken: string,
  options?: { maxFileBytes?: number; maxFiles?: number }
): Promise<DownloadedFile[]> {
  const maxFileBytes =
    options?.maxFileBytes ??
    (process.env.MAX_SNIPPET_BYTES ? parseInt(process.env.MAX_SNIPPET_BYTES, 10) : 100 * 1024);
  const maxFiles = options?.maxFiles ?? 5;

  const compatibleFiles = files.filter((file) =>
    TEXT_MIMETYPES.some((type) => file.mimetype.startsWith(type))
  );

  const filesToProcess = compatibleFiles.slice(0, maxFiles);
  const results: DownloadedFile[] = [];

  for (const file of filesToProcess) {
    if (!file.url_private_download) {
      logger.warn('Skipping file without download URL', { filename: file.name });
      continue;
    }

    // SSRF defense: validate hostname
    try {
      const url = new URL(file.url_private_download);
      if (!url.hostname.endsWith('.slack.com')) {
        logger.warn('Skipping file with invalid hostname (SSRF defense)', {
          filename: file.name,
          hostname: url.hostname,
        });
        continue;
      }
    } catch (error) {
      logger.warn('Skipping file with invalid URL', {
        filename: file.name,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    try {
      const response = await fetch(file.url_private_download, {
        headers: {
          Authorization: `Bearer ${botToken}`,
        },
        redirect: 'error',
      });

      if (!response.ok) {
        logger.warn('Failed to download file', {
          filename: file.name,
          status: response.status,
        });
        continue;
      }

      const contentLength = file.size;
      const truncated = contentLength > maxFileBytes;

      // Read up to maxFileBytes
      const arrayBuffer = await response.arrayBuffer();
      const bytesToRead = Math.min(arrayBuffer.byteLength, maxFileBytes);
      const bytes = new Uint8Array(arrayBuffer, 0, bytesToRead);
      const content = new TextDecoder('utf-8').decode(bytes);

      results.push({
        filename: file.name,
        content,
        truncated,
      });

      logger.debug('Downloaded file', {
        filename: file.name,
        size: contentLength,
        truncated,
      });
    } catch (error) {
      logger.warn('Error downloading file', {
        filename: file.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

/**
 * Download image files from Slack attachments to a local directory.
 * Images are saved as binary files that Claude Code can read via its Read tool.
 */
export async function downloadImageFiles(
  files: SlackFileInfo[],
  botToken: string,
  destDir: string,
  options?: { maxFiles?: number }
): Promise<DownloadedImage[]> {
  const maxFiles = options?.maxFiles ?? 5;

  const imageFiles = files.filter((file) =>
    IMAGE_MIMETYPES.includes(file.mimetype)
  );

  const filesToProcess = imageFiles.slice(0, maxFiles);
  const results: DownloadedImage[] = [];

  if (filesToProcess.length === 0) return results;

  // Ensure destination directory exists
  await mkdir(destDir, { recursive: true });

  for (const file of filesToProcess) {
    if (!file.url_private_download) {
      logger.warn('Skipping image without download URL', { filename: file.name });
      continue;
    }

    if (file.size > MAX_IMAGE_BYTES) {
      logger.warn('Skipping image exceeding size limit', {
        filename: file.name,
        size: file.size,
        maxBytes: MAX_IMAGE_BYTES,
      });
      continue;
    }

    // SSRF defense: validate hostname
    try {
      const url = new URL(file.url_private_download);
      if (!url.hostname.endsWith('.slack.com')) {
        logger.warn('Skipping image with invalid hostname (SSRF defense)', {
          filename: file.name,
          hostname: url.hostname,
        });
        continue;
      }
    } catch (error) {
      logger.warn('Skipping image with invalid URL', {
        filename: file.name,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    try {
      const response = await fetch(file.url_private_download, {
        headers: {
          Authorization: `Bearer ${botToken}`,
        },
        redirect: 'error',
      });

      if (!response.ok) {
        logger.warn('Failed to download image', {
          filename: file.name,
          status: response.status,
        });
        continue;
      }

      const arrayBuffer = await response.arrayBuffer();
      const localPath = join(destDir, `${file.id}-${file.name}`);
      await writeFile(localPath, Buffer.from(arrayBuffer));

      results.push({
        filename: file.name,
        localPath,
        mimetype: file.mimetype,
      });

      logger.debug('Downloaded image', {
        filename: file.name,
        size: arrayBuffer.byteLength,
        localPath,
      });
    } catch (error) {
      logger.warn('Error downloading image', {
        filename: file.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}
