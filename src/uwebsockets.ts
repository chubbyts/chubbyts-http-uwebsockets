import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { HttpRequest, HttpResponse } from 'uWebSockets.js';
import type { Body, Response, ServerRequest } from '@chubbyts/chubbyts-http-types/message';
import type { ServerRequestFactory, UriFactory } from '@chubbyts/chubbyts-http-types/message-factory';
import type { RequestHelpers } from '@chubbyts/chubbyts-http-types/message-helper';

const noop = (): void => {};

// credentials are singleton fields (RFC 9110 5.5): duplicates cannot be combined, a middleware
// joining the values with ', ' (getHeaderLine) would confuse downstream auth parsing
const singletonHeaderNames = new Set(['authorization', 'proxy-authorization']);

// uWebSockets.js does not expose the http version of a request, it speaks HTTP/1.1
const protocolVersion = '1.1';

// uWebSockets.js writes the status line and the header lines as is: a CR or LF within a value written to it would
// allow response splitting, field-name is a token (RFC 9110 5.1), field-value (RFC 9110 5.5) and reason-phrase
// (RFC 9112 4) consist of visible characters, space, HTAB and obs-text only
const tokenPattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const fieldValuePattern = /^[\t\x20-\x7e\x80-\xff]*$/;

// uWebSockets.js writes the framing headers itself (content-length, or transfer-encoding chunked while streaming):
// ones set by the handler would end up duplicated or conflicting (content-length next to chunked), letting a proxy
// and the client disagree about where the response ends (request smuggling, RFC 9112 6.1 and 6.3)
const framingHeaderNames = new Set(['content-length', 'transfer-encoding']);

// RFC 9110 8.6: a content-length announces the size of a GET response for HEAD or 304, a decimal number
const contentLengthPattern = /^\d+$/;

// a response body collected within the current event loop turn up to this size gets sent at once (with a
// content-length), a larger one gets streamed
const batchMaxBytes = 64 * 1024;

// the emitter does not know the request: the request factory flags the responses of HEAD requests
type AbortState = { aborted: boolean; head: boolean; readonly listeners: Array<() => void> };

// uWebSockets.js creates a response per request and allows arbitrary user data to be attached to it: the state lives
// on the response, a WeakMap keyed by the response would cost the garbage collector (ephemerons) a quarter of the
// throughput. A symbol does not collide with the properties of the response or the ones of other user data.
const abortStateKey = Symbol('@chubbyts/chubbyts-http-uwebsockets/abort-state');

type HttpResponseWithAbortState = HttpResponse & { [abortStateKey]?: AbortState };

// uWebSockets.js supports only a single onAborted callback per response, but the request
// factory and the response emitter both need to observe the abort: register it once and
// fan out to all interested listeners
const getAbortState = (uWebSocketsResponse: HttpResponseWithAbortState): AbortState => {
  const existingState = uWebSocketsResponse[abortStateKey];

  if (existingState) {
    return existingState;
  }

  const state: AbortState = { aborted: false, head: false, listeners: [] };

  // oxlint-disable-next-line functional/immutable-data
  uWebSocketsResponse[abortStateKey] = state;

  uWebSocketsResponse.onAborted(() => {
    // oxlint-disable-next-line functional/immutable-data
    state.aborted = true;
    state.listeners.forEach((listener) => listener());
  });

  return state;
};

const addAbortListener = (state: AbortState, listener: () => void): void => {
  if (state.aborted) {
    listener();

    return;
  }

  // oxlint-disable-next-line functional/immutable-data
  state.listeners.push(listener);
};

const resolveUrl = (pathAndQuery: string, origin: string, basePath: string): string => {
  const url = new URL(basePath + pathAndQuery, origin);

  // protocol-relative ('//evil.com/path') and backslash ('/\evil.com/path') targets resolve
  // to a different host than the base url and must not be trusted
  if (url.origin !== origin) {
    throw new Error(
      `Request target "${pathAndQuery}" resolves to origin "${url.origin}" instead of the expected origin "${origin}"`,
    );
  }

  return url.href;
};

// the base url gets parsed once, not per request (its origin is a getter, building the string on every access)
const createUrlResolver = (baseUrl: string | undefined): ((uWebSocketsRequest: HttpRequest) => string) => {
  const { origin, pathname } = new URL(baseUrl ?? 'http://127.0.0.1');
  const basePath = pathname.replace(/\/$/, '');

  return (uWebSocketsRequest: HttpRequest): string => {
    const query = uWebSocketsRequest.getQuery();
    const pathAndQuery = uWebSocketsRequest.getUrl() + (query ? `?${query}` : '');

    // only origin-form request targets can be safely appended after a host: absolute-form
    // ('http://evil.com/path'), authority-form and asterisk-form targets would end up within
    // the authority part of the built url and allow host spoofing
    if (!pathAndQuery.startsWith('/')) {
      throw new Error(
        `Unsupported request target "${pathAndQuery}": only origin-form (starting with "/") is supported`,
      );
    }

    return resolveUrl(pathAndQuery, origin, basePath);
  };
};

export const getUrl = (uWebSocketsRequest: HttpRequest, baseUrl: string | undefined = undefined): string =>
  createUrlResolver(baseUrl)(uWebSocketsRequest);

const uWebSocketsRequestToHeaders = (uWebSocketsRequest: HttpRequest): Map<string, Array<string>> => {
  // a map instead of an object: a header named '__proto__' must not change the prototype
  const headers = new Map<string, Array<string>>();

  // uWebSockets.js provides the header names lowercased
  uWebSocketsRequest.forEach((name, value) => {
    const values = headers.get(name);

    if (!values) {
      headers.set(name, [value]);

      return;
    }

    if (singletonHeaderNames.has(name)) {
      throw new Error(`Request contains multiple "${name}" headers`);
    }

    // duplicate headers (cookie included) are kept as separate values, the helpers decide how to combine them
    // oxlint-disable-next-line functional/immutable-data
    values.push(value);
  });

  return headers;
};

const getBody = (
  uWebSocketsResponse: HttpResponse,
  abortState: AbortState,
  contentLength: string | undefined,
  requestBodyTimeoutMs: number | undefined,
  requestBodyMaxBytes: number | undefined,
): Body => {
  const received = { bytes: 0, paused: false };

  // a readable fed by onData instead of a passthrough: a passthrough is a writable and a readable, each chunk passes
  // both sides. Reading the body resumes the receiving paused on backpressure.
  const body = new Readable({
    read: () => {
      if (received.paused) {
        // oxlint-disable-next-line functional/immutable-data
        received.paused = false;
        uWebSocketsResponse.resume();
      }
    },
  });

  // a client abort / timeout must not surface as an unhandled 'error' event;
  // iterating the body still rejects with the error
  body.on('error', noop);

  // a disconnecting client would otherwise leave the body open forever: a pending
  // read of the request body has to fail instead of hanging
  addAbortListener(abortState, () => {
    body.destroy(new Error('Request has been aborted'));
  });

  // the error reaches the handler while iterating the body, the connection gets closed as the client would
  // otherwise keep on sending the body
  const failBody = (error: Error): void => {
    body.destroy(error);

    if (!abortState.aborted) {
      uWebSocketsResponse.close();
    }
  };

  // no limit configured: the comparisons below never match
  const maxBytes = requestBodyMaxBytes ?? Infinity;

  const maxBytesError = (): Error => new Error(`Request body exceeds the maximum of ${requestBodyMaxBytes} bytes`);

  // uWebSockets.js does not limit the body size itself: a declared too large body gets rejected before reading it
  if (Number(contentLength) > maxBytes) {
    failBody(maxBytesError());

    return body;
  }

  // slowloris protection: a client sending the body arbitrarily slow would otherwise keep the
  // request (and its socket) alive forever
  const timeout =
    requestBodyTimeoutMs !== undefined
      ? setTimeout(() => {
          failBody(new Error(`Request body has not been fully received within ${requestBodyTimeoutMs}ms`));
        }, requestBodyTimeoutMs).unref()
      : undefined;

  uWebSocketsResponse.onData((chunk: ArrayBuffer, isLast: boolean) => {
    // oxlint-disable-next-line functional/immutable-data
    received.bytes += chunk.byteLength;

    // a chunked body (or one with a wrong content-length) is limited while receiving it
    if (received.bytes > maxBytes) {
      clearTimeout(timeout);
      failBody(maxBytesError());

      return;
    }

    // uWebSockets.js reuses the chunk memory after the callback: copy it; push returns false on backpressure:
    // pause receiving until the handler consumed the buffered data, otherwise a fast client could fill the memory
    // oxlint-disable-next-line functional/immutable-data
    if (!body.push(Buffer.from(new Uint8Array(chunk))) && !isLast) {
      // oxlint-disable-next-line functional/immutable-data
      received.paused = true;
      uWebSocketsResponse.pause();
    }

    if (isLast) {
      clearTimeout(timeout);
      // oxlint-disable-next-line functional/immutable-data
      body.push(null);
    }
  });

  // a readable already is an AsyncIterable<Buffer>
  return body;
};

type UWebSocketsRequestToServerRequestFactory = (
  uWebSocketsRequest: HttpRequest,
  uWebSocketsResponse: HttpResponse,
) => ServerRequest;

export const createUWebSocketsRequestToServerRequestFactory = (
  uriFactory: UriFactory,
  serverRequestFactory: ServerRequestFactory,
  requestHelpers: RequestHelpers,
  baseUrl: string | undefined = undefined,
  requestBodyTimeoutMs: number | undefined = undefined,
  requestBodyMaxBytes: number | undefined = undefined,
): UWebSocketsRequestToServerRequestFactory => {
  // fail fast: NaN would silently disable the limit (every comparison with it is false), a negative limit would
  // reject every body (even an empty one)
  if (Number.isNaN(requestBodyMaxBytes) || (requestBodyMaxBytes ?? 0) < 0) {
    throw new Error(`Request body max bytes "${requestBodyMaxBytes}" must be a non-negative number`);
  }

  const resolveRequestUrl = createUrlResolver(baseUrl);

  // optional (chubbyts-http-types 4.3): sets all headers copying the server request once, withHeader would copy it
  // (with all headers set so far) once per header; resolved once, the helpers do not change
  const withHeaders = requestHelpers.withHeaders?.bind(requestHelpers);

  return (uWebSocketsRequest: HttpRequest, uWebSocketsResponse: HttpResponse): ServerRequest => {
    const method = uWebSocketsRequest.getMethod().toUpperCase();
    const headers = uWebSocketsRequestToHeaders(uWebSocketsRequest);
    const uri = uriFactory(resolveRequestUrl(uWebSocketsRequest));

    const abortState = getAbortState(uWebSocketsResponse);

    if (method === 'HEAD') {
      // oxlint-disable-next-line functional/immutable-data
      abortState.head = true;
    }

    const abortController = new AbortController();

    addAbortListener(abortState, () => {
      abortController.abort();
    });

    // created and changed through the injected implementation only: the bridge works with any of them
    const createdServerRequest = requestHelpers.withProtocolVersion(serverRequestFactory(method, uri), protocolVersion);

    const serverRequestWithSignal = requestHelpers.withSignal(createdServerRequest, abortController.signal);

    // Object.fromEntries defines own properties: a header named '__proto__' does not change the prototype
    const serverRequest = withHeaders
      ? withHeaders(serverRequestWithSignal, Object.fromEntries(headers))
      : [...headers].reduce(
          (request, [name, values]) => requestHelpers.withHeader(request, name, values),
          serverRequestWithSignal,
        );

    // the body of a GET or HEAD request gets ignored: the server request keeps the (empty) body of the factory
    if (method === 'GET' || method === 'HEAD') {
      return serverRequest;
    }

    return requestHelpers.withBody(
      serverRequest,
      getBody(
        uWebSocketsResponse,
        abortState,
        headers.get('content-length')?.[0],
        requestBodyTimeoutMs,
        requestBodyMaxBytes,
      ),
    );
  };
};

// a not yet iterated body cannot be cancelled through its async iterator (returning an unstarted
// async generator skips its cleanup): node streams get destroyed, web streams cancelled
const cancelBody = (body: Body): void => {
  const cancellableBody = body as Partial<{ destroy: () => void; cancel: () => Promise<void> }>;

  if (typeof cancellableBody.destroy === 'function') {
    cancellableBody.destroy();
  } else if (typeof cancellableBody.cancel === 'function') {
    cancellableBody.cancel().catch(() => {});
  }
};

// a readable to be able to pause on backpressure and to stop the body on abort: wrapping a node or web stream with
// Readable.from would not stop it, a pending read blocks the return of its async iterator
const bodyToReadable = (body: Body): Readable => {
  if (body instanceof Readable) {
    return body;
  }

  if (body instanceof ReadableStream) {
    return Readable.fromWeb(body as NodeReadableStream);
  }

  return Readable.from(body);
};

const getInvalidResponseReason = (response: Response): string | undefined => {
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 999) {
    return `Invalid response status "${response.status}"`;
  }

  if (!fieldValuePattern.test(response.reasonPhrase)) {
    return 'Invalid response reason phrase';
  }

  const { headers } = response;

  const invalidHeaderName = Object.keys(headers).find(
    (name) => !tokenPattern.test(name) || headers[name].some((value) => !fieldValuePattern.test(value)),
  );

  // the value is not part of the reason: it may contain the injected content
  return invalidHeaderName !== undefined ? `Invalid response header "${invalidHeaderName}"` : undefined;
};

// RFC 9112 6.3: the response to a HEAD request and a 1xx, 204 or 304 response end with the header section, any byte
// sent as body would be read as the start of the next response
const hasNoContent = (response: Response, abortState: AbortState): boolean =>
  abortState.head || response.status < 200 || response.status === 204 || response.status === 304;

// RFC 9110 8.6: a 1xx or 204 response must not have a content-length, a HEAD or 304 response may announce the one of
// the GET response, which is taken from the handler if it is a single valid one
const getReportedContentLength = (response: Response): number | undefined => {
  if (response.status < 200 || response.status === 204) {
    return undefined;
  }

  const values = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'content-length')?.[1];

  if (values?.length !== 1 || !contentLengthPattern.test(values[0])) {
    return undefined;
  }

  const contentLength = Number(values[0]);

  return Number.isSafeInteger(contentLength) ? contentLength : undefined;
};

const writeStatusAndHeaders = (response: Response, uWebSocketsResponse: HttpResponse): void => {
  uWebSocketsResponse.writeStatus(`${response.status} ${response.reasonPhrase}`);

  const { headers } = response;

  for (const name of Object.keys(headers)) {
    if (!framingHeaderNames.has(name.toLowerCase())) {
      // every value gets its own header line, which is required for set-cookie (RFC 6265 3)
      for (const value of headers[name]) {
        uWebSocketsResponse.writeHeader(name, value);
      }
    }
  }
};

// close() triggers the abort listener, which stops the body
const closeResponse = (uWebSocketsResponse: HttpResponse): void => {
  uWebSocketsResponse.close();
};

// every cork sends what has been written within it: the chunks the body provides within the current event loop turn
// (e.g. a body created from a string) get collected and sent along with the status and the headers at once, with a
// content-length instead of chunked. Only a body taking longer (or getting larger) gets streamed.
const sendBody = (
  response: Response,
  body: Readable,
  uWebSocketsResponse: HttpResponse,
  abortState: AbortState,
  responseSendTimeoutMs: number | undefined,
): void => {
  // the collected chunks, until the streaming started
  const state: {
    chunks: Array<Uint8Array> | undefined;
    bytes: number;
    timeout: NodeJS.Timeout | undefined;
  } = { chunks: [], bytes: 0, timeout: undefined };

  const write = (chunk: Uint8Array): void => {
    // write returns false on backpressure: pause the body until the client is able to receive more data
    if (!uWebSocketsResponse.write(chunk)) {
      body.pause();

      uWebSocketsResponse.onWritable(() => {
        body.resume();

        return true;
      });
    }
  };

  const startStreaming = (chunks: Array<Uint8Array>): void => {
    // oxlint-disable-next-line functional/immutable-data
    state.chunks = undefined;

    // slowloris protection: a client reading the response arbitrarily slow (or a stalling response body) would
    // otherwise keep the response (and its socket) alive forever, a body provided within the current event loop turn
    // does not need one
    // oxlint-disable-next-line functional/immutable-data
    state.timeout =
      responseSendTimeoutMs !== undefined
        ? setTimeout(closeResponse, responseSendTimeoutMs, uWebSocketsResponse).unref()
        : undefined;

    uWebSocketsResponse.cork(() => {
      writeStatusAndHeaders(response, uWebSocketsResponse);
      chunks.forEach(write);
    });
  };

  // runs once the body had the chance to provide its chunks within the current event loop turn, gets cleared when the
  // streaming starts earlier: the chunks are still collected
  const immediate = setImmediate(() => startStreaming(state.chunks as Array<Uint8Array>));

  // a disconnecting client must stop the streaming: the body gets destroyed, uWebSockets.js forbids touching the
  // aborted response (cleared here as well, a body may destroy itself without emitting the error)
  addAbortListener(abortState, () => {
    clearImmediate(immediate);
    clearTimeout(state.timeout);
    body.destroy(new Error('Response has been aborted'));
  });

  body.on('data', (chunk: Uint8Array) => {
    const { chunks } = state;

    if (chunks === undefined) {
      uWebSocketsResponse.cork(() => write(chunk));

      return;
    }

    // oxlint-disable-next-line functional/immutable-data
    chunks.push(chunk);
    // oxlint-disable-next-line functional/immutable-data
    state.bytes += chunk.byteLength;

    // a large body does not get collected in the memory
    if (state.bytes > batchMaxBytes) {
      clearImmediate(immediate);
      startStreaming(chunks);
    }
  });

  // the response cannot signal a failure (anymore): close the connection instead of ending the response as if it was
  // complete, close() triggers the abort listener, which clears the immediate and the timeout
  body.on('error', () => {
    if (!abortState.aborted) {
      uWebSocketsResponse.close();
    }
  });

  body.on('end', () => {
    clearImmediate(immediate);
    clearTimeout(state.timeout);

    const { chunks } = state;

    uWebSocketsResponse.cork(() => {
      if (chunks === undefined) {
        uWebSocketsResponse.end();

        return;
      }

      writeStatusAndHeaders(response, uWebSocketsResponse);

      // the whole body at once: uWebSockets.js adds the content-length
      // Stryker disable next-line ConditionalExpression: concatenating a single chunk results in the same, only slower
      uWebSocketsResponse.end(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks));
    });
  });
};

type ResponseToUWebSocketsResponseEmitter = (response: Response, uWebSocketsResponse: HttpResponse) => void;

export const createResponseToUWebSocketsResponseEmitter = (
  responseSendTimeoutMs: number | undefined = undefined,
): ResponseToUWebSocketsResponseEmitter => {
  return (response: Response, uWebSocketsResponse: HttpResponse): void => {
    const abortState = getAbortState(uWebSocketsResponse);

    // the client may already be gone (uWebSockets.js forbids touching an aborted response):
    // cancel the potentially connection-backed body, nothing can be sent to the client anymore
    if (abortState.aborted) {
      cancelBody(response.body);

      return;
    }

    // thrown before anything has been written: the caller is still able to send an error response
    const invalidResponseReason = getInvalidResponseReason(response);

    if (invalidResponseReason !== undefined) {
      cancelBody(response.body);

      throw new Error(invalidResponseReason);
    }

    // the body (e.g. of a GET handler also serving HEAD) does not get sent: cancel it like an unsent one
    if (hasNoContent(response, abortState)) {
      cancelBody(response.body);

      const reportedContentLength = getReportedContentLength(response);

      uWebSocketsResponse.cork(() => {
        writeStatusAndHeaders(response, uWebSocketsResponse);

        // an explicit undefined would make uWebSockets.js report a content-length of 2^63
        if (reportedContentLength !== undefined) {
          uWebSocketsResponse.endWithoutBody(reportedContentLength);
        } else {
          uWebSocketsResponse.endWithoutBody();
        }
      });

      return;
    }

    const body = bodyToReadable(response.body);

    // a destroyed (e.g. errored) body does not emit any events anymore: the response would never end
    if (body.destroyed && !body.readableEnded) {
      throw new Error('Response body has already been destroyed');
    }

    // an already consumed body does not emit 'end' anymore
    if (body.readableEnded) {
      uWebSocketsResponse.cork(() => {
        writeStatusAndHeaders(response, uWebSocketsResponse);
        uWebSocketsResponse.end();
      });

      return;
    }

    sendBody(response, body, uWebSocketsResponse, abortState, responseSendTimeoutMs);
  };
};
