import { PassThrough, Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { HttpRequest, HttpResponse } from 'uWebSockets.js';
import type { Body, Response, ServerRequest } from '@chubbyts/chubbyts-http-types/message';
import type { ServerRequestFactory, UriFactory } from '@chubbyts/chubbyts-http-types/message-factory';
import type { RequestHelpers } from '@chubbyts/chubbyts-http-types/message-helper';

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

type AbortState = { aborted: boolean; listeners: Array<() => void> };

const abortStates = new WeakMap<HttpResponse, AbortState>();

// uWebSockets.js supports only a single onAborted callback per response, but the request
// factory and the response emitter both need to observe the abort: register it once and
// fan out to all interested listeners
const getAbortState = (uWebSocketsResponse: HttpResponse): AbortState => {
  const existingState = abortStates.get(uWebSocketsResponse);

  if (existingState) {
    return existingState;
  }

  const state: AbortState = { aborted: false, listeners: [] };

  abortStates.set(uWebSocketsResponse, state);

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

const resolveUrl = (pathAndQuery: string, parsedBase: URL, basePath: string): string => {
  const url = new URL(basePath + pathAndQuery, parsedBase.origin);

  // protocol-relative ('//evil.com/path') and backslash ('/\evil.com/path') targets resolve
  // to a different host than the base url and must not be trusted
  if (url.origin !== parsedBase.origin) {
    throw new Error(
      `Request target "${pathAndQuery}" resolves to origin "${url.origin}" instead of the expected origin "${parsedBase.origin}"`,
    );
  }

  return url.toString();
};

// the base url gets parsed once, not per request
const createUrlResolver = (baseUrl: string | undefined): ((uWebSocketsRequest: HttpRequest) => string) => {
  const parsedBase = new URL(baseUrl ?? 'http://127.0.0.1');
  const basePath = parsedBase.pathname.replace(/\/$/, '');

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

    return resolveUrl(pathAndQuery, parsedBase, basePath);
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
  const passthrough = new PassThrough();

  // a client abort / timeout must not surface as an unhandled 'error' event;
  // iterating the body still rejects with the error
  passthrough.on('error', () => {});

  // a disconnecting client would otherwise leave the passthrough open forever: a pending
  // read of the request body has to fail instead of hanging
  addAbortListener(abortState, () => {
    passthrough.destroy(new Error('Request has been aborted'));
  });

  // the error reaches the handler while iterating the body, the connection gets closed as the client would
  // otherwise keep on sending the body
  const failBody = (error: Error): void => {
    passthrough.destroy(error);

    if (!abortState.aborted) {
      uWebSocketsResponse.close();
    }
  };

  const maxBytesError = (): Error => new Error(`Request body exceeds the maximum of ${requestBodyMaxBytes} bytes`);

  // uWebSockets.js does not limit the body size itself: a declared too large body gets rejected before reading it
  if (requestBodyMaxBytes !== undefined && Number(contentLength) > requestBodyMaxBytes) {
    failBody(maxBytesError());

    return passthrough;
  }

  // slowloris protection: a client sending the body arbitrarily slow would otherwise keep the
  // request (and its socket) alive forever
  const timeout =
    requestBodyTimeoutMs !== undefined
      ? setTimeout(() => {
          failBody(new Error(`Request body has not been fully received within ${requestBodyTimeoutMs}ms`));
        }, requestBodyTimeoutMs)
      : undefined;

  timeout?.unref();

  const received = { bytes: 0 };

  uWebSocketsResponse.onData((chunk: ArrayBuffer, isLast: boolean) => {
    // oxlint-disable-next-line functional/immutable-data
    received.bytes += chunk.byteLength;

    // a chunked body (or one with a wrong content-length) is limited while receiving it
    if (requestBodyMaxBytes !== undefined && received.bytes > requestBodyMaxBytes) {
      clearTimeout(timeout);
      failBody(maxBytesError());

      return;
    }

    // uWebSockets.js reuses the chunk memory after the callback: copy it; write returns false on backpressure:
    // pause receiving until the handler consumed the buffered data, otherwise a fast client could fill the memory
    if (!passthrough.write(Buffer.from(new Uint8Array(chunk))) && !isLast) {
      uWebSocketsResponse.pause();

      // an abort destroys the passthrough: 'drain' is not emitted for an aborted response
      passthrough.once('drain', () => {
        uWebSocketsResponse.resume();
      });
    }

    if (isLast) {
      clearTimeout(timeout);
      passthrough.end();
    }
  });

  // a PassThrough already is an AsyncIterable<Buffer>
  return passthrough;
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
  const resolveRequestUrl = createUrlResolver(baseUrl);

  return (uWebSocketsRequest: HttpRequest, uWebSocketsResponse: HttpResponse): ServerRequest => {
    const method = uWebSocketsRequest.getMethod().toUpperCase();
    const headers = uWebSocketsRequestToHeaders(uWebSocketsRequest);
    const uri = uriFactory(resolveRequestUrl(uWebSocketsRequest));

    const abortState = getAbortState(uWebSocketsResponse);

    const abortController = new AbortController();

    addAbortListener(abortState, () => {
      abortController.abort();
    });

    // created and changed through the injected implementation only: the bridge works with any of them
    const createdServerRequest = requestHelpers.withProtocolVersion(serverRequestFactory(method, uri), protocolVersion);

    const serverRequest = [...headers].reduce(
      (request, [name, values]) => requestHelpers.withHeader(request, name, values),
      requestHelpers.withSignal(createdServerRequest, abortController.signal),
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

  const invalidHeaderName = Object.entries(response.headers).find(
    ([name, values]) => !tokenPattern.test(name) || values.some((value) => !fieldValuePattern.test(value)),
  )?.[0];

  // the value is not part of the reason: it may contain the injected content
  return invalidHeaderName !== undefined ? `Invalid response header "${invalidHeaderName}"` : undefined;
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

    const body = bodyToReadable(response.body);

    // a destroyed (e.g. errored) body does not emit any events anymore: the response would never end
    if (body.destroyed && !body.readableEnded) {
      throw new Error('Response body has already been destroyed');
    }

    uWebSocketsResponse.cork(() => {
      uWebSocketsResponse.writeStatus(`${response.status} ${response.reasonPhrase}`);

      // every value gets its own header line, which is required for set-cookie (RFC 6265 3)
      Object.entries(response.headers).forEach(([name, values]) => {
        values.forEach((value) => {
          uWebSocketsResponse.writeHeader(name, value);
        });
      });

      // an already consumed body does not emit 'end' anymore
      if (body.readableEnded) {
        uWebSocketsResponse.end();
      }
    });

    if (body.readableEnded) {
      return;
    }

    // a disconnecting client must stop the streaming
    addAbortListener(abortState, () => {
      body.destroy(new Error('Response has been aborted'));
    });

    // slowloris protection: a client reading the response arbitrarily slow (or a stalling
    // response body) would otherwise keep the response (and its socket) alive forever;
    // close() triggers the abort listener above which destroys the body
    const timeout =
      responseSendTimeoutMs !== undefined
        ? setTimeout(() => {
            uWebSocketsResponse.close();
          }, responseSendTimeoutMs)
        : undefined;

    timeout?.unref();

    body.on('close', () => clearTimeout(timeout));

    body.on('data', (data: Uint8Array) => {
      uWebSocketsResponse.cork(() => {
        // write returns false on backpressure: pause the body until the client is able to
        // receive more data
        if (!uWebSocketsResponse.write(data)) {
          body.pause();

          uWebSocketsResponse.onWritable(() => {
            body.resume();

            return true;
          });
        }
      });
    });

    // an already started response cannot signal a failure anymore: close the connection
    // instead of ending the response as if it was complete
    body.on('error', () => {
      if (!abortState.aborted) {
        uWebSocketsResponse.close();
      }
    });

    body.on('end', () => {
      uWebSocketsResponse.cork(() => {
        uWebSocketsResponse.end();
      });
    });
  };
};
