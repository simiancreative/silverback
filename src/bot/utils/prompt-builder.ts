import { DownloadedFile } from './file-downloader';

/**
 * Combines message text with downloaded file contents into a structured prompt.
 * Pure function with zero overhead when no files are attached.
 */
export function buildPrompt(messageText: string, files: DownloadedFile[]): string {
  const hasText = messageText.trim().length > 0;
  const hasFiles = files && files.length > 0;

  if (!hasFiles) {
    return messageText;
  }

  const fileBlocks = files
    .map((file) => {
      const truncationNote = file.truncated ? '\n[File truncated at size limit]' : '';
      return `<attached_file filename="${file.filename}">\n${file.content}${truncationNote}\n</attached_file>`;
    })
    .join('\n\n');

  if (!hasText) {
    return fileBlocks.trimEnd();
  }

  return `<user_message>\n${messageText}\n</user_message>\n\n${fileBlocks}`.trimEnd();
}
