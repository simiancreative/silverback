import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import { runProxy } from '../proxy';

function createMockStreams() {
  return {
    clientIn: new PassThrough(),
    clientOut: new PassThrough(),
    serverIn: new PassThrough(),
    serverOut: new PassThrough(),
  };
}

function collectOutput(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString()));
    // Also resolve after a short timeout for tests that don't end the stream
    setTimeout(() => resolve(Buffer.concat(chunks).toString()), 200);
  });
}

describe('proxy', () => {
  it('passes through in bypass mode', async () => {
    const { clientIn, clientOut, serverIn, serverOut } = createMockStreams();

    const proxyDone = runProxy({
      clientIn, clientOut, serverIn, serverOut,
      toolPatterns: null, bypass: true,
    });

    const serverOutput = collectOutput(serverIn);
    const clientOutput = collectOutput(clientOut);

    // Client sends a message
    clientIn.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"any_tool"}}\n');

    // Server sends a response
    serverOut.write('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');

    // End streams
    clientIn.end();
    serverOut.end();

    await proxyDone;

    const serverGot = await serverOutput;
    expect(serverGot).toContain('"tools/call"');

    const clientGot = await clientOutput;
    expect(clientGot).toContain('"ok":true');
  });

  it('denies tools/call for unmatched pattern with -32003', async () => {
    const { clientIn, clientOut, serverIn, serverOut } = createMockStreams();

    const proxyDone = runProxy({
      clientIn, clientOut, serverIn, serverOut,
      toolPatterns: ['list_*'], bypass: false,
    });

    const clientOutput = collectOutput(clientOut);
    const serverOutput = collectOutput(serverIn);

    // Client tries to call a denied tool
    clientIn.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"raw_sql_query"}}\n');
    clientIn.end();
    serverOut.end();

    await proxyDone;

    const clientGot = await clientOutput;
    expect(clientGot).toContain('-32003');
    expect(clientGot).toContain('not permitted');

    // Server should NOT have received the denied call
    const serverGot = await serverOutput;
    expect(serverGot).not.toContain('raw_sql_query');
  });

  it('allows tools/call for matching pattern', async () => {
    const { clientIn, clientOut, serverIn, serverOut } = createMockStreams();

    const proxyDone = runProxy({
      clientIn, clientOut, serverIn, serverOut,
      toolPatterns: ['list_*'], bypass: false,
    });

    const serverOutput = collectOutput(serverIn);

    // Client calls an allowed tool
    clientIn.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_tables"}}\n');

    // Server responds
    serverOut.write('{"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n');

    clientIn.end();
    serverOut.end();

    await proxyDone;

    const serverGot = await serverOutput;
    expect(serverGot).toContain('list_tables');
  });

  it('filters tools/list responses', async () => {
    const { clientIn, clientOut, serverIn, serverOut } = createMockStreams();

    const proxyDone = runProxy({
      clientIn, clientOut, serverIn, serverOut,
      toolPatterns: ['list_*'], bypass: false,
    });

    const clientOutput = collectOutput(clientOut);

    // Client requests tools list
    clientIn.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');

    // Server responds with both allowed and denied tools
    serverOut.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [
          { name: 'list_tables', description: 'List tables' },
          { name: 'raw_sql_query', description: 'Run SQL' },
          { name: 'list_schemas', description: 'List schemas' },
        ],
      },
    }) + '\n');

    clientIn.end();
    serverOut.end();

    await proxyDone;

    const clientGot = await clientOutput;
    expect(clientGot).toContain('list_tables');
    expect(clientGot).toContain('list_schemas');
    expect(clientGot).not.toContain('raw_sql_query');
  });

  it('passes through non-tool messages', async () => {
    const { clientIn, clientOut, serverIn, serverOut } = createMockStreams();

    const proxyDone = runProxy({
      clientIn, clientOut, serverIn, serverOut,
      toolPatterns: ['list_*'], bypass: false,
    });

    const serverOutput = collectOutput(serverIn);
    const clientOutput = collectOutput(clientOut);

    // Client sends initialize
    clientIn.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');

    // Server responds
    serverOut.write('{"jsonrpc":"2.0","id":1,"result":{"capabilities":{}}}\n');

    clientIn.end();
    serverOut.end();

    await proxyDone;

    const serverGot = await serverOutput;
    expect(serverGot).toContain('initialize');

    const clientGot = await clientOutput;
    expect(clientGot).toContain('capabilities');
  });

  it('returns -32700 for malformed JSON from client', async () => {
    const { clientIn, clientOut, serverIn, serverOut } = createMockStreams();

    const proxyDone = runProxy({
      clientIn, clientOut, serverIn, serverOut,
      toolPatterns: ['*'], bypass: false,
    });

    const clientOutput = collectOutput(clientOut);
    const serverOutput = collectOutput(serverIn);

    // Client sends malformed JSON
    clientIn.write('this is not json\n');
    clientIn.end();
    serverOut.end();

    await proxyDone;

    const clientGot = await clientOutput;
    expect(clientGot).toContain('-32700');

    // Server should NOT receive malformed data
    const serverGot = await serverOutput;
    expect(serverGot).toBe('');
  });

  it('returns -32700 for malformed JSON from server', async () => {
    const { clientIn, clientOut, serverIn, serverOut } = createMockStreams();

    const proxyDone = runProxy({
      clientIn, clientOut, serverIn, serverOut,
      toolPatterns: ['*'], bypass: false,
    });

    const clientOutput = collectOutput(clientOut);

    // Server sends malformed JSON
    serverOut.write('not valid json\n');
    clientIn.end();
    serverOut.end();

    await proxyDone;

    const clientGot = await clientOutput;
    expect(clientGot).toContain('-32700');
  });

  it('wildcard * allows all tools', async () => {
    const { clientIn, clientOut, serverIn, serverOut } = createMockStreams();

    const proxyDone = runProxy({
      clientIn, clientOut, serverIn, serverOut,
      toolPatterns: ['*'], bypass: false,
    });

    const serverOutput = collectOutput(serverIn);

    clientIn.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"any_tool_name"}}\n');
    clientIn.end();
    serverOut.end();

    await proxyDone;

    const serverGot = await serverOutput;
    expect(serverGot).toContain('any_tool_name');
  });

  it('preserves tool fields after filtering', async () => {
    const { clientIn, clientOut, serverIn, serverOut } = createMockStreams();

    const proxyDone = runProxy({
      clientIn, clientOut, serverIn, serverOut,
      toolPatterns: ['my_tool'], bypass: false,
    });

    const clientOutput = collectOutput(clientOut);

    clientIn.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');

    serverOut.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [
          { name: 'my_tool', description: 'My tool', inputSchema: { type: 'object', properties: { x: { type: 'number' } } } },
          { name: 'other_tool', description: 'Other' },
        ],
      },
    }) + '\n');

    clientIn.end();
    serverOut.end();

    await proxyDone;

    const clientGot = await clientOutput;
    const parsed = JSON.parse(clientGot.trim());
    expect(parsed.result.tools).toHaveLength(1);
    expect(parsed.result.tools[0].name).toBe('my_tool');
    expect(parsed.result.tools[0].description).toBe('My tool');
    expect(parsed.result.tools[0].inputSchema).toBeDefined();
  });
});
