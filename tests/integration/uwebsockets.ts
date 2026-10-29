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

const handler: Handler = async (serverRequest: ServerRequest): Promise<Response> => {
  if (serverRequest.uri.path === '/path/to/error/route') {
    throw new Error('Handler failure');
  }

  // reflects client input into a header: must not allow response splitting
  if (serverRequest.uri.path === '/path/to/echo/route') {
    return responseHelpers.withHeader(
      responseFactory(204),
      'x-echo',
      new URLSearchParams(serverRequest.uri.query).get('echo') ?? '',
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
    // oxlint-disable-next-line functional/no-let
    let serverRequest: ServerRequest | undefined = undefined;

    try {
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
