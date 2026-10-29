/* oxlint-disable functional/immutable-data */

import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { describe, expect, test, vi } from 'vitest';
import type { HttpRequest, HttpResponse } from 'uWebSockets.js';
import { useFunctionMock } from '@chubbyts/chubbyts-function-mock/dist/function-mock';
import type { ObjectMocks } from '@chubbyts/chubbyts-function-mock/dist/object-mock';
import { useObjectMock } from '@chubbyts/chubbyts-function-mock/dist/object-mock';
import type { Body, Response, Uri } from '@chubbyts/chubbyts-http-types/message';
import type { ServerRequestFactory, UriFactory } from '@chubbyts/chubbyts-http-types/message-factory';
import type { RequestHelpers } from '@chubbyts/chubbyts-http-types/message-helper';
import {
  createResponseToUWebSocketsResponseEmitter,
  createUWebSocketsRequestToServerRequestFactory,
  getUrl,
} from '../../src/uwebsockets.js';

type Handlers = {
  aborted?: () => void;
  data?: (chunk: ArrayBuffer, isLast: boolean) => void;
  writable?: (offset: number) => boolean;
};

const uri: Uri = {
  scheme: 'https',
  userInfo: '',
  host: 'example.com',
  port: undefined,
  path: '/path/to/route',
  query: '',
  fragment: '',
};

// the implementation (factories and helpers) gets injected: mocked by a minimal one, which verifies the calls
const useImplementationMocks = (
  expected:
    | {
        url: string;
        method: string;
        headers?: Array<[string, Array<string>]>;
        withBody?: boolean;
      }
    | undefined = undefined,
) => {
  const [uriFactory, uriFactoryMocks] = useFunctionMock<UriFactory>(
    expected ? [{ parameters: [expected.url], return: uri }] : [],
  );

  const [serverRequestFactory, serverRequestFactoryMocks] = useFunctionMock<ServerRequestFactory>(
    expected
      ? [
          {
            parameters: [expected.method, uri],
            return: {
              method: expected.method,
              uri,
              protocolVersion: '1.0',
              headers: {},
              body: Readable.from([]),
              signal: new AbortController().signal,
              attributes: {},
            },
          },
        ]
      : [],
  );

  const [requestHelpers, requestHelpersMocks] = useObjectMock<RequestHelpers>(
    expected
      ? [
          {
            name: 'withProtocolVersion',
            callback: (message, protocolVersion) => {
              expect(protocolVersion).toBe('1.1');

              return { ...message, protocolVersion };
            },
          },
          { name: 'withSignal', callback: (request, signal) => ({ ...request, signal }) },
          ...(expected.headers ?? []).map(([expectedName, expectedValues]): ObjectMocks<RequestHelpers>[number] => ({
            name: 'withHeader',
            callback: (message, name, value) => {
              expect(name).toBe(expectedName);
              expect(value).toEqual(expectedValues);

              return { ...message, headers: { ...message.headers, [name]: value as ReadonlyArray<string> } };
            },
          })),
          ...(expected.withBody
            ? [
                {
                  name: 'withBody',
                  callback: (message, body) => ({ ...message, body }),
                } satisfies ObjectMocks<RequestHelpers>[number],
              ]
            : []),
        ]
      : [],
  );

  return {
    uriFactory,
    serverRequestFactory,
    requestHelpers,
    mocks: [uriFactoryMocks, serverRequestFactoryMocks, requestHelpersMocks],
  };
};

const expectAllMocksCalled = (mocks: ReadonlyArray<ReadonlyArray<unknown>>) => {
  mocks.forEach((mock) => expect(mock).toHaveLength(0));
};

const requestMocks = (
  method: string,
  url: string,
  query: string,
  headers: Array<[string, string]> = [],
): ObjectMocks<HttpRequest> => [
  { name: 'getMethod', parameters: [], return: method },
  {
    name: 'forEach',
    callback: (callback) => {
      headers.forEach(([name, value]) => callback(name, value));
    },
  },
  // getQuery is overloaded, its parameters cannot be inferred for the mock
  { name: 'getQuery', callback: (() => query) as HttpRequest['getQuery'] },
  { name: 'getUrl', parameters: [], return: url },
];

const onAbortedMock = (handlers: Handlers, getResponse: () => HttpResponse): ObjectMocks<HttpResponse>[number] => ({
  name: 'onAborted',
  callback: (handler: () => void): HttpResponse => {
    handlers.aborted = handler;

    return getResponse();
  },
});

const onDataMock = (handlers: Handlers, getResponse: () => HttpResponse): ObjectMocks<HttpResponse>[number] => ({
  name: 'onData',
  callback: (handler: (chunk: ArrayBuffer, isLast: boolean) => void): HttpResponse => {
    handlers.data = handler;

    return getResponse();
  },
});

const corkMock = (getResponse: () => HttpResponse): ObjectMocks<HttpResponse>[number] => ({
  name: 'cork',
  callback: (callback: () => void): HttpResponse => {
    callback();

    return getResponse();
  },
});

const writeMock = (expected: string, writable: boolean): ObjectMocks<HttpResponse>[number] => ({
  name: 'write',
  callback: (chunk: unknown): boolean => {
    expect(Buffer.from(chunk as Uint8Array).toString()).toBe(expected);

    return writable;
  },
});

const toArrayBuffer = (content: string): ArrayBuffer => new TextEncoder().encode(content).buffer as ArrayBuffer;

const createResponse = (overrides: Partial<Response> = {}): Response => ({
  status: 200,
  reasonPhrase: 'OK',
  protocolVersion: '1.1',
  headers: {},
  body: Readable.from([]),
  ...overrides,
});

const useAbortedResponse = () => {
  const handlers: Handlers = {};

  const [uWebSocketsRequest] = useObjectMock<HttpRequest>(requestMocks('get', '/', ''));

  const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([
    onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
  ]);

  const { uriFactory, serverRequestFactory, requestHelpers } = useImplementationMocks({
    url: 'http://127.0.0.1/',
    method: 'GET',
  });

  createUWebSocketsRequestToServerRequestFactory(
    uriFactory,
    serverRequestFactory,
    requestHelpers,
  )(uWebSocketsRequest, uWebSocketsResponse);

  handlers.aborted?.();

  return { uWebSocketsResponse, uWebSocketsResponseMocks };
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('uwebsockets', () => {
  describe('getUrl', () => {
    test.each([
      ['/path/to/route', '', undefined, 'http://127.0.0.1/path/to/route'],
      ['/path/to/route', 'key=value', undefined, 'http://127.0.0.1/path/to/route?key=value'],
      ['/path/to/route', '', 'https://example.com/', 'https://example.com/path/to/route'],
      ['/path/to/route', 'key=value', 'https://example.com/app', 'https://example.com/app/path/to/route?key=value'],
      ['/path/to/route', '', 'https://example.com/app/', 'https://example.com/app/path/to/route'],
    ])('with url "%s", with query "%s", with base url "%s"', (url, query, baseUrl, expected) => {
      const [uWebSocketsRequest, uWebSocketsRequestMocks] = useObjectMock<HttpRequest>([
        { name: 'getQuery', callback: (() => query) as HttpRequest['getQuery'] },
        { name: 'getUrl', parameters: [], return: url },
      ]);

      expect(getUrl(uWebSocketsRequest, baseUrl)).toBe(expected);

      expect(uWebSocketsRequestMocks).toHaveLength(0);
    });

    test.each([
      [
        '//evil.com/path/to/route',
        'Request target "//evil.com/path/to/route" resolves to origin "https://evil.com" instead of the expected origin "https://example.com"',
      ],
      [
        '/\\evil.com/path/to/route',
        'Request target "/\\evil.com/path/to/route" resolves to origin "https://evil.com" instead of the expected origin "https://example.com"',
      ],
      [
        'http://evil.com/path/to/route',
        'Unsupported request target "http://evil.com/path/to/route": only origin-form (starting with "/") is supported',
      ],
      ['*', 'Unsupported request target "*": only origin-form (starting with "/") is supported'],
    ])('with request target "%s"', (url, expected) => {
      const [uWebSocketsRequest, uWebSocketsRequestMocks] = useObjectMock<HttpRequest>([
        { name: 'getQuery', callback: (() => '') as HttpRequest['getQuery'] },
        { name: 'getUrl', parameters: [], return: url },
      ]);

      expect(() => getUrl(uWebSocketsRequest, 'https://example.com')).toThrow(expected);

      expect(uWebSocketsRequestMocks).toHaveLength(0);
    });
  });

  describe('createUWebSocketsRequestToServerRequestFactory', () => {
    test('without body', async () => {
      const handlers: Handlers = {};

      const [uWebSocketsRequest, uWebSocketsRequestMocks] = useObjectMock<HttpRequest>(
        requestMocks('get', '/path/to/route', 'key=value', [
          ['content-type', 'text/plain'],
          ['x-custom', 'value1'],
          ['x-custom', 'value2'],
          ['cookie', 'sessionId=abc123'],
          ['cookie', 'ui_lang=en-US'],
          ['authorization', 'Bearer token1'],
        ]),
      );

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
      ]);

      // grouped by name, in the order of the first occurrence
      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks({
        url: 'https://example.com/path/to/route?key=value',
        method: 'GET',
        headers: [
          ['content-type', ['text/plain']],
          ['x-custom', ['value1', 'value2']],
          ['cookie', ['sessionId=abc123', 'ui_lang=en-US']],
          ['authorization', ['Bearer token1']],
        ],
      });

      const uWebSocketsRequestToServerRequestFactory = createUWebSocketsRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
        'https://example.com',
      );

      const serverRequest = uWebSocketsRequestToServerRequestFactory(uWebSocketsRequest, uWebSocketsResponse);

      expect(serverRequest.method).toBe('GET');
      expect(serverRequest.uri).toBe(uri);
      expect(serverRequest.protocolVersion).toBe('1.1');
      expect(serverRequest.headers).toMatchInlineSnapshot(`
        {
          "authorization": [
            "Bearer token1",
          ],
          "content-type": [
            "text/plain",
          ],
          "cookie": [
            "sessionId=abc123",
            "ui_lang=en-US",
          ],
          "x-custom": [
            "value1",
            "value2",
          ],
        }
      `);
      expect(serverRequest.signal.aborted).toBe(false);

      // the body of a GET request gets ignored: the (empty) body of the factory is kept
      expect(await text(serverRequest.body)).toBe('');

      handlers.aborted?.();

      expect(serverRequest.signal.aborted).toBe(true);
      expect((serverRequest.signal.reason as Error).name).toBe('AbortError');

      expect(uWebSocketsRequestMocks).toHaveLength(0);
      expect(uWebSocketsResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });

    test('with head, with already aborted response', () => {
      const handlers: Handlers = {};

      const [uWebSocketsRequest, uWebSocketsRequestMocks] = useObjectMock<HttpRequest>([
        ...requestMocks('get', '/', ''),
        ...requestMocks('head', '/', ''),
      ]);

      // onAborted gets registered only once per response
      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
      ]);

      const firstImplementation = useImplementationMocks({ url: 'https://example.com/', method: 'GET' });
      const secondImplementation = useImplementationMocks({ url: 'https://example.com/', method: 'HEAD' });

      createUWebSocketsRequestToServerRequestFactory(
        firstImplementation.uriFactory,
        firstImplementation.serverRequestFactory,
        firstImplementation.requestHelpers,
        'https://example.com',
      )(uWebSocketsRequest, uWebSocketsResponse);

      handlers.aborted?.();

      const serverRequest = createUWebSocketsRequestToServerRequestFactory(
        secondImplementation.uriFactory,
        secondImplementation.serverRequestFactory,
        secondImplementation.requestHelpers,
        'https://example.com',
      )(uWebSocketsRequest, uWebSocketsResponse);

      expect(serverRequest.method).toBe('HEAD');
      expect(serverRequest.signal.aborted).toBe(true);

      expect(uWebSocketsRequestMocks).toHaveLength(0);
      expect(uWebSocketsResponseMocks).toHaveLength(0);
      expectAllMocksCalled(firstImplementation.mocks);
      expectAllMocksCalled(secondImplementation.mocks);
    });

    test.each(['authorization', 'proxy-authorization'])('with multiple %s headers', (name) => {
      const [uWebSocketsRequest, uWebSocketsRequestMocks] = useObjectMock<HttpRequest>(
        requestMocks('get', '/', '', [
          [name, 'Basic dXNlcjE='],
          [name, 'Basic dXNlcjI='],
        ]).slice(0, 2),
      );
      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([]);

      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks();

      const uWebSocketsRequestToServerRequestFactory = createUWebSocketsRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
      );

      expect(() => uWebSocketsRequestToServerRequestFactory(uWebSocketsRequest, uWebSocketsResponse)).toThrow(
        `Request contains multiple "${name}" headers`,
      );

      expect(uWebSocketsRequestMocks).toHaveLength(0);
      expect(uWebSocketsResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });

    test('with body', async () => {
      const handlers: Handlers = {};

      const [uWebSocketsRequest, uWebSocketsRequestMocks] = useObjectMock<HttpRequest>(
        requestMocks('post', '/path/to/route', ''),
      );

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        onDataMock(handlers, (): HttpResponse => uWebSocketsResponse),
      ]);

      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks({
        url: 'http://127.0.0.1/path/to/route',
        method: 'POST',
        withBody: true,
      });

      const uWebSocketsRequestToServerRequestFactory = createUWebSocketsRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
      );

      const serverRequest = uWebSocketsRequestToServerRequestFactory(uWebSocketsRequest, uWebSocketsResponse);

      const chunk = new Uint8Array(toArrayBuffer('{"name":'));

      handlers.data?.(chunk.buffer as ArrayBuffer, false);

      // uWebSockets.js reuses the chunk memory after the callback
      chunk.fill(0);

      handlers.data?.(toArrayBuffer('"test"}'), true);

      expect(await text(serverRequest.body)).toBe('{"name":"test"}');

      expect(uWebSocketsRequestMocks).toHaveLength(0);
      expect(uWebSocketsResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });

    test('with body, without request body timeout, with slowly received body', async () => {
      const handlers: Handlers = {};

      const [uWebSocketsRequest, uWebSocketsRequestMocks] = useObjectMock<HttpRequest>(
        requestMocks('post', '/path/to/route', ''),
      );

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        onDataMock(handlers, (): HttpResponse => uWebSocketsResponse),
      ]);

      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks({
        url: 'http://127.0.0.1/path/to/route',
        method: 'POST',
        withBody: true,
      });

      const uWebSocketsRequestToServerRequestFactory = createUWebSocketsRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
      );

      const serverRequest = uWebSocketsRequestToServerRequestFactory(uWebSocketsRequest, uWebSocketsResponse);

      // no request body timeout is configured: a slow body must not lead to a closed response (a close call would
      // fail with a missing mock)
      await wait(50);

      handlers.data?.(toArrayBuffer('delayed'), true);

      expect(await text(serverRequest.body)).toBe('delayed');

      expect(uWebSocketsRequestMocks).toHaveLength(0);
      expect(uWebSocketsResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });

    test('with body, with abort', async () => {
      const handlers: Handlers = {};

      const [uWebSocketsRequest, uWebSocketsRequestMocks] = useObjectMock<HttpRequest>(
        requestMocks('post', '/path/to/route', ''),
      );

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        onDataMock(handlers, (): HttpResponse => uWebSocketsResponse),
      ]);

      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks({
        url: 'http://127.0.0.1/path/to/route',
        method: 'POST',
        withBody: true,
      });

      const uWebSocketsRequestToServerRequestFactory = createUWebSocketsRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
      );

      const serverRequest = uWebSocketsRequestToServerRequestFactory(uWebSocketsRequest, uWebSocketsResponse);

      handlers.data?.(toArrayBuffer('partial'), false);

      // the destroyed body must not surface as an unhandled 'error' event
      handlers.aborted?.();

      await wait(0);

      expect(serverRequest.signal.aborted).toBe(true);
      await expect(text(serverRequest.body)).rejects.toThrow('Request has been aborted');

      expect(uWebSocketsRequestMocks).toHaveLength(0);
      expect(uWebSocketsResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });

    test('with body, with request body timeout, with stalling request', async () => {
      const handlers: Handlers = {};

      const closed = Promise.withResolvers<undefined>();

      const [uWebSocketsRequest, uWebSocketsRequestMocks] = useObjectMock<HttpRequest>(
        requestMocks('post', '/path/to/route', ''),
      );

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        onDataMock(handlers, (): HttpResponse => uWebSocketsResponse),
        {
          name: 'close',
          callback: (): HttpResponse => {
            closed.resolve(undefined);

            return uWebSocketsResponse;
          },
        },
      ]);

      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks({
        url: 'http://127.0.0.1/path/to/route',
        method: 'POST',
        withBody: true,
      });

      const uWebSocketsRequestToServerRequestFactory = createUWebSocketsRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
        undefined,
        50,
      );

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      const serverRequest = uWebSocketsRequestToServerRequestFactory(uWebSocketsRequest, uWebSocketsResponse);

      // the timeout must not keep the process alive
      expect((setTimeoutSpy.mock.results[0].value as NodeJS.Timeout).hasRef()).toBe(false);

      setTimeoutSpy.mockRestore();

      await closed.promise;

      await expect(text(serverRequest.body)).rejects.toThrow('Request body has not been fully received within 50ms');

      expect(uWebSocketsRequestMocks).toHaveLength(0);
      expect(uWebSocketsResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });

    test('with body, with request body timeout, with aborted request', async () => {
      const handlers: Handlers = {};

      const [uWebSocketsRequest, uWebSocketsRequestMocks] = useObjectMock<HttpRequest>(
        requestMocks('post', '/path/to/route', ''),
      );

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        onDataMock(handlers, (): HttpResponse => uWebSocketsResponse),
      ]);

      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks({
        url: 'http://127.0.0.1/path/to/route',
        method: 'POST',
        withBody: true,
      });

      const uWebSocketsRequestToServerRequestFactory = createUWebSocketsRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
        undefined,
        50,
      );

      const serverRequest = uWebSocketsRequestToServerRequestFactory(uWebSocketsRequest, uWebSocketsResponse);

      handlers.aborted?.();

      // uWebSockets.js forbids touching an aborted response: the timeout must not close it (a close call would fail
      // with a missing mock)
      await wait(100);

      await expect(text(serverRequest.body)).rejects.toThrow('Request has been aborted');

      expect(uWebSocketsRequestMocks).toHaveLength(0);
      expect(uWebSocketsResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });

    test('with body, with request body timeout, with body received in time', async () => {
      const handlers: Handlers = {};

      const [uWebSocketsRequest, uWebSocketsRequestMocks] = useObjectMock<HttpRequest>(
        requestMocks('post', '/path/to/route', ''),
      );

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        onDataMock(handlers, (): HttpResponse => uWebSocketsResponse),
      ]);

      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks({
        url: 'http://127.0.0.1/path/to/route',
        method: 'POST',
        withBody: true,
      });

      const uWebSocketsRequestToServerRequestFactory = createUWebSocketsRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
        undefined,
        50,
      );

      const serverRequest = uWebSocketsRequestToServerRequestFactory(uWebSocketsRequest, uWebSocketsResponse);

      handlers.data?.(toArrayBuffer('complete'), true);

      // the body has been fully received: the timeout gets cleared and must not close the response (a close call
      // would fail with a missing mock)
      await wait(100);

      expect(await text(serverRequest.body)).toBe('complete');

      expect(uWebSocketsRequestMocks).toHaveLength(0);
      expect(uWebSocketsResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });

    test('with body, with backpressure', async () => {
      const handlers: Handlers = {};

      const resumed = Promise.withResolvers<undefined>();

      const [uWebSocketsRequest, uWebSocketsRequestMocks] = useObjectMock<HttpRequest>(
        requestMocks('post', '/path/to/route', ''),
      );

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        onDataMock(handlers, (): HttpResponse => uWebSocketsResponse),
        { name: 'pause', parameters: [], return: undefined },
        {
          name: 'resume',
          callback: (): void => {
            resumed.resolve(undefined);
          },
        },
      ]);

      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks({
        url: 'http://127.0.0.1/path/to/route',
        method: 'POST',
        withBody: true,
      });

      const uWebSocketsRequestToServerRequestFactory = createUWebSocketsRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
      );

      const serverRequest = uWebSocketsRequestToServerRequestFactory(uWebSocketsRequest, uWebSocketsResponse);

      // exceeds the high water mark of the passthrough: receiving gets paused until the handler consumed it
      const largeChunk = 'a'.repeat(128 * 1024);

      handlers.data?.(toArrayBuffer(largeChunk), false);

      expect(uWebSocketsResponseMocks).toHaveLength(1);

      const content = text(serverRequest.body);

      await resumed.promise;

      // the last chunk does not pause anymore, even when exceeding the high water mark
      handlers.data?.(toArrayBuffer(largeChunk), true);

      expect(await content).toBe(largeChunk + largeChunk);

      expect(uWebSocketsRequestMocks).toHaveLength(0);
      expect(uWebSocketsResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });

    test('with body, with request body max bytes, with too large content-length', async () => {
      const handlers: Handlers = {};

      const [uWebSocketsRequest, uWebSocketsRequestMocks] = useObjectMock<HttpRequest>(
        requestMocks('post', '/path/to/route', '', [['content-length', '11']]),
      );

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        {
          name: 'close',
          callback: (): HttpResponse => {
            // uWebSockets.js calls the abort handler on close
            handlers.aborted?.();

            return uWebSocketsResponse;
          },
        },
      ]);

      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks({
        url: 'http://127.0.0.1/path/to/route',
        method: 'POST',
        headers: [['content-length', ['11']]],
        withBody: true,
      });

      const uWebSocketsRequestToServerRequestFactory = createUWebSocketsRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
        undefined,
        50,
        10,
      );

      const serverRequest = uWebSocketsRequestToServerRequestFactory(uWebSocketsRequest, uWebSocketsResponse);

      // the body does not get read at all (an onData call would fail with a missing mock), no timeout gets started (a
      // second close call would fail with a missing mock)
      await wait(100);

      expect(serverRequest.signal.aborted).toBe(true);
      await expect(text(serverRequest.body)).rejects.toThrow('Request body exceeds the maximum of 10 bytes');

      expect(uWebSocketsRequestMocks).toHaveLength(0);
      expect(uWebSocketsResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });

    test('with body, with request body max bytes, with too large received body', async () => {
      const handlers: Handlers = {};

      const [uWebSocketsRequest, uWebSocketsRequestMocks] = useObjectMock<HttpRequest>(
        requestMocks('post', '/path/to/route', '', [['content-length', '10']]),
      );

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        onDataMock(handlers, (): HttpResponse => uWebSocketsResponse),
        { name: 'close', parameters: [], returnSelf: true },
      ]);

      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks({
        url: 'http://127.0.0.1/path/to/route',
        method: 'POST',
        headers: [['content-length', ['10']]],
        withBody: true,
      });

      const uWebSocketsRequestToServerRequestFactory = createUWebSocketsRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
        undefined,
        50,
        10,
      );

      const serverRequest = uWebSocketsRequestToServerRequestFactory(uWebSocketsRequest, uWebSocketsResponse);

      // exactly at the limit
      handlers.data?.(toArrayBuffer('0123456789'), false);
      handlers.data?.(toArrayBuffer('a'), false);

      // the timeout gets cleared and must not close the response again (a second close call would fail with a missing
      // mock)
      await wait(100);

      await expect(text(serverRequest.body)).rejects.toThrow('Request body exceeds the maximum of 10 bytes');

      expect(uWebSocketsRequestMocks).toHaveLength(0);
      expect(uWebSocketsResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });
  });

  describe('createResponseToUWebSocketsResponseEmitter', () => {
    test('with body', async () => {
      const handlers: Handlers = {};

      const ended = Promise.withResolvers<undefined>();

      const response = createResponse({
        status: 201,
        reasonPhrase: 'Created',
        headers: {
          'content-type': ['application/json'],
          'set-cookie': ['key1=value1; Path=/', 'key2=value2; Path=/'],
        },
        body: Readable.from([Buffer.from('{"name":'), Buffer.from('"test"}')]),
      });

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        corkMock((): HttpResponse => uWebSocketsResponse),
        { name: 'writeStatus', parameters: ['201 Created'], returnSelf: true },
        { name: 'writeHeader', parameters: ['content-type', 'application/json'], returnSelf: true },
        { name: 'writeHeader', parameters: ['set-cookie', 'key1=value1; Path=/'], returnSelf: true },
        { name: 'writeHeader', parameters: ['set-cookie', 'key2=value2; Path=/'], returnSelf: true },
        corkMock((): HttpResponse => uWebSocketsResponse),
        writeMock('{"name":', true),
        corkMock((): HttpResponse => uWebSocketsResponse),
        writeMock('"test"}', true),
        corkMock((): HttpResponse => uWebSocketsResponse),
        {
          name: 'end',
          callback: (): HttpResponse => {
            ended.resolve(undefined);

            return uWebSocketsResponse;
          },
        },
      ]);

      const responseToUWebSocketsResponseEmitter = createResponseToUWebSocketsResponseEmitter();

      responseToUWebSocketsResponseEmitter(response, uWebSocketsResponse);

      await ended.promise;

      // no response send timeout is configured: no timer may close the response afterwards (a close call would fail
      // with a missing mock)
      await wait(50);

      expect(uWebSocketsResponseMocks).toHaveLength(0);
    });

    test('with async generator body, with backpressure', async () => {
      const handlers: Handlers = {};

      const ended = Promise.withResolvers<undefined>();

      const response = createResponse({
        body: (async function* () {
          yield new TextEncoder().encode('chunk1');
          yield new TextEncoder().encode('chunk2');
        })(),
      });

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        corkMock((): HttpResponse => uWebSocketsResponse),
        { name: 'writeStatus', parameters: ['200 OK'], returnSelf: true },
        corkMock((): HttpResponse => uWebSocketsResponse),
        writeMock('chunk1', false),
        {
          name: 'onWritable',
          callback: (handler: (offset: number) => boolean): HttpResponse => {
            handlers.writable = handler;

            return uWebSocketsResponse;
          },
        },
        corkMock((): HttpResponse => uWebSocketsResponse),
        writeMock('chunk2', true),
        corkMock((): HttpResponse => uWebSocketsResponse),
        {
          name: 'end',
          callback: (): HttpResponse => {
            ended.resolve(undefined);

            return uWebSocketsResponse;
          },
        },
      ]);

      const responseToUWebSocketsResponseEmitter = createResponseToUWebSocketsResponseEmitter();

      responseToUWebSocketsResponseEmitter(response, uWebSocketsResponse);

      // the body is paused until the client is able to receive more data
      await wait(20);

      expect(uWebSocketsResponseMocks).toHaveLength(4);

      expect(handlers.writable?.(0)).toBe(true);

      await ended.promise;

      expect(uWebSocketsResponseMocks).toHaveLength(0);
    });

    test.each([
      [{ status: 99 }, 'Invalid response status "99"'],
      [{ status: 1000 }, 'Invalid response status "1000"'],
      [{ status: 200.5 }, 'Invalid response status "200.5"'],
      [{ reasonPhrase: 'OK\r\nContent-Length: 0\r\n\r\nHTTP/1.1 200 OK' }, 'Invalid response reason phrase'],
      [{ headers: { 'x-echo': ['a\r\nx-injected: pwned'] } }, 'Invalid response header "x-echo"'],
      [{ headers: { 'x-echo': ['a\0'] } }, 'Invalid response header "x-echo"'],
      [{ headers: { 'x-echo': ['valid', 'a\0'] } }, 'Invalid response header "x-echo"'],
      [{ headers: { 'x-echo\r\nx-injected': ['pwned'] } }, 'Invalid response header "x-echo\r\nx-injected"'],
      [{ headers: { 'x echo': ['value'] } }, 'Invalid response header "x echo"'],
      [{ headers: { '': ['value'] } }, 'Invalid response header ""'],
    ])('with invalid response %j', (overrides, expected) => {
      const handlers: Handlers = {};

      const body = new Readable({ read() {} });

      // nothing gets written to the response (a call would fail with a missing mock)
      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
      ]);

      const responseToUWebSocketsResponseEmitter = createResponseToUWebSocketsResponseEmitter();

      expect(() =>
        responseToUWebSocketsResponseEmitter(createResponse({ ...overrides, body }), uWebSocketsResponse),
      ).toThrow(expected);

      expect(body.destroyed).toBe(true);

      expect(uWebSocketsResponseMocks).toHaveLength(0);
    });

    test.each([
      [100, 'Continue'],
      [999, 'Custom'],
    ])('with valid response status %d', async (status, reasonPhrase) => {
      const handlers: Handlers = {};

      const ended = Promise.withResolvers<undefined>();

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        corkMock((): HttpResponse => uWebSocketsResponse),
        { name: 'writeStatus', parameters: [`${status} ${reasonPhrase}`], returnSelf: true },
        corkMock((): HttpResponse => uWebSocketsResponse),
        {
          name: 'end',
          callback: (): HttpResponse => {
            ended.resolve(undefined);

            return uWebSocketsResponse;
          },
        },
      ]);

      createResponseToUWebSocketsResponseEmitter()(
        createResponse({ status, reasonPhrase, body: Readable.from([]) }),
        uWebSocketsResponse,
      );

      await ended.promise;

      expect(uWebSocketsResponseMocks).toHaveLength(0);
    });

    test('with valid response edge cases', async () => {
      const handlers: Handlers = {};

      const ended = Promise.withResolvers<undefined>();

      const response = createResponse({
        status: 599,
        reasonPhrase: 'Custom \tR\u00e9ason',
        headers: { "!#$%&'*+-.^_`|~09AZaz": ['', 'tab\tvalue \u00ff'] },
        body: Readable.from([]),
      });

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        corkMock((): HttpResponse => uWebSocketsResponse),
        { name: 'writeStatus', parameters: ['599 Custom \tR\u00e9ason'], returnSelf: true },
        { name: 'writeHeader', parameters: ["!#$%&'*+-.^_`|~09AZaz", ''], returnSelf: true },
        { name: 'writeHeader', parameters: ["!#$%&'*+-.^_`|~09AZaz", 'tab\tvalue \u00ff'], returnSelf: true },
        corkMock((): HttpResponse => uWebSocketsResponse),
        {
          name: 'end',
          callback: (): HttpResponse => {
            ended.resolve(undefined);

            return uWebSocketsResponse;
          },
        },
      ]);

      createResponseToUWebSocketsResponseEmitter()(response, uWebSocketsResponse);

      await ended.promise;

      expect(uWebSocketsResponseMocks).toHaveLength(0);
    });

    test('with already destroyed body', () => {
      const handlers: Handlers = {};

      const body = new Readable({ read() {} });
      body.on('error', () => {});
      body.destroy(new Error('upstream failed'));

      // nothing gets written to the response (a call would fail with a missing mock)
      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
      ]);

      const responseToUWebSocketsResponseEmitter = createResponseToUWebSocketsResponseEmitter();

      expect(() => responseToUWebSocketsResponseEmitter(createResponse({ body }), uWebSocketsResponse)).toThrow(
        'Response body has already been destroyed',
      );

      expect(uWebSocketsResponseMocks).toHaveLength(0);
    });

    test('with already ended body', async () => {
      const handlers: Handlers = {};

      const body = Readable.from([]);
      body.resume();
      await new Promise((resolve) => body.once('end', resolve));

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        corkMock((): HttpResponse => uWebSocketsResponse),
        { name: 'writeStatus', parameters: ['200 OK'], returnSelf: true },
        { name: 'end', parameters: [], returnSelf: true },
      ]);

      createResponseToUWebSocketsResponseEmitter(50)(createResponse({ body }), uWebSocketsResponse);

      // no timeout gets started (a close call would fail with a missing mock)
      await wait(100);

      // the ended body does not get streamed
      expect(body.listenerCount('data')).toBe(0);
      expect(body.listenerCount('end')).toBe(0);

      expect(uWebSocketsResponseMocks).toHaveLength(0);
    });

    test('with body, with body error', async () => {
      const handlers: Handlers = {};

      const closed = Promise.withResolvers<undefined>();

      const response = createResponse({
        body: (async function* () {
          yield new TextEncoder().encode('partial');
          throw new Error('upstream failed');
        })(),
      });

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        corkMock((): HttpResponse => uWebSocketsResponse),
        { name: 'writeStatus', parameters: ['200 OK'], returnSelf: true },
        corkMock((): HttpResponse => uWebSocketsResponse),
        writeMock('partial', true),
        {
          name: 'close',
          callback: (): HttpResponse => {
            closed.resolve(undefined);

            return uWebSocketsResponse;
          },
        },
      ]);

      const responseToUWebSocketsResponseEmitter = createResponseToUWebSocketsResponseEmitter();

      responseToUWebSocketsResponseEmitter(response, uWebSocketsResponse);

      // an already started response cannot signal a failure anymore: the connection gets closed
      await closed.promise;

      expect(uWebSocketsResponseMocks).toHaveLength(0);
    });

    test('with body, with abort', async () => {
      const handlers: Handlers = {};

      const body = new Readable({ read() {} });
      body.push('partial');

      const response = createResponse({ body });

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        corkMock((): HttpResponse => uWebSocketsResponse),
        { name: 'writeStatus', parameters: ['200 OK'], returnSelf: true },
        corkMock((): HttpResponse => uWebSocketsResponse),
        writeMock('partial', true),
      ]);

      const responseToUWebSocketsResponseEmitter = createResponseToUWebSocketsResponseEmitter();

      responseToUWebSocketsResponseEmitter(response, uWebSocketsResponse);

      await wait(20);

      // uWebSockets.js forbids touching an aborted response: the body gets destroyed without closing the response
      // (a close call would fail with a missing mock)
      handlers.aborted?.();

      await wait(20);

      expect(body.destroyed).toBe(true);

      expect(uWebSocketsResponseMocks).toHaveLength(0);
    });

    test('with web stream body, with abort', async () => {
      const handlers: Handlers = {};

      const cancelled = Promise.withResolvers<unknown>();

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'));
          // stays open: never closes and never enqueues again
        },
        cancel(reason) {
          cancelled.resolve(reason);
        },
      });

      const response = createResponse({ body });

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        corkMock((): HttpResponse => uWebSocketsResponse),
        { name: 'writeStatus', parameters: ['200 OK'], returnSelf: true },
        corkMock((): HttpResponse => uWebSocketsResponse),
        writeMock('partial', true),
      ]);

      const responseToUWebSocketsResponseEmitter = createResponseToUWebSocketsResponseEmitter();

      responseToUWebSocketsResponseEmitter(response, uWebSocketsResponse);

      await wait(20);

      handlers.aborted?.();

      // the pending read must not prevent the web stream from getting cancelled
      expect(((await cancelled.promise) as Error).message).toBe('Response has been aborted');

      expect(uWebSocketsResponseMocks).toHaveLength(0);
    });

    test('with body, with response send timeout, with stalling body', async () => {
      const handlers: Handlers = {};

      const body = new Readable({ read() {} });
      body.push('partial');

      const response = createResponse({ body });

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        corkMock((): HttpResponse => uWebSocketsResponse),
        { name: 'writeStatus', parameters: ['200 OK'], returnSelf: true },
        corkMock((): HttpResponse => uWebSocketsResponse),
        writeMock('partial', true),
        {
          name: 'close',
          callback: (): HttpResponse => {
            // uWebSockets.js calls the onAborted handler of a closed response
            handlers.aborted?.();

            return uWebSocketsResponse;
          },
        },
      ]);

      const responseToUWebSocketsResponseEmitter = createResponseToUWebSocketsResponseEmitter(50);

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      responseToUWebSocketsResponseEmitter(response, uWebSocketsResponse);

      // the timeout must not keep the process alive
      expect((setTimeoutSpy.mock.results[0].value as NodeJS.Timeout).hasRef()).toBe(false);

      setTimeoutSpy.mockRestore();

      await wait(100);

      expect(body.destroyed).toBe(true);

      expect(uWebSocketsResponseMocks).toHaveLength(0);
    });

    test('with body, with response send timeout, with body sent in time', async () => {
      const handlers: Handlers = {};

      const ended = Promise.withResolvers<undefined>();

      const response = createResponse({ body: Readable.from([Buffer.from('complete')]) });

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useObjectMock<HttpResponse>([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        corkMock((): HttpResponse => uWebSocketsResponse),
        { name: 'writeStatus', parameters: ['200 OK'], returnSelf: true },
        corkMock((): HttpResponse => uWebSocketsResponse),
        writeMock('complete', true),
        corkMock((): HttpResponse => uWebSocketsResponse),
        {
          name: 'end',
          callback: (): HttpResponse => {
            ended.resolve(undefined);

            return uWebSocketsResponse;
          },
        },
      ]);

      const responseToUWebSocketsResponseEmitter = createResponseToUWebSocketsResponseEmitter(50);

      responseToUWebSocketsResponseEmitter(response, uWebSocketsResponse);

      await ended.promise;

      // the response has been fully sent: the timeout gets cleared and must not close the response (a close call
      // would fail with a missing mock)
      await wait(100);

      expect(uWebSocketsResponseMocks).toHaveLength(0);
    });

    describe('with already aborted response', () => {
      test('with node stream body', () => {
        const { uWebSocketsResponse, uWebSocketsResponseMocks } = useAbortedResponse();

        const [body, bodyMocks] = useObjectMock<{ destroy: () => void } & Body>([
          // the type check, followed by the call
          { name: 'destroy', callback: () => undefined },
          { name: 'destroy', parameters: [] },
        ]);

        const responseToUWebSocketsResponseEmitter = createResponseToUWebSocketsResponseEmitter();

        // uWebSockets.js forbids touching an aborted response (a call would fail with a missing mock)
        responseToUWebSocketsResponseEmitter(createResponse({ body }), uWebSocketsResponse);

        expect(bodyMocks).toHaveLength(0);
        expect(uWebSocketsResponseMocks).toHaveLength(0);
      });

      test('with web stream body', () => {
        const { uWebSocketsResponse, uWebSocketsResponseMocks } = useAbortedResponse();

        const [body, bodyMocks] = useObjectMock<{ destroy?: () => void; cancel: () => Promise<void> } & Body>([
          { name: 'destroy', value: undefined },
          // the type check, followed by the call
          { name: 'cancel', callback: () => Promise.resolve() },
          { name: 'cancel', parameters: [], return: Promise.resolve() },
        ]);

        const responseToUWebSocketsResponseEmitter = createResponseToUWebSocketsResponseEmitter();

        responseToUWebSocketsResponseEmitter(createResponse({ body }), uWebSocketsResponse);

        expect(bodyMocks).toHaveLength(0);
        expect(uWebSocketsResponseMocks).toHaveLength(0);
      });

      test('with locked web stream body', async () => {
        const { uWebSocketsResponse, uWebSocketsResponseMocks } = useAbortedResponse();

        const [body, bodyMocks] = useObjectMock<{ destroy?: () => void; cancel: () => Promise<void> } & Body>([
          { name: 'destroy', value: undefined },
          // the type check, followed by the call
          { name: 'cancel', callback: () => Promise.resolve() },
          { name: 'cancel', callback: () => Promise.reject(new TypeError('Cannot cancel a locked stream')) },
        ]);

        const responseToUWebSocketsResponseEmitter = createResponseToUWebSocketsResponseEmitter();

        responseToUWebSocketsResponseEmitter(createResponse({ body }), uWebSocketsResponse);

        // the rejected cancel must not end up as an unhandled rejection
        await wait(0);

        expect(bodyMocks).toHaveLength(0);
        expect(uWebSocketsResponseMocks).toHaveLength(0);
      });

      test('with async generator body', () => {
        const { uWebSocketsResponse, uWebSocketsResponseMocks } = useAbortedResponse();

        const [body, bodyMocks] = useObjectMock<{ destroy?: () => void; cancel?: () => Promise<void> } & Body>([
          { name: 'destroy', value: undefined },
          { name: 'cancel', value: undefined },
        ]);

        const responseToUWebSocketsResponseEmitter = createResponseToUWebSocketsResponseEmitter();

        responseToUWebSocketsResponseEmitter(createResponse({ body }), uWebSocketsResponse);

        expect(bodyMocks).toHaveLength(0);
        expect(uWebSocketsResponseMocks).toHaveLength(0);
      });
    });
  });
});
