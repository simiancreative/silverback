import { describe, it, expect, vi, beforeEach } from 'vitest';
import { downloadTextFiles, SlackFileInfo } from '../file-downloader';

function createMockFile(overrides: Partial<SlackFileInfo> = {}): SlackFileInfo {
  return {
    id: 'F123',
    name: 'test.txt',
    filetype: 'txt',
    mimetype: 'text/plain',
    url_private_download: 'https://files.slack.com/files-pri/T123/F123/test.txt',
    size: 100,
    ...overrides,
  };
}

describe('downloadTextFiles', () => {
  const mockFetch = vi.fn();
  const botToken = 'xoxb-test-token';

  beforeEach(() => {
    global.fetch = mockFetch;
    mockFetch.mockReset();
  });

  it('downloads a text file successfully', async () => {
    const file = createMockFile();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode('file content').buffer),
    });

    const results = await downloadTextFiles([file], botToken);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      filename: 'test.txt',
      content: 'file content',
      truncated: false,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://files.slack.com/files-pri/T123/F123/test.txt',
      {
        headers: {
          Authorization: 'Bearer xoxb-test-token',
        },
        redirect: 'error',
      }
    );
  });

  it('filters out non-text files', async () => {
    const files = [
      createMockFile({ id: 'F1', mimetype: 'image/png', name: 'image.png' }),
      createMockFile({ id: 'F2', mimetype: 'video/mp4', name: 'video.mp4' }),
      createMockFile({ id: 'F3', mimetype: 'application/pdf', name: 'doc.pdf' }),
    ];

    const results = await downloadTextFiles(files, botToken);

    expect(results).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('truncates file larger than maxFileBytes and marks it', async () => {
    const largeContent = 'x'.repeat(200 * 1024); // 200KB
    const file = createMockFile({ size: 200 * 1024 });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(largeContent).buffer),
    });

    const results = await downloadTextFiles([file], botToken, { maxFileBytes: 100 * 1024 });

    expect(results).toHaveLength(1);
    expect(results[0].truncated).toBe(true);
    expect(results[0].content.length).toBeLessThanOrEqual(100 * 1024);
  });

  it('skips file gracefully when fetch returns non-ok status', async () => {
    const file = createMockFile();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const results = await downloadTextFiles([file], botToken);

    expect(results).toHaveLength(0);
  });

  it('returns empty array when files array is empty', async () => {
    const results = await downloadTextFiles([], botToken);

    expect(results).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('downloads multiple text files and respects maxFiles limit', async () => {
    const files = [
      createMockFile({ id: 'F1', name: 'file1.txt' }),
      createMockFile({ id: 'F2', name: 'file2.json', mimetype: 'application/json' }),
      createMockFile({ id: 'F3', name: 'file3.xml', mimetype: 'application/xml' }),
      createMockFile({ id: 'F4', name: 'file4.txt' }),
      createMockFile({ id: 'F5', name: 'file5.txt' }),
      createMockFile({ id: 'F6', name: 'file6.txt' }),
    ];

    mockFetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode('content').buffer),
      })
    );

    const results = await downloadTextFiles(files, botToken, { maxFiles: 3 });

    expect(results).toHaveLength(3);
    expect(results[0].filename).toBe('file1.txt');
    expect(results[1].filename).toBe('file2.json');
    expect(results[2].filename).toBe('file3.xml');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('skips file with non-slack.com hostname (SSRF defense)', async () => {
    const file = createMockFile({
      url_private_download: 'https://evil.com/malicious.txt',
    });

    const results = await downloadTextFiles([file], botToken);

    expect(results).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips file without url_private_download', async () => {
    const file = createMockFile({ url_private_download: undefined });

    const results = await downloadTextFiles([file], botToken);

    expect(results).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('continues processing after download failure', async () => {
    const files = [
      createMockFile({ id: 'F1', name: 'file1.txt' }),
      createMockFile({ id: 'F2', name: 'file2.txt' }),
    ];

    mockFetch
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode('success').buffer),
      });

    const results = await downloadTextFiles(files, botToken);

    expect(results).toHaveLength(1);
    expect(results[0].filename).toBe('file2.txt');
    expect(results[0].content).toBe('success');
  });

  it('accepts yaml files as text-compatible', async () => {
    const files = [
      createMockFile({ name: 'config.yaml', mimetype: 'application/yaml' }),
      createMockFile({ name: 'data.yml', mimetype: 'application/x-yaml' }),
    ];

    mockFetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode('key: value').buffer),
      })
    );

    const results = await downloadTextFiles(files, botToken);

    expect(results).toHaveLength(2);
  });

  it('uses default maxFileBytes from env when not provided', async () => {
    const originalEnv = process.env.MAX_SNIPPET_BYTES;
    process.env.MAX_SNIPPET_BYTES = '50000';

    const largeContent = 'x'.repeat(60000);
    const file = createMockFile({ size: 60000 });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(largeContent).buffer),
    });

    const results = await downloadTextFiles([file], botToken);

    expect(results[0].truncated).toBe(true);
    expect(results[0].content.length).toBeLessThanOrEqual(50000);

    process.env.MAX_SNIPPET_BYTES = originalEnv;
  });

  it('skips file with invalid URL format', async () => {
    const file = createMockFile({ url_private_download: 'not-a-valid-url' });

    const results = await downloadTextFiles([file], botToken);

    expect(results).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
