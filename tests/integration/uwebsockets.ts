import { text } from 'node:stream/consumers';
import type { HttpRequest, HttpResponse } from 'uWebSockets.js';
import { App } from 'uWebSockets.js';
import type { Handler } from '@chubbyts/chubbyts-http-types/handler';
import type { Response, ServerRequest } from '@chubbyts/chubbyts-http-types/message';
import {
  createResponseFactory,
  createServerRequestFactory,
  createStreamFactory,
  createUriFactory,
} from '@chubbyts/chubbyts-http/message-factory';
import { createResponseHelpers, createServerRequestHelpers } from '@chubbyts/chubbyts-http/message-helper';
import {
  createResponseToUWebSocketsResponseEmitter,
  createUWebSocketsRequestToServerRequestFactory,
} from '../../src/uwebsockets.js';

const serverHost = process.env.SERVER_HOST as string;
const serverPort = parseInt(process.env.SERVER_PORT as string);

// any implementation of @chubbyts/chubbyts-http-types, here @chubbyts/chubbyts-http
const uWebSocketsRequestToServerRequestFactory = createUWebSocketsRequestToServerRequestFactory(
  createUriFactory(),
  createServerRequestFactory(),
  createServerRequestHelpers(),
  'https://example.com',
  30_000,
  1024 * 1024,
);

const responseFactory = createResponseFactory();
const streamFactory = createStreamFactory();
const responseHelpers = createResponseHelpers();

// oxlint-disable-next-line functional/no-let
let acceptedBody: Promise<string> = Promise.resolve('');

const handler: Handler = async (serverRequest: ServerRequest): Promise<Response> => {
  if (serverRequest.uri.path === '/path/to/error/route') {
    throw new Error('Handler failure');
  }

  // responds before the body has been received, keeps on reading it
  if (serverRequest.uri.path === '/path/to/accepted/route') {
    acceptedBody = text(serverRequest.body).then((body) => `${body.length}`);

    return responseFactory(202);
  }

  if (serverRequest.uri.path === '/path/to/accepted/result/route') {
    return responseHelpers.withBody(responseFactory(200), streamFactory(await acceptedBody));
  }

  // responds without reading the body: the rest of the body gets discarded, the connection stays usable
  if (serverRequest.uri.path === '/path/to/unauthorized/route') {
    return responseHelpers.withBody(responseFactory(401), streamFactory('Unauthorized'));
  }

  // reflects client input into a header: must not allow response splitting
  if (serverRequest.uri.path === '/path/to/echo/route') {
    return responseHelpers.withHeader(
      responseFactory(204),
      'x-echo',
      new URLSearchParams(serverRequest.uri.query).get('echo') ?? '',
    );
  }

  // a handler setting framing headers (here even a wrong content-length): uWebSockets.js has to frame the response
  if (serverRequest.uri.path === '/path/to/framing/route') {
    return responseHelpers.withHeader(
      responseHelpers.withHeader(
        responseHelpers.withBody(responseFactory(200), streamFactory('framed')),
        'content-length',
        '999',
      ),
      'transfer-encoding',
      'chunked',
    );
  }

  // a body taking longer than the current event loop turn gets streamed
  if (serverRequest.uri.path === '/path/to/streamed/route') {
    return responseHelpers.withBody(
      responseFactory(200),
      (async function* () {
        yield Buffer.from('stream');
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield Buffer.from('ed');
      })(),
    );
  }

  // a response which must not have content, even if the handler provides a body
  if (serverRequest.uri.path === '/path/to/not-modified/route') {
    return responseHelpers.withHeader(
      responseHelpers.withBody(responseFactory(304), streamFactory('unsent')),
      'content-length',
      '6',
    );
  }

  const { host: _, ...otherHeaders } = serverRequest.headers;

  const response = responseHelpers.withBody(
    responseFactory(200),
    streamFactory(
      JSON.stringify({
        method: serverRequest.method,
        uri: serverRequest.uri,
        protocolVersion: serverRequest.protocolVersion,
        headers: otherHeaders,
        body: await text(serverRequest.body),
      }),
    ),
  );

  return responseHelpers.withAddedHeader(
    responseHelpers.withHeader(response, 'content-type', 'application/json'),
    'set-cookie',
    ['key1=value1; Path=/', 'key2=value2; Path=/'],
  );
};

const responseToUWebSocketsResponseEmitter = createResponseToUWebSocketsResponseEmitter(60_000);

App()
  .any('/*', async (res: HttpResponse, req: HttpRequest) => {
    try {
      const serverRequest = uWebSocketsRequestToServerRequestFactory(req, res);
      const response = await handler(serverRequest);
      responseToUWebSocketsResponseEmitter(response, res);
    } catch (error) {
      console.error(`Failed to handle request: ${error}`);

      // sent through the emitter as well: it does not touch an aborted response (uWebSockets.js forbids it) and
      // takes care of a request body which has not been (fully) read
      responseToUWebSocketsResponseEmitter(
        responseHelpers.withHeader(
          responseHelpers.withBody(responseFactory(500), streamFactory('Internal Server Error')),
          'content-type',
          'text/plain',
        ),
        res,
      );
    }
  })
  .listen(serverHost, serverPort, (listenSocket: unknown) => {
    if (listenSocket) {
      console.log(`Listening to ${serverHost}:${serverPort}`);
    }
  });
