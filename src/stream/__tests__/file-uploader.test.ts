import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileUploader } from '../file-uploader';

function createMockSlack() {
  return {
    filesUploadV2: vi.fn().mockResolvedValue({ ok: true }),
    chat: {
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
  } as any;
}

describe('FileUploader', () => {
  let mockSlack: ReturnType<typeof createMockSlack>;
  let uploader: FileUploader;

  beforeEach(() => {
    mockSlack = createMockSlack();
    uploader = new FileUploader(mockSlack);
  });

  it('uploads file with correct parameters', async () => {
    const result = await uploader.uploadAndRewrite({
      channel: 'C123',
      threadTs: '1234567890.123456',
      content: '# Plan\n\nSome content here',
      description: 'Document with 3 sections',
      existingMessageTs: '1234567890.111111',
    });

    expect(result).toBe(true);
    expect(mockSlack.filesUploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: 'C123',
        thread_ts: '1234567890.123456',
        content: '# Plan\n\nSome content here',
        title: 'Claude Response',
        initial_comment: 'Document with 3 sections',
      })
    );
    // Filename should be response-YYYYMMDD-HHmmss.md pattern
    const call = mockSlack.filesUploadV2.mock.calls[0][0];
    expect(call.filename).toMatch(/^response-\d{8}-\d{6}\.md$/);
  });

  it('rewrites existing message after successful upload', async () => {
    await uploader.uploadAndRewrite({
      channel: 'C123',
      threadTs: '1234567890.123456',
      content: 'some content',
      description: 'Mermaid flowchart diagram',
      existingMessageTs: '1234567890.111111',
    });

    expect(mockSlack.chat.update).toHaveBeenCalledWith({
      channel: 'C123',
      ts: '1234567890.111111',
      text: 'Mermaid flowchart diagram\n\n_(full response attached as file above)_',
    });
  });

  it('returns false when file upload fails', async () => {
    mockSlack.filesUploadV2.mockRejectedValue(new Error('Upload failed'));

    const result = await uploader.uploadAndRewrite({
      channel: 'C123',
      threadTs: '1234567890.123456',
      content: 'content',
      description: 'desc',
      existingMessageTs: '1234567890.111111',
    });

    expect(result).toBe(false);
    // chat.update should NOT have been called since upload failed
    expect(mockSlack.chat.update).not.toHaveBeenCalled();
  });

  it('returns false when upload returns ok: false', async () => {
    mockSlack.filesUploadV2.mockResolvedValue({ ok: false, error: 'not_authed' });

    const result = await uploader.uploadAndRewrite({
      channel: 'C123',
      threadTs: '1234567890.123456',
      content: 'content',
      description: 'desc',
      existingMessageTs: '1234567890.111111',
    });

    expect(result).toBe(false);
    expect(mockSlack.chat.update).not.toHaveBeenCalled();
  });

  it('returns false when message update fails but file was uploaded', async () => {
    mockSlack.chat.update.mockRejectedValue(new Error('update_failed'));

    const result = await uploader.uploadAndRewrite({
      channel: 'C123',
      threadTs: '1234567890.123456',
      content: 'content',
      description: 'desc',
      existingMessageTs: '1234567890.111111',
    });

    // File was uploaded but message update failed
    expect(result).toBe(false);
    expect(mockSlack.filesUploadV2).toHaveBeenCalled();
  });

  it('skips message update when existingMessageTs is empty', async () => {
    const result = await uploader.uploadAndRewrite({
      channel: 'C123',
      threadTs: '1234567890.123456',
      content: 'content',
      description: 'desc',
      existingMessageTs: '',
    });

    expect(result).toBe(true);
    expect(mockSlack.filesUploadV2).toHaveBeenCalled();
    expect(mockSlack.chat.update).not.toHaveBeenCalled();
  });
});
