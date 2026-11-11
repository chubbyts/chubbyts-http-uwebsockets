import { connect } from 'node:net';
import fetch from 'cross-fetch';
import { expect, test } from 'vitest';

// pipelined requests on one connection, the raw response bytes (without the date header): a wrongly framed response
// shows up as garbage before the next response
const rawRequests = (requests: ReadonlyArray<string>): Promise<string> => {
  const { hostname, port } = new URL(process.env.HTTP_URI as string);

  return new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];

    const socket = connect(Number(port), hostname, () => {
      socket.end(
        requests
          .map(
            (request, i) =>
              `${request} HTTP/1.1\r\nHost: ${hostname}\r\n${i === requests.length - 1 ? 'Connection: close\r\n' : ''}\r\n`,
          )
          .join(''),
      );
    });

    // oxlint-disable-next-line functional/immutable-data
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () =>
      resolve(
        Buffer.concat(chunks)
          .toString()
          .replace(/^Date: .*\r\n/gm, ''),
      ),
    );
  });
};

test('get', async () => {
  const response = await fetch(`${process.env.HTTP_URI}/path/to/get/route?key=value`);

  expect(response.status).toBe(200);
  expect(response.statusText).toBe('OK');
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(response.headers.get('set-cookie')).toBe('key1=value1; Path=/, key2=value2; Path=/');

  expect(await response.json()).toMatchInlineSnapshot(`
    {
      "body": "",
      "headers": {
        "accept": [
          "*/*",
        ],
        "accept-encoding": [
          "gzip,deflate",
        ],
        "connection": [
          "keep-alive",
        ],
        "user-agent": [
          "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)",
        ],
      },
      "method": "GET",
      "protocolVersion": "1.1",
      "uri": {
        "fragment": "",
        "host": "example.com",
        "path": "/path/to/get/route",
        "query": "key=value",
        "scheme": "https",
        "userInfo": "",
      },
    }
  `);
});

test('handler error', async () => {
  const response = await fetch(`${process.env.HTTP_URI}/path/to/error/route`);

  expect(response.status).toBe(500);
  expect(response.headers.get('content-type')).toBe('text/plain');

  expect(await response.text()).toBe('Internal Server Error');
});

test('post', async () => {
  const response = await fetch(`${process.env.HTTP_URI}/path/to/post/route`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: 'test' }),
  });

  expect(response.status).toBe(200);
  expect(response.statusText).toBe('OK');
  expect(response.headers.get('content-type')).toBe('application/json');

  expect(await response.json()).toMatchInlineSnapshot(`
    {
      "body": "{"message":"test"}",
      "headers": {
        "accept": [
          "*/*",
        ],
        "accept-encoding": [
          "gzip,deflate",
        ],
        "connection": [
          "keep-alive",
        ],
        "content-length": [
          "18",
        ],
        "content-type": [
          "application/json",
        ],
        "user-agent": [
          "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)",
        ],
      },
      "method": "POST",
      "protocolVersion": "1.1",
      "uri": {
        "fragment": "",
        "host": "example.com",
        "path": "/path/to/post/route",
        "query": "",
        "scheme": "https",
        "userInfo": "",
      },
    }
  `);
});

test('echo header', async () => {
  const response = await fetch(`${process.env.HTTP_URI}/path/to/echo/route?echo=value`);

  expect(response.status).toBe(204);
  expect(response.headers.get('x-echo')).toBe('value');
});

test('echo header, with response splitting attempt', async () => {
  const response = await fetch(`${process.env.HTTP_URI}/path/to/echo/route?echo=a%0d%0aX-Injected:%20pwned`);

  expect(response.status).toBe(500);
  expect(response.headers.get('x-echo')).toBeNull();
  expect(response.headers.get('x-injected')).toBeNull();
});

test('post, with too large body', async () => {
  await expect(
    fetch(`${process.env.HTTP_URI}/path/to/post/route`, {
      method: 'POST',
      body: 'a'.repeat(2 * 1024 * 1024),
    }),
  ).rejects.toThrow();
});

test('head, followed by another request on the same connection', async () => {
  // the body of the handler does not get sent: the next response follows right after the header section
  // the next response on the same connection does get its body
  expect(await rawRequests(['HEAD /path/to/head/route', 'GET /path/to/framing/route'])).toBe(
    'HTTP/1.1 200 OK\r\n' +
      'content-type: application/json\r\n' +
      'set-cookie: key1=value1; Path=/\r\n' +
      'set-cookie: key2=value2; Path=/\r\n' +
      'uWebSockets: 20\r\n' +
      '\r\n' +
      'HTTP/1.1 200 OK\r\n' +
      'uWebSockets: 20\r\n' +
      'Content-Length: 6\r\n' +
      '\r\n' +
      'framed',
  );
});

test('get, with framing headers set by the handler', async () => {
  // only the framing of uWebSockets.js: no wrong content-length, no duplicated transfer-encoding, a body provided at
  // once gets sent with a content-length
  expect(await rawRequests(['GET /path/to/framing/route', 'GET /path/to/echo/route?echo=next'])).toBe(
    'HTTP/1.1 200 OK\r\n' +
      'uWebSockets: 20\r\n' +
      'Content-Length: 6\r\n' +
      '\r\n' +
      'framed' +
      'HTTP/1.1 204 No Content\r\n' +
      'x-echo: next\r\n' +
      'uWebSockets: 20\r\n' +
      '\r\n',
  );
});

test('get, with streamed body', async () => {
  const response = await fetch(`${process.env.HTTP_URI}/path/to/streamed/route`);

  // a body taking longer than the current event loop turn gets streamed chunked
  expect(response.status).toBe(200);
  expect(response.headers.get('transfer-encoding')).toBe('chunked');
  expect(response.headers.get('content-length')).toBeNull();

  expect(await response.text()).toBe('streamed');
});

test('not modified, with body set by the handler', async () => {
  // the content-length of the GET response gets reported, the body does not get sent
  expect(await rawRequests(['GET /path/to/not-modified/route', 'GET /path/to/echo/route?echo=next'])).toBe(
    'HTTP/1.1 304 Not Modified\r\n' +
      'uWebSockets: 20\r\n' +
      'Content-Length: 6\r\n' +
      '\r\n' +
      'HTTP/1.1 204 No Content\r\n' +
      'x-echo: next\r\n' +
      'uWebSockets: 20\r\n' +
      '\r\n',
  );
});
