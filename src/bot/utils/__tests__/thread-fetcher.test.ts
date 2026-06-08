import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchThreadMessages } from '../thread-fetcher';

function makeClient(repliesMock: ReturnType<typeof vi.fn>, userInfoMock: ReturnType<typeof vi.fn>) {
  return {
    conversations: { replies: repliesMock },
    users: { info: userInfoMock },
  } as any;
}

const CHANNEL = 'C123';
const THREAD_TS = '1700000000.000100';

describe('fetchThreadMessages', () => {
  let repliesMock: ReturnType<typeof vi.fn>;
  let userInfoMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    repliesMock = vi.fn();
    userInfoMock = vi.fn();
  });

  it('returns messages in chronological order', async () => {
    repliesMock.mockResolvedValueOnce({
      messages: [
        { ts: '1700000001.000100', text: 'first', user: 'U001' },
        { ts: '1700000002.000200', text: 'second', user: 'U002' },
      ],
      response_metadata: {},
    });

    userInfoMock.mockResolvedValue({
      user: { profile: { display_name: 'Alice', real_name: 'Alice Smith' }, name: 'alice' },
    });

    const client = makeClient(repliesMock, userInfoMock);
    const messages = await fetchThreadMessages(client, CHANNEL, THREAD_TS);

    expect(messages).toHaveLength(2);
    expect(messages[0].text).toBe('first');
    expect(messages[1].text).toBe('second');
  });

  it('paginates using next_cursor until exhausted', async () => {
    repliesMock
      .mockResolvedValueOnce({
        messages: [
          { ts: '1700000001.000100', text: 'page1-msg1', user: 'U001' },
        ],
        response_metadata: { next_cursor: 'cursor-abc' },
      })
      .mockResolvedValueOnce({
        messages: [
          { ts: '1700000002.000200', text: 'page2-msg1', user: 'U001' },
        ],
        response_metadata: {},
      });

    userInfoMock.mockResolvedValue({
      user: { profile: { display_name: 'Alice' }, name: 'alice' },
    });

    const client = makeClient(repliesMock, userInfoMock);
    const messages = await fetchThreadMessages(client, CHANNEL, THREAD_TS);

    expect(messages).toHaveLength(2);
    expect(messages[0].text).toBe('page1-msg1');
    expect(messages[1].text).toBe('page2-msg1');

    // Second call should include the cursor
    expect(repliesMock).toHaveBeenCalledTimes(2);
    expect(repliesMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'cursor-abc' }));
  });

  it('caches username resolution: users.info called once per unique userId', async () => {
    repliesMock.mockResolvedValueOnce({
      messages: [
        { ts: '1700000001.000100', text: 'msg1', user: 'U001' },
        { ts: '1700000002.000200', text: 'msg2', user: 'U001' },
        { ts: '1700000003.000300', text: 'msg3', user: 'U002' },
      ],
      response_metadata: {},
    });

    userInfoMock.mockResolvedValue({
      user: { profile: { display_name: 'Alice' }, name: 'alice' },
    });

    const client = makeClient(repliesMock, userInfoMock);
    await fetchThreadMessages(client, CHANNEL, THREAD_TS);

    // U001 appears twice but should only be fetched once; U002 fetched once = 2 total
    expect(userInfoMock).toHaveBeenCalledTimes(2);
    expect(userInfoMock).toHaveBeenCalledWith({ user: 'U001' });
    expect(userInfoMock).toHaveBeenCalledWith({ user: 'U002' });
  });

  it('detects bot messages by bot_id property', async () => {
    repliesMock.mockResolvedValueOnce({
      messages: [
        { ts: '1700000001.000100', text: 'bot reply', bot_id: 'B001', username: 'my-bot' },
      ],
      response_metadata: {},
    });

    const client = makeClient(repliesMock, userInfoMock);
    const messages = await fetchThreadMessages(client, CHANNEL, THREAD_TS);

    expect(messages).toHaveLength(1);
    expect(messages[0].isBot).toBe(true);
    expect(messages[0].username).toBe('my-bot');
    // users.info should NOT be called for bot messages
    expect(userInfoMock).not.toHaveBeenCalled();
  });

  it('detects bot messages by subtype === bot_message', async () => {
    repliesMock.mockResolvedValueOnce({
      messages: [
        { ts: '1700000001.000100', text: 'bot msg', subtype: 'bot_message', username: 'workflow-bot' },
      ],
      response_metadata: {},
    });

    const client = makeClient(repliesMock, userInfoMock);
    const messages = await fetchThreadMessages(client, CHANNEL, THREAD_TS);

    expect(messages[0].isBot).toBe(true);
    expect(messages[0].username).toBe('workflow-bot');
  });

  it('falls back to userId when users.info fails, without throwing', async () => {
    repliesMock.mockResolvedValueOnce({
      messages: [
        { ts: '1700000001.000100', text: 'hello', user: 'U999' },
      ],
      response_metadata: {},
    });

    userInfoMock.mockRejectedValueOnce(new Error('user_not_found'));

    const client = makeClient(repliesMock, userInfoMock);
    const messages = await fetchThreadMessages(client, CHANNEL, THREAD_TS);

    expect(messages).toHaveLength(1);
    expect(messages[0].username).toBe('U999');
    expect(messages[0].userId).toBe('U999');
  });

  it('extracts files array from messages', async () => {
    const file = { id: 'F1', name: 'doc.txt', filetype: 'text', mimetype: 'text/plain', size: 100 };
    repliesMock.mockResolvedValueOnce({
      messages: [
        { ts: '1700000001.000100', text: 'see attached', user: 'U001', files: [file] },
      ],
      response_metadata: {},
    });

    userInfoMock.mockResolvedValue({
      user: { profile: { display_name: 'Alice' }, name: 'alice' },
    });

    const client = makeClient(repliesMock, userInfoMock);
    const messages = await fetchThreadMessages(client, CHANNEL, THREAD_TS);

    expect(messages[0].files).toHaveLength(1);
    expect(messages[0].files[0].name).toBe('doc.txt');
  });

  it('uses display_name from profile when available', async () => {
    repliesMock.mockResolvedValueOnce({
      messages: [{ ts: '1700000001.000100', text: 'hi', user: 'U001' }],
      response_metadata: {},
    });

    userInfoMock.mockResolvedValueOnce({
      user: { profile: { display_name: 'Display Name', real_name: 'Real Name' }, name: 'username' },
    });

    const client = makeClient(repliesMock, userInfoMock);
    const messages = await fetchThreadMessages(client, CHANNEL, THREAD_TS);

    expect(messages[0].username).toBe('Display Name');
  });

  it('falls back to real_name when display_name is empty', async () => {
    repliesMock.mockResolvedValueOnce({
      messages: [{ ts: '1700000001.000100', text: 'hi', user: 'U001' }],
      response_metadata: {},
    });

    userInfoMock.mockResolvedValueOnce({
      user: { profile: { display_name: '', real_name: 'Real Name' }, name: 'username' },
    });

    const client = makeClient(repliesMock, userInfoMock);
    const messages = await fetchThreadMessages(client, CHANNEL, THREAD_TS);

    expect(messages[0].username).toBe('Real Name');
  });

  it('uses "bot" as username fallback for bot with no username field', async () => {
    repliesMock.mockResolvedValueOnce({
      messages: [
        { ts: '1700000001.000100', text: 'automated', bot_id: 'B002' },
      ],
      response_metadata: {},
    });

    const client = makeClient(repliesMock, userInfoMock);
    const messages = await fetchThreadMessages(client, CHANNEL, THREAD_TS);

    expect(messages[0].username).toBe('bot');
  });

  it('returns empty array when no messages returned', async () => {
    repliesMock.mockResolvedValueOnce({
      messages: [],
      response_metadata: {},
    });

    const client = makeClient(repliesMock, userInfoMock);
    const messages = await fetchThreadMessages(client, CHANNEL, THREAD_TS);

    expect(messages).toHaveLength(0);
  });
});
