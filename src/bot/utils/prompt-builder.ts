import { DownloadedFile, DownloadedImage } from './file-downloader';

/**
 * Combines message text with downloaded file contents and image references into a structured prompt.
 * Pure function with zero overhead when no files or images are attached.
 */
export function buildPrompt(messageText: string, files: DownloadedFile[], images?: DownloadedImage[]): string {
  const hasText = messageText.trim().length > 0;
  const hasFiles = files && files.length > 0;
  const hasImages = images && images.length > 0;

  if (!hasFiles && !hasImages) {
    return messageText;
  }

  const parts: string[] = [];

  if (hasText) {
    parts.push(`<user_message>\n${messageText}\n</user_message>`);
  }

  if (hasFiles) {
    const fileBlocks = files
      .map((file) => {
        const truncationNote = file.truncated ? '\n[File truncated at size limit]' : '';
        return `<attached_file filename="${file.filename}">\n${file.content}${truncationNote}\n</attached_file>`;
      })
      .join('\n\n');
    parts.push(fileBlocks);
  }

  if (hasImages) {
    const imageBlocks = images
      .map((image) => `<attached_image filename="${image.filename}">\nImage file saved at: ${image.localPath}\nPlease read and analyze this image file to understand the visual context provided.\n</attached_image>`)
      .join('\n\n');
    parts.push(imageBlocks);
  }

  return parts.join('\n\n').trimEnd();
}
