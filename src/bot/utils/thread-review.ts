import { ThreadMessage } from './thread-fetcher';
import { DownloadedFile, DownloadedImage } from './file-downloader';

const THINKING_PLACEHOLDERS = [
  'Claude is thinking...',
  '_Claude is thinking..._',
];

const DEFAULT_REVIEW_INSTRUCTION =
  'Review the conversation in the thread transcript below. Provide a concise summary of the discussion, the key decisions made, any open questions, and any action items or next steps.';

/**
 * Detects a thread review request. Matches "review" appearing before "thread"
 * in the text, case-insensitive.
 */
export function isThreadReviewRequest(text: string): boolean {
  return /\breview\b[\s\S]*\bthread\b/i.test(text);
}

/**
 * Extracts the user's review instruction from the trigger message.
 * If the text is essentially just the trigger phrase, returns the default instruction.
 */
export function extractReviewInstruction(text: string): string {
  const trimmed = text.trim();

  // Remove mention tags (caller may not have stripped them yet)
  const withoutMentions = trimmed.replace(/<@[A-Z0-9]+>/gi, '').trim();

  // Strip the trigger words ("review", "this", "the", "messages", "in", "thread")
  // along with common filler words, then count what's left
  const withoutTrigger = withoutMentions
    .replace(/\breview\b/gi, '')
    .replace(/\bthread\b/gi, '')
    .replace(/\bthis\b/gi, '')
    .replace(/\bthe\b/gi, '')
    .replace(/\bmessages\b/gi, '')
    .replace(/\bin\b/gi, '')
    .replace(/\bplease\b/gi, '')
    .replace(/[.,!?;:]/g, '')
    .trim();

  // Count non-whitespace word characters remaining
  const remainingWords = withoutTrigger.match(/\w+/g) ?? [];
  if (remainingWords.length <= 3) {
    return DEFAULT_REVIEW_INSTRUCTION;
  }

  return withoutMentions;
}

/**
 * Builds the full prompt for a thread review request.
 */
export function buildThreadReviewPrompt(opts: {
  instruction: string;
  messages: ThreadMessage[];
  files: DownloadedFile[];
  images: DownloadedImage[];
}): string {
  const { instruction, messages, files, images } = opts;

  const parts: string[] = [];

  // Task block
  parts.push(`<task>\n${instruction}\n</task>`);

  // Thread transcript
  const transcriptLines: string[] = [];
  for (const msg of messages) {
    // Skip bot thinking placeholders
    if (THINKING_PLACEHOLDERS.includes(msg.text.trim())) {
      continue;
    }

    const botSuffix = msg.isBot ? ' (bot)' : '';
    const label = `[${msg.username}${botSuffix}]`;

    let line = `${label}: ${msg.text}`;

    if (msg.files.length > 0) {
      const names = msg.files.map((f) => f.name).join(', ');
      line += ` [attached: ${names}]`;
    }

    transcriptLines.push(line);
  }
  parts.push(`<thread_transcript>\n${transcriptLines.join('\n')}\n</thread_transcript>`);

  // Attached text files
  if (files.length > 0) {
    const fileBlocks = files
      .map((file) => {
        const truncationNote = file.truncated ? '\n[File truncated at size limit]' : '';
        return `<attached_file filename="${file.filename}">\n${file.content}${truncationNote}\n</attached_file>`;
      })
      .join('\n\n');
    parts.push(fileBlocks);
  }

  // Attached images
  if (images.length > 0) {
    const imageBlocks = images
      .map(
        (image) =>
          `<attached_image filename="${image.filename}">\nImage file saved at: ${image.localPath}\nPlease read and analyze this image file to understand the visual context provided.\n</attached_image>`,
      )
      .join('\n\n');
    parts.push(imageBlocks);
  }

  return parts.join('\n\n').trimEnd();
}
