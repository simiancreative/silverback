import { describe, it, expect } from 'vitest';
import { isThreadReviewRequest, extractReviewInstruction, buildThreadReviewPrompt } from '../thread-review';
import { ThreadMessage } from '../thread-fetcher';
import { DownloadedFile, DownloadedImage } from '../file-downloader';

describe('isThreadReviewRequest', () => {
  it('returns true for "review this thread"', () => {
    expect(isThreadReviewRequest('review this thread')).toBe(true);
  });

  it('returns true for "review the messages in this thread"', () => {
    expect(isThreadReviewRequest('review the messages in this thread')).toBe(true);
  });

  it('returns true for "Please review the thread"', () => {
    expect(isThreadReviewRequest('Please review the thread')).toBe(true);
  });

  it('returns true for "review thread"', () => {
    expect(isThreadReviewRequest('review thread')).toBe(true);
  });

  it('returns true case-insensitively', () => {
    expect(isThreadReviewRequest('REVIEW THIS THREAD')).toBe(true);
    expect(isThreadReviewRequest('Review The Thread')).toBe(true);
  });

  it('returns false for "review my PR"', () => {
    expect(isThreadReviewRequest('review my PR')).toBe(false);
  });

  it('returns false when "review" is absent', () => {
    expect(isThreadReviewRequest('what is this thread about')).toBe(false);
  });

  it('returns false for "review the code"', () => {
    expect(isThreadReviewRequest('review the code')).toBe(false);
  });

  it('returns false when "thread" comes before "review"', () => {
    expect(isThreadReviewRequest('the thread needs a review')).toBe(false);
  });
});

describe('extractReviewInstruction', () => {
  const DEFAULT =
    'Review the conversation in the thread transcript below. Provide a concise summary of the discussion, the key decisions made, any open questions, and any action items or next steps.';

  it('returns default when input is just "review this thread"', () => {
    expect(extractReviewInstruction('review this thread')).toBe(DEFAULT);
  });

  it('returns default for "Please review the thread"', () => {
    expect(extractReviewInstruction('Please review the thread')).toBe(DEFAULT);
  });

  it('returns default for "review thread"', () => {
    expect(extractReviewInstruction('review thread')).toBe(DEFAULT);
  });

  it('returns default for "review messages in this thread"', () => {
    expect(extractReviewInstruction('review messages in this thread')).toBe(DEFAULT);
  });

  it('returns verbatim text when extra instruction is present', () => {
    const input = 'review this thread and list the open questions';
    expect(extractReviewInstruction(input)).toBe(input);
  });

  it('returns verbatim text when substantial extra text follows trigger', () => {
    const input = 'review the thread focusing on the architecture decisions and any blockers mentioned';
    expect(extractReviewInstruction(input)).toBe(input);
  });
});

describe('buildThreadReviewPrompt', () => {
  const messages: ThreadMessage[] = [
    {
      userId: 'U001',
      username: 'alice',
      isBot: false,
      text: 'Hello everyone, let us discuss the plan.',
      ts: '1700000001.000100',
      files: [],
    },
    {
      userId: 'U002',
      username: 'bob',
      isBot: false,
      text: 'I think we should go with option A.',
      ts: '1700000002.000200',
      files: [],
    },
    {
      userId: '',
      username: 'claude-bot',
      isBot: true,
      text: 'Here is my analysis of option A.',
      ts: '1700000003.000300',
      files: [],
    },
  ];

  const files: DownloadedFile[] = [
    {
      filename: 'notes.txt',
      content: 'Meeting notes content here',
      truncated: false,
    },
  ];

  const images: DownloadedImage[] = [
    {
      filename: 'diagram.png',
      localPath: '/tmp/slack-images-abc/F123-diagram.png',
      mimetype: 'image/png',
    },
  ];

  it('includes <task> block with the instruction', () => {
    const prompt = buildThreadReviewPrompt({ instruction: 'Summarize this.', messages, files: [], images: [] });
    expect(prompt).toContain('<task>\nSummarize this.\n</task>');
  });

  it('includes <thread_transcript> block', () => {
    const prompt = buildThreadReviewPrompt({ instruction: 'Summarize.', messages, files: [], images: [] });
    expect(prompt).toContain('<thread_transcript>');
    expect(prompt).toContain('</thread_transcript>');
  });

  it('includes author labels for human messages', () => {
    const prompt = buildThreadReviewPrompt({ instruction: 'Summarize.', messages, files: [], images: [] });
    expect(prompt).toContain('[alice]: Hello everyone');
    expect(prompt).toContain('[bob]: I think we should go with option A.');
  });

  it('marks bot messages with (bot) suffix', () => {
    const prompt = buildThreadReviewPrompt({ instruction: 'Summarize.', messages, files: [], images: [] });
    expect(prompt).toContain('[claude-bot (bot)]: Here is my analysis');
  });

  it('includes attached file block', () => {
    const prompt = buildThreadReviewPrompt({ instruction: 'Summarize.', messages, files, images: [] });
    expect(prompt).toContain('<attached_file filename="notes.txt">');
    expect(prompt).toContain('Meeting notes content here');
    expect(prompt).toContain('</attached_file>');
  });

  it('includes truncation note when file is truncated', () => {
    const truncatedFiles: DownloadedFile[] = [
      { filename: 'big.txt', content: 'partial content', truncated: true },
    ];
    const prompt = buildThreadReviewPrompt({ instruction: 'Summarize.', messages, files: truncatedFiles, images: [] });
    expect(prompt).toContain('[File truncated at size limit]');
  });

  it('includes attached image block pointing at localPath', () => {
    const prompt = buildThreadReviewPrompt({ instruction: 'Summarize.', messages, files: [], images });
    expect(prompt).toContain('<attached_image filename="diagram.png">');
    expect(prompt).toContain('/tmp/slack-images-abc/F123-diagram.png');
    expect(prompt).toContain('</attached_image>');
  });

  it('skips thinking placeholder messages', () => {
    const msgsWithPlaceholder: ThreadMessage[] = [
      ...messages,
      {
        userId: '',
        username: 'bot',
        isBot: true,
        text: 'Claude is thinking...',
        ts: '1700000004.000400',
        files: [],
      },
      {
        userId: '',
        username: 'bot',
        isBot: true,
        text: '_Claude is thinking..._',
        ts: '1700000005.000500',
        files: [],
      },
    ];
    const prompt = buildThreadReviewPrompt({ instruction: 'Summarize.', messages: msgsWithPlaceholder, files: [], images: [] });
    expect(prompt).not.toContain('Claude is thinking...');
  });

  it('appends [attached: filename] marker when message has files', () => {
    const msgsWithFile: ThreadMessage[] = [
      {
        userId: 'U001',
        username: 'alice',
        isBot: false,
        text: 'Check this out',
        ts: '1700000001.000100',
        files: [{ id: 'F1', name: 'report.pdf', filetype: 'pdf', mimetype: 'application/pdf', size: 1024 }],
      },
    ];
    const prompt = buildThreadReviewPrompt({ instruction: 'Summarize.', messages: msgsWithFile, files: [], images: [] });
    expect(prompt).toContain('[attached: report.pdf]');
  });

  it('produces no file or image section when both are empty', () => {
    const prompt = buildThreadReviewPrompt({ instruction: 'Summarize.', messages, files: [], images: [] });
    expect(prompt).not.toContain('<attached_file');
    expect(prompt).not.toContain('<attached_image');
  });
});
