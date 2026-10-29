# chubbyts-http-uwebsockets

[![CI](https://github.com/chubbyts/chubbyts-http-uwebsockets/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/chubbyts/chubbyts-http-uwebsockets/actions/workflows/ci.yml)
[![Coverage Status](https://coveralls.io/repos/github/chubbyts/chubbyts-http-uwebsockets/badge.svg?branch=master)](https://coveralls.io/github/chubbyts/chubbyts-http-uwebsockets?branch=master)
[![Mutation testing badge](https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fchubbyts%2Fchubbyts-http-uwebsockets%2Fmaster)](https://dashboard.stryker-mutator.io/reports/github.com/chubbyts/chubbyts-http-uwebsockets/master)
[![npm-version](https://img.shields.io/npm/v/@chubbyts/chubbyts-http-uwebsockets.svg)](https://www.npmjs.com/package/@chubbyts/chubbyts-http-uwebsockets)

[![bugs](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-uwebsockets&metric=bugs)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-uwebsockets)
[![code_smells](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-uwebsockets&metric=code_smells)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-uwebsockets)
[![coverage](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-uwebsockets&metric=coverage)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-uwebsockets)
[![duplicated_lines_density](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-uwebsockets&metric=duplicated_lines_density)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-uwebsockets)
[![ncloc](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-uwebsockets&metric=ncloc)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-uwebsockets)
[![sqale_rating](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-uwebsockets&metric=sqale_rating)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-uwebsockets)
[![alert_status](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-uwebsockets&metric=alert_status)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-uwebsockets)
[![reliability_rating](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-uwebsockets&metric=reliability_rating)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-uwebsockets)
[![security_rating](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-uwebsockets&metric=security_rating)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-uwebsockets)
[![sqale_index](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-uwebsockets&metric=sqale_index)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-uwebsockets)
[![vulnerabilities](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-uwebsockets&metric=vulnerabilities)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-uwebsockets)

## Description

Use [@chubbyts/chubbyts-http-types][2] on [uWebSockets.js][4]: turns a uWebSockets.js `HttpRequest` into a
`ServerRequest` and emits a `Response` to a uWebSockets.js `HttpResponse`.

The bridge works with any implementation of the types: the server request gets created and changed through the
injected `UriFactory`, `ServerRequestFactory` and `RequestHelpers` (or `ServerRequestHelpers`), for example the ones of
[@chubbyts/chubbyts-http][3].

## Requirements

 * node: 22
 * [@chubbyts/chubbyts-http-types][2]: ^4.0.0
 * [uWebSockets.js][4]: v20.67.0

## Installation

Through [NPM](https://www.npmjs.com) as [@chubbyts/chubbyts-http-uwebsockets][1].

```sh
npm i @chubbyts/chubbyts-http-uwebsockets@^1.0.0
```

## Usage

```ts
import type { HttpRequest, HttpResponse } from 'uWebSockets.js';
import { App } from 'uWebSockets.js';
import type { Handler } from '@chubbyts/chubbyts-http-types/handler';
import type { ServerRequest } from '@chubbyts/chubbyts-http-types/message';
import { createServerRequestFactory, createUriFactory } from '@chubbyts/chubbyts-http/message-factory';
import { createServerRequestHelpers } from '@chubbyts/chubbyts-http/message-helper';
import {
  createResponseToUWebSocketsResponseEmitter,
  createUWebSocketsRequestToServerRequestFactory,
} from '@chubbyts/chubbyts-http-uwebsockets/uwebsockets';

const serverHost = process.env.SERVER_HOST as string;
const serverPort = parseInt(process.env.SERVER_PORT as string);

const uWebSocketsRequestToServerRequestFactory = createUWebSocketsRequestToServerRequestFactory(
  // any implementation of @chubbyts/chubbyts-http-types
  createUriFactory(),
  createServerRequestFactory(),
  createServerRequestHelpers(),
  // optional: the base url (scheme, host, port and path prefix), defaults to http://127.0.0.1
  'https://example.com',
  // optional: the request body must be fully received within 30s
  30_000,
  // optional: the request body must not exceed 1 MiB
  1024 * 1024,
);

// for example @chubbyts/chubbyts-framework app (which implements Handler)
declare const handler: Handler;

// argument (optional): the response must be fully sent within 60s
const responseToUWebSocketsResponseEmitter = createResponseToUWebSocketsResponseEmitter(60_000);

App()
  .any('/*', async (res: HttpResponse, req: HttpRequest) => {
    let serverRequest: ServerRequest | undefined = undefined;

    try {
      // has to be called synchronously: uWebSockets.js invalidates the request after the first await
      serverRequest = uWebSocketsRequestToServerRequestFactory(req, res);
      const response = await handler(serverRequest);
      responseToUWebSocketsResponseEmitter(response, res);
    } catch (error) {
      console.error(`Failed to handle request: ${error}`);

      // uWebSockets.js forbids touching an aborted response: if the client is already gone
      // there is nothing left to send the error response to
      if (serverRequest?.signal.aborted) {
        return;
      }

      res.cork(() => {
        res.writeStatus('500 Internal Server Error');
        res.writeHeader('content-type', 'text/plain');
        res.end('Internal Server Error');
      });
    }
  })
  .listen(serverHost, serverPort, (listenSocket: unknown) => {
    if (listenSocket) {
      console.log(`Listening to ${serverHost}:${serverPort}`);
    }
  });
```

### Server request

The server request gets created by `serverRequestFactory(method, uriFactory(url))`, then `withProtocolVersion`,
`withSignal`, `withHeader` (for each header) and, except for `GET` and `HEAD`, `withBody` get applied:

 * the url gets built from the base url (scheme, host, port and path prefix) and the origin-form request target.
   Request targets in another form get rejected.
 * `headers` keep every value of a repeated header (e.g. `cookie`), multiple `authorization` or
   `proxy-authorization` headers get rejected.
 * `protocolVersion` is always `1.1`, uWebSockets.js does not expose the http version.
 * `body` is a `PassThrough` fed by `onData` (an `AsyncIterable<Buffer>`), `GET` and `HEAD` keep the (empty) body of
   the factory. Receiving gets paused (backpressure) while the handler does not consume the body, so a fast client
   cannot fill the memory.
 * `signal` gets aborted when the client disconnects (`onAborted`).

### Response

The status, the reason phrase and the headers get validated before anything is written: a status outside of
`100`-`999`, a header name which is not a token or a reason phrase / header value containing control characters
(e.g. CR / LF, which would allow response splitting) lets the emitter throw, after cancelling the body. The same
applies to an already destroyed node stream body. As nothing has been sent yet, the caller is able to respond with an
error (see the usage example).

The body gets streamed with backpressure. A node stream body is used as is and a web stream body gets converted with
`Readable.fromWeb`, so both get stopped (destroyed / cancelled) when the client disconnects, even while a read is
pending. Any other `AsyncIterable` can only be stopped once its pending chunk arrives.

### Timeouts

Slow clients (slowloris) can otherwise tie up sockets indefinitely:

 * `createUWebSocketsRequestToServerRequestFactory(uriFactory, serverRequestFactory, requestHelpers, baseUrl, requestBodyTimeoutMs)`:
   if the request body has not been fully received within the given time, the connection gets closed and the error
   surfaces to the handler while iterating the body.
 * `createResponseToUWebSocketsResponseEmitter(responseSendTimeoutMs)`: if the response has not been fully
   sent within the given time (slow reading client or stalling response body), the connection gets closed.

Both timeouts are optional and disabled by default.

### Request body size

uWebSockets.js does not limit the size of a request body:

 * `createUWebSocketsRequestToServerRequestFactory(uriFactory, serverRequestFactory, requestHelpers, baseUrl, requestBodyTimeoutMs, requestBodyMaxBytes)`:
   a request body with a `content-length` above the given limit does not get read at all, a body exceeding it while
   being received (e.g. chunked) gets stopped. In both cases the connection gets closed and the error surfaces to
   the handler while iterating the body.

The limit is optional and disabled by default. They only cover the body phases handled by this adapter,
slow header senders are covered by the idle timeout uWebSockets.js applies to HTTP connections itself.

## Copyright

2026 Dominik Zogg

[1]: https://www.npmjs.com/package/@chubbyts/chubbyts-http-uwebsockets
[2]: https://www.npmjs.com/package/@chubbyts/chubbyts-http-types
[3]: https://www.npmjs.com/package/@chubbyts/chubbyts-http
[4]: https://github.com/uNetworking/uWebSockets.js
