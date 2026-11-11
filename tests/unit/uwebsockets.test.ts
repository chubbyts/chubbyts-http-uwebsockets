/* oxlint-disable functional/immutable-data */

import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { describe, expect, test, vi } from 'vitest';
import type { HttpRequest, HttpResponse } from 'uWebSockets.js';
import { useFunctionMock } from '@chubbyts/chubbyts-function-mock/dist/function-mock';
import type { ObjectMocks } from '@chubbyts/chubbyts-function-mock/dist/object-mock';
import { useObjectMock } from '@chubbyts/chubbyts-function-mock/dist/object-mock';
import type { Body, Message, Response, Uri } from '@chubbyts/chubbyts-http-types/message';
import type { ServerRequestFactory, UriFactory } from '@chubbyts/chubbyts-http-types/message-factory';
import type { HeaderValue, RequestHelpers } from '@chubbyts/chubbyts-http-types/message-helper';
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
  // the implementation provides the optional withHeaders, otherwise the bridge falls back to withHeader per header
  withHeaders = false,
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

  const [requestHelpers, requestHelpersMocks] = useObjectMock<RequestHelpers>([
    // resolved once, when the bridge gets created
    {
      name: 'withHeaders',
      value: withHeaders
        ? <M extends Message>(message: M, headers: Readonly<Record<string, HeaderValue>>): M => {
            // set at once, grouped by name, in the order of the first occurrence
            expect(Object.entries(headers)).toEqual(expected?.headers ?? []);

            return {
              ...message,
              headers: { ...message.headers, ...(headers as Readonly<Record<string, ReadonlyArray<string>>>) },
            };
          }
        : undefined,
    },
    ...((expected
      ? [
          {
            name: 'withProtocolVersion',
            callback: (message, protocolVersion) => {
              expect(protocolVersion).toBe('1.1');

              return { ...message, protocolVersion };
            },
          },
          { name: 'withSignal', callback: (request, signal) => ({ ...request, signal }) },
          ...(withHeaders ? [] : (expected.headers ?? [])).map(
            ([expectedName, expectedValues]): ObjectMocks<RequestHelpers>[number] => ({
              name: 'withHeader',
              callback: (message, name, value) => {
                expect(name).toBe(expectedName);
                expect(value).toEqual(expectedValues);

                return { ...message, headers: { ...message.headers, [name]: value as ReadonlyArray<string> } };
              },
            }),
          ),
          ...(expected.withBody
            ? [
                {
                  name: 'withBody',
                  callback: (message, body) => ({ ...message, body }),
                } satisfies ObjectMocks<RequestHelpers>[number],
              ]
            : []),
        ]
      : []) satisfies ObjectMocks<RequestHelpers>),
  ]);

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

// with a body: the whole body at once (uWebSockets.js adds the content-length), without: the end of a streamed body
const endMock = (
  getResponse: () => HttpResponse,
  expected: string | undefined,
  ended: PromiseWithResolvers<undefined> | undefined = undefined,
): ObjectMocks<HttpResponse>[number] => ({
  name: 'end',
  callback: (...args: Array<unknown>): HttpResponse => {
    expect(args.map((chunk) => Buffer.from(chunk as Uint8Array).toString())).toEqual(
      expected !== undefined ? [expected] : [],
    );

    ended?.resolve(undefined);

    return getResponse();
  },
});

// uWebSockets.js allows arbitrary user data to be attached to a response (the bridge keeps its state there, symbol
// keyed): the object mock only verifies the method calls, the user data is kept aside
const useHttpResponseMock = (mocks: ObjectMocks<HttpResponse>): [HttpResponse, ObjectMocks<HttpResponse>] => {
  const [objectMock, objectMocks] = useObjectMock<HttpResponse>(mocks);

  const userData = new Map<symbol, unknown>();

  const uWebSocketsResponse = new Proxy(objectMock, {
    get: (target, name) => (typeof name === 'symbol' ? userData.get(name) : Reflect.get(target, name)),
    set: (_, name, value) => {
      if (typeof name !== 'symbol') {
        return false;
      }

      userData.set(name, value);

      return true;
    },
  });

  return [uWebSocketsResponse, objectMocks];
};

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

  const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
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
    test.each([false, true])('without body, with withHeaders %s', async (withHeaders) => {
      const handlers: Handlers = {};

      const [uWebSocketsRequest, uWebSocketsRequestMocks] = useObjectMock<HttpRequest>(
        requestMocks('get', '/path/to/route', 'key=value', [
          ['content-type', 'text/plain'],
          ['x-custom', 'value1'],
          ['x-custom', 'value2'],
          ['cookie', 'sessionId=abc123'],
          ['cookie', 'ui_lang=en-US'],
          ['authorization', 'Bearer token1'],
          // a valid token: must neither change the prototype of the headers nor get lost
          ['__proto__', 'value'],
        ]),
      );

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
      ]);

      // grouped by name, in the order of the first occurrence
      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks(
        {
          url: 'https://example.com/path/to/route?key=value',
          method: 'GET',
          headers: [
            ['content-type', ['text/plain']],
            ['x-custom', ['value1', 'value2']],
            ['cookie', ['sessionId=abc123', 'ui_lang=en-US']],
            ['authorization', ['Bearer token1']],
            ['__proto__', ['value']],
          ],
        },
        withHeaders,
      );

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
      expect(Object.getPrototypeOf(serverRequest.headers)).toBe(Object.prototype);
      expect(serverRequest.headers).toMatchInlineSnapshot(`
        {
          "__proto__": [
            "value",
          ],
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
      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
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
      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([]);

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

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
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

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
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

      // the handler waits for the body: receiving has not been paused, it does not get resumed (a resume call would
      // fail with a missing mock)
      const content = text(serverRequest.body);

      // no request body timeout is configured: a slow body must not lead to a closed response (a close call would
      // fail with a missing mock)
      await wait(50);

      handlers.data?.(toArrayBuffer('delayed'), true);

      expect(await content).toBe('delayed');

      expect(uWebSocketsRequestMocks).toHaveLength(0);
      expect(uWebSocketsResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });

    test('with body, with abort', async () => {
      const handlers: Handlers = {};

      const [uWebSocketsRequest, uWebSocketsRequestMocks] = useObjectMock<HttpRequest>(
        requestMocks('post', '/path/to/route', ''),
      );

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
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

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
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

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
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

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
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

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
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

      // receiving is not paused anymore: reading the next chunk does not resume it again (a resume call would fail
      // with a missing mock)
      handlers.data?.(toArrayBuffer('b'), false);

      await wait(10);

      // the last chunk does not pause anymore, even when exceeding the high water mark
      handlers.data?.(toArrayBuffer(largeChunk), true);

      expect(await content).toBe(largeChunk + 'b' + largeChunk);

      expect(uWebSocketsRequestMocks).toHaveLength(0);
      expect(uWebSocketsResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });

    test('with body, with request body max bytes, with too large content-length', async () => {
      const handlers: Handlers = {};

      const [uWebSocketsRequest, uWebSocketsRequestMocks] = useObjectMock<HttpRequest>(
        requestMocks('post', '/path/to/route', '', [['content-length', '11']]),
      );

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
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

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
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

    test.each([NaN, -1, -0.5, -Infinity])('with invalid request body max bytes %s', (requestBodyMaxBytes) => {
      const [uriFactory, uriFactoryMocks] = useFunctionMock<UriFactory>([]);
      const [serverRequestFactory, serverRequestFactoryMocks] = useFunctionMock<ServerRequestFactory>([]);
      const [requestHelpers, requestHelpersMocks] = useObjectMock<RequestHelpers>([]);

      expect(() =>
        createUWebSocketsRequestToServerRequestFactory(
          uriFactory,
          serverRequestFactory,
          requestHelpers,
          undefined,
          undefined,
          requestBodyMaxBytes,
        ),
      ).toThrow(`Request body max bytes "${requestBodyMaxBytes}" must be a non-negative number`);

      expect(uriFactoryMocks).toHaveLength(0);
      expect(serverRequestFactoryMocks).toHaveLength(0);
      expect(requestHelpersMocks).toHaveLength(0);
    });

    // accepted before the validation got added: kept for backward compatibility
    test.each([0, 1.5, Infinity])('with valid request body max bytes %s', (requestBodyMaxBytes) => {
      const [uriFactory, uriFactoryMocks] = useFunctionMock<UriFactory>([]);
      const [serverRequestFactory, serverRequestFactoryMocks] = useFunctionMock<ServerRequestFactory>([]);
      const [requestHelpers, requestHelpersMocks] = useObjectMock<RequestHelpers>([
        { name: 'withHeaders', value: undefined },
      ]);

      expect(
        createUWebSocketsRequestToServerRequestFactory(
          uriFactory,
          serverRequestFactory,
          requestHelpers,
          undefined,
          undefined,
          requestBodyMaxBytes,
        ),
      ).toBeTypeOf('function');

      expect(uriFactoryMocks).toHaveLength(0);
      expect(serverRequestFactoryMocks).toHaveLength(0);
      expect(requestHelpersMocks).toHaveLength(0);
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

      // the body provided within the current event loop turn gets sent along with the status and the headers at once
      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        corkMock((): HttpResponse => uWebSocketsResponse),
        { name: 'writeStatus', parameters: ['201 Created'], returnSelf: true },
        { name: 'writeHeader', parameters: ['content-type', 'application/json'], returnSelf: true },
        { name: 'writeHeader', parameters: ['set-cookie', 'key1=value1; Path=/'], returnSelf: true },
        { name: 'writeHeader', parameters: ['set-cookie', 'key2=value2; Path=/'], returnSelf: true },
        endMock((): HttpResponse => uWebSocketsResponse, '{"name":"test"}', ended),
      ]);

      const responseToUWebSocketsResponseEmitter = createResponseToUWebSocketsResponseEmitter();

      responseToUWebSocketsResponseEmitter(response, uWebSocketsResponse);

      await ended.promise;

      // the streaming does not start afterwards (a cork call would fail with a missing mock)
      await wait(50);

      expect(uWebSocketsResponseMocks).toHaveLength(0);
    });

    test('with async generator body', async () => {
      const handlers: Handlers = {};

      const ended = Promise.withResolvers<undefined>();

      const response = createResponse({
        body: (async function* () {
          yield new TextEncoder().encode('chunk1');
          yield new TextEncoder().encode('chunk2');
        })(),
      });

      // the chunks provided within the current event loop turn (resolved promises) get sent at once
      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        corkMock((): HttpResponse => uWebSocketsResponse),
        { name: 'writeStatus', parameters: ['200 OK'], returnSelf: true },
        endMock((): HttpResponse => uWebSocketsResponse, 'chunk1chunk2', ended),
      ]);

      createResponseToUWebSocketsResponseEmitter()(response, uWebSocketsResponse);

      await ended.promise;

      expect(uWebSocketsResponseMocks).toHaveLength(0);
    });

    test('with streamed body, with backpressure', async () => {
      const handlers: Handlers = {};

      const ended = Promise.withResolvers<undefined>();

      const response = createResponse({
        headers: { 'content-type': ['text/plain'] },
        body: (async function* () {
          yield new TextEncoder().encode('chunk1');
          await wait(10);
          yield new TextEncoder().encode('chunk2');
        })(),
      });

      // a body taking longer than the current event loop turn gets streamed: the status, the headers and the chunks
      // collected so far get sent at once, the remaining chunks on their own
      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        corkMock((): HttpResponse => uWebSocketsResponse),
        { name: 'writeStatus', parameters: ['200 OK'], returnSelf: true },
        { name: 'writeHeader', parameters: ['content-type', 'text/plain'], returnSelf: true },
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
        endMock((): HttpResponse => uWebSocketsResponse, undefined, ended),
      ]);

      const responseToUWebSocketsResponseEmitter = createResponseToUWebSocketsResponseEmitter();

      responseToUWebSocketsResponseEmitter(response, uWebSocketsResponse);

      // the body is paused until the client is able to receive more data
      await wait(30);

      expect(uWebSocketsResponseMocks).toHaveLength(4);

      expect(handlers.writable?.(0)).toBe(true);

      await ended.promise;

      expect(uWebSocketsResponseMocks).toHaveLength(0);
    });

    test.each([
      // up to the limit the body gets collected and sent at once
      [[32 * 1024, 32 * 1024], false],
      // a larger body gets streamed right away, without waiting for the end of the current event loop turn
      [[32 * 1024, 32 * 1024 + 1], true],
    ])('with large body, with chunk sizes %j', async (sizes, streamed) => {
      const handlers: Handlers = {};

      const ended = Promise.withResolvers<undefined>();

      const chunks = sizes.map((size, i) => Buffer.alloc(size, String(i)));

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        corkMock((): HttpResponse => uWebSocketsResponse),
        { name: 'writeStatus', parameters: ['200 OK'], returnSelf: true },
        ...(streamed
          ? [
              writeMock(chunks[0].toString(), true),
              writeMock(chunks[1].toString(), true),
              corkMock((): HttpResponse => uWebSocketsResponse),
              endMock((): HttpResponse => uWebSocketsResponse, undefined, ended),
            ]
          : [endMock((): HttpResponse => uWebSocketsResponse, Buffer.concat(chunks).toString(), ended)]),
      ]);

      // the end of the body follows within the same event loop turn: it does not change how the body gets sent
      createResponseToUWebSocketsResponseEmitter()(
        createResponse({ body: Readable.from(chunks) }),
        uWebSocketsResponse,
      );

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
      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
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
      [200, 'OK'],
      [999, 'Custom'],
    ])('with valid response status %d', async (status, reasonPhrase) => {
      const handlers: Handlers = {};

      const ended = Promise.withResolvers<undefined>();

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        corkMock((): HttpResponse => uWebSocketsResponse),
        { name: 'writeStatus', parameters: [`${status} ${reasonPhrase}`], returnSelf: true },
        endMock((): HttpResponse => uWebSocketsResponse, '', ended),
      ]);

      createResponseToUWebSocketsResponseEmitter()(
        createResponse({ status, reasonPhrase, body: Readable.from([]) }),
        uWebSocketsResponse,
      );

      await ended.promise;

      expect(uWebSocketsResponseMocks).toHaveLength(0);
    });

    test.each([
      ['get', true],
      ['head', false],
    ])('with response to %s request', async (method, withContent) => {
      const handlers: Handlers = {};

      const ended = Promise.withResolvers<undefined>();

      const [uWebSocketsRequest] = useObjectMock<HttpRequest>(requestMocks(method, '/', ''));

      const body = Readable.from([Buffer.from('content')]);

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        corkMock((): HttpResponse => uWebSocketsResponse),
        { name: 'writeStatus', parameters: ['200 OK'], returnSelf: true },
        // the content-length of the handler does not get written, for HEAD it gets reported by uWebSockets.js
        { name: 'writeHeader', parameters: ['content-type', 'text/plain'], returnSelf: true },
        withContent
          ? endMock((): HttpResponse => uWebSocketsResponse, 'content', ended)
          : {
              name: 'endWithoutBody',
              callback: (...args: Array<unknown>): HttpResponse => {
                expect(args).toEqual([7]);

                ended.resolve(undefined);

                return uWebSocketsResponse;
              },
            },
      ]);

      const { uriFactory, serverRequestFactory, requestHelpers } = useImplementationMocks({
        url: 'http://127.0.0.1/',
        method: method.toUpperCase(),
      });

      createUWebSocketsRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
      )(uWebSocketsRequest, uWebSocketsResponse);

      createResponseToUWebSocketsResponseEmitter()(
        createResponse({ headers: { 'content-type': ['text/plain'], 'content-length': ['7'] }, body }),
        uWebSocketsResponse,
      );

      await ended.promise;

      // the body of a response without content does not get read but cancelled
      expect(body.destroyed).toBe(true);
      expect(body.readableEnded).toBe(withContent);

      expect(uWebSocketsResponseMocks).toHaveLength(0);
    });

    test.each([
      // a 1xx or 204 response must not have a content-length (RFC 9110 8.6)
      [100, 'Continue', { 'content-length': ['42'] }, undefined],
      [199, 'Custom', { 'content-length': ['42'] }, undefined],
      [204, 'No Content', { 'content-length': ['42'] }, undefined],
      // a 304 response may announce the content-length of the GET response
      [304, 'Not Modified', { 'content-length': ['42'] }, 42],
      [304, 'Not Modified', { 'Content-Length': ['0'] }, 0],
      [304, 'Not Modified', { 'content-length': ['9007199254740991'] }, 9007199254740991],
      [304, 'Not Modified', {}, undefined],
      [304, 'Not Modified', { 'content-length': [] }, undefined],
      [304, 'Not Modified', { 'content-length': ['42', '42'] }, undefined],
      [304, 'Not Modified', { 'content-length': ['4 2'] }, undefined],
      [304, 'Not Modified', { 'content-length': ['42a'] }, undefined],
      [304, 'Not Modified', { 'content-length': ['a42'] }, undefined],
      [304, 'Not Modified', { 'content-length': ['-1'] }, undefined],
      [304, 'Not Modified', { 'content-length': ['1.5'] }, undefined],
      [304, 'Not Modified', { 'content-length': ['1e3'] }, undefined],
      [304, 'Not Modified', { 'content-length': ['0x2A'] }, undefined],
      [304, 'Not Modified', { 'content-length': [' 42'] }, undefined],
      [304, 'Not Modified', { 'content-length': ['42 '] }, undefined],
      [304, 'Not Modified', { 'content-length': [''] }, undefined],
      [304, 'Not Modified', { 'content-length': ['9007199254740992'] }, undefined],
    ])(
      'with response without content, with status %d, with headers %j',
      async (status, reasonPhrase, headers, reportedContentLength) => {
        const handlers: Handlers = {};

        const body = new Readable({ read() {} });

        const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
          onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
          corkMock((): HttpResponse => uWebSocketsResponse),
          { name: 'writeStatus', parameters: [`${status} ${reasonPhrase}`], returnSelf: true },
          { name: 'writeHeader', parameters: ['etag', '"abc"'], returnSelf: true },
          // the content-length header gets written by uWebSockets.js only, an explicit undefined would make it report
          // a content-length of 2^63
          {
            name: 'endWithoutBody',
            parameters: reportedContentLength !== undefined ? [reportedContentLength] : [],
            returnSelf: true,
          },
        ]);

        createResponseToUWebSocketsResponseEmitter(50)(
          createResponse({ status, reasonPhrase, headers: { etag: ['"abc"'], ...headers }, body }),
          uWebSocketsResponse,
        );

        // no timeout gets started (a close call would fail with a missing mock)
        await wait(100);

        expect(body.destroyed).toBe(true);

        expect(uWebSocketsResponseMocks).toHaveLength(0);
      },
    );

    test('with framing headers set by the handler', async () => {
      const handlers: Handlers = {};

      const ended = Promise.withResolvers<undefined>();

      const response = createResponse({
        headers: {
          'content-length': ['999'],
          'Content-Length': ['999'],
          'content-type': ['text/plain'],
          'transfer-encoding': ['chunked'],
          'Transfer-Encoding': ['gzip, chunked'],
        },
        body: Readable.from([Buffer.from('content')]),
      });

      // uWebSockets.js writes the framing headers itself: the ones of the handler would be duplicated or conflicting
      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        corkMock((): HttpResponse => uWebSocketsResponse),
        { name: 'writeStatus', parameters: ['200 OK'], returnSelf: true },
        { name: 'writeHeader', parameters: ['content-type', 'text/plain'], returnSelf: true },
        endMock((): HttpResponse => uWebSocketsResponse, 'content', ended),
      ]);

      createResponseToUWebSocketsResponseEmitter()(response, uWebSocketsResponse);

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

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        corkMock((): HttpResponse => uWebSocketsResponse),
        { name: 'writeStatus', parameters: ['599 Custom \tR\u00e9ason'], returnSelf: true },
        { name: 'writeHeader', parameters: ["!#$%&'*+-.^_`|~09AZaz", ''], returnSelf: true },
        { name: 'writeHeader', parameters: ["!#$%&'*+-.^_`|~09AZaz", 'tab\tvalue \u00ff'], returnSelf: true },
        endMock((): HttpResponse => uWebSocketsResponse, '', ended),
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
      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
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

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
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

    test.each([
      // nothing has been sent yet, but the emitter already returned: the caller cannot respond anymore
      ['collected', 0],
      // an already started response cannot signal a failure anymore
      ['streamed', 10],
    ])('with %s body, with body error', async (_, delay) => {
      const handlers: Handlers = {};

      const closed = Promise.withResolvers<undefined>();

      const response = createResponse({
        body: (async function* () {
          yield new TextEncoder().encode('partial');

          if (delay > 0) {
            await wait(delay);
          }

          throw new Error('upstream failed');
        })(),
      });

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        ...(delay > 0
          ? [
              corkMock((): HttpResponse => uWebSocketsResponse),
              {
                name: 'writeStatus',
                parameters: ['200 OK'],
                returnSelf: true,
              } satisfies ObjectMocks<HttpResponse>[number],
              writeMock('partial', true),
            ]
          : []),
        {
          name: 'close',
          callback: (): HttpResponse => {
            closed.resolve(undefined);

            // uWebSockets.js calls the onAborted handler of a closed response
            handlers.aborted?.();

            return uWebSocketsResponse;
          },
        },
      ]);

      // the response send timeout gets cleared: it must not close the response again (a close call would fail with a
      // missing mock)
      createResponseToUWebSocketsResponseEmitter(50)(response, uWebSocketsResponse);

      // the response does not get ended as if it was complete: the connection gets closed
      await closed.promise;

      await wait(100);

      expect(uWebSocketsResponseMocks).toHaveLength(0);
    });

    test('with large body, ending after the current event loop turn', async () => {
      const handlers: Handlers = {};

      const ended = Promise.withResolvers<undefined>();

      const body = new Readable({ read() {} });
      body.push(Buffer.alloc(64 * 1024 + 1, 'a'));

      // the streaming starts right away and only once (a second cork call would fail with a mismatch)
      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        corkMock((): HttpResponse => uWebSocketsResponse),
        { name: 'writeStatus', parameters: ['200 OK'], returnSelf: true },
        writeMock('a'.repeat(64 * 1024 + 1), true),
        corkMock((): HttpResponse => uWebSocketsResponse),
        endMock((): HttpResponse => uWebSocketsResponse, undefined, ended),
      ]);

      createResponseToUWebSocketsResponseEmitter()(createResponse({ body }), uWebSocketsResponse);

      await wait(20);

      expect(uWebSocketsResponseMocks).toHaveLength(2);

      body.push(null);

      await ended.promise;

      expect(uWebSocketsResponseMocks).toHaveLength(0);
    });

    test('with body, with abort', async () => {
      const handlers: Handlers = {};

      const body = new Readable({ read() {} });
      body.push('partial');

      const response = createResponse({ body });

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        corkMock((): HttpResponse => uWebSocketsResponse),
        { name: 'writeStatus', parameters: ['200 OK'], returnSelf: true },
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

    test.each([true, false])(
      'with body, destroying itself with emitting the error %s, with abort',
      async (emitsError) => {
        const handlers: Handlers = {};

        const body = new Readable({
          read() {},
          destroy(error, callback) {
            callback(emitsError ? error : null);
          },
        });
        body.on('error', () => {});
        body.push('partial');

        // the abort happens before the streaming started
        const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
          onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        ]);

        createResponseToUWebSocketsResponseEmitter(50)(createResponse({ body }), uWebSocketsResponse);

        // uWebSockets.js forbids touching an aborted response: the streaming must not start (a cork call would fail
        // with a missing mock)
        handlers.aborted?.();

        await wait(100);

        expect(body.destroyed).toBe(true);

        expect(uWebSocketsResponseMocks).toHaveLength(0);
      },
    );

    test.each([true, false])(
      'with streamed body, destroying itself with emitting the error %s, with abort',
      async (emitsError) => {
        const handlers: Handlers = {};

        const body = new Readable({
          read() {},
          destroy(error, callback) {
            callback(emitsError ? error : null);
          },
        });
        body.on('error', () => {});
        body.push('partial');

        const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
          onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
          corkMock((): HttpResponse => uWebSocketsResponse),
          { name: 'writeStatus', parameters: ['200 OK'], returnSelf: true },
          writeMock('partial', true),
        ]);

        createResponseToUWebSocketsResponseEmitter(50)(createResponse({ body }), uWebSocketsResponse);

        await wait(20);

        // the response send timeout must not close the aborted response (a close call would fail with a missing mock)
        handlers.aborted?.();

        await wait(100);

        expect(body.destroyed).toBe(true);

        expect(uWebSocketsResponseMocks).toHaveLength(0);
      },
    );

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

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        corkMock((): HttpResponse => uWebSocketsResponse),
        { name: 'writeStatus', parameters: ['200 OK'], returnSelf: true },
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

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        corkMock((): HttpResponse => uWebSocketsResponse),
        { name: 'writeStatus', parameters: ['200 OK'], returnSelf: true },
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

      // the timeout gets started with the streaming
      await wait(20);

      const timeoutIndex = setTimeoutSpy.mock.calls.findIndex(([, ms]) => ms === 50);

      // the timeout must not keep the process alive
      expect((setTimeoutSpy.mock.results[timeoutIndex].value as NodeJS.Timeout).hasRef()).toBe(false);

      setTimeoutSpy.mockRestore();

      await wait(100);

      expect(body.destroyed).toBe(true);

      expect(uWebSocketsResponseMocks).toHaveLength(0);
    });

    test('with body, with response send timeout, with body sent at once', async () => {
      const handlers: Handlers = {};

      const ended = Promise.withResolvers<undefined>();

      const response = createResponse({ body: Readable.from([Buffer.from('complete')]) });

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        corkMock((): HttpResponse => uWebSocketsResponse),
        { name: 'writeStatus', parameters: ['200 OK'], returnSelf: true },
        endMock((): HttpResponse => uWebSocketsResponse, 'complete', ended),
      ]);

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      createResponseToUWebSocketsResponseEmitter(50)(response, uWebSocketsResponse);

      await ended.promise;

      // a body sent at once does not need a timeout
      expect(setTimeoutSpy).not.toHaveBeenCalled();

      setTimeoutSpy.mockRestore();

      expect(uWebSocketsResponseMocks).toHaveLength(0);
    });

    test('with streamed body, with response send timeout, with body sent in time', async () => {
      const handlers: Handlers = {};

      const ended = Promise.withResolvers<undefined>();

      const body = new Readable({ read() {} });
      body.push('partial');

      const [uWebSocketsResponse, uWebSocketsResponseMocks] = useHttpResponseMock([
        onAbortedMock(handlers, (): HttpResponse => uWebSocketsResponse),
        corkMock((): HttpResponse => uWebSocketsResponse),
        { name: 'writeStatus', parameters: ['200 OK'], returnSelf: true },
        writeMock('partial', true),
        corkMock((): HttpResponse => uWebSocketsResponse),
        writeMock('complete', true),
        corkMock((): HttpResponse => uWebSocketsResponse),
        endMock((): HttpResponse => uWebSocketsResponse, undefined, ended),
      ]);

      createResponseToUWebSocketsResponseEmitter(50)(createResponse({ body }), uWebSocketsResponse);

      await wait(20);

      body.push('complete');
      body.push(null);

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
