/**
 * Server-Sent Events to every open console.
 *
 * Served on the plugin router rather than a plugin WebSocket, so the server's
 * own authentication covers it: the server leaves a plugin socket's
 * authentication to the plugin and offers nothing to do it with. The push is
 * one-way; every request still goes over REST.
 */

import type { Request, Response } from 'express'
import type { ServerEvent } from '../types.js'

/** Proxies close a connection that stays idle; a comment line resets their timer. */
const KEEPALIVE_MS = 25_000

const HEADERS = {
  'Content-Type': 'text/event-stream',
  // The server applies compression() to every response, which would hold the
  // stream in its buffer; the compression package skips a no-transform response.
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no'
}

type StreamResponse = Response & { flush?: () => void }

export class EventStream {
  private readonly clients = new Set<StreamResponse>()
  private keepalive: ReturnType<typeof setInterval> | null = null

  /** Hold `res` open as an event stream, and send it `initial` first. */
  attach(req: Request, res: Response, initial: ServerEvent[]): void {
    res.writeHead(200, HEADERS)
    const client = res as StreamResponse
    this.clients.add(client)
    req.on('close', () => {
      this.detach(client)
    })
    for (const event of initial) {
      this.write(client, format(event))
    }
    this.keepalive ??= setInterval(() => {
      this.broadcast(': keepalive\n\n')
    }, KEEPALIVE_MS)
  }

  get hasClients(): boolean {
    return this.clients.size > 0
  }

  /** Send `event` to every client. */
  send(event: ServerEvent): void {
    this.broadcast(format(event))
  }

  /** End every stream, so each client reconnects to whatever runs next. */
  close(): void {
    for (const client of this.clients) {
      client.end()
    }
    this.clients.clear()
    this.stopKeepalive()
  }

  private broadcast(chunk: string): void {
    for (const client of this.clients) {
      this.write(client, chunk)
    }
  }

  private write(client: StreamResponse, chunk: string): void {
    client.write(chunk)
    client.flush?.()
  }

  private detach(client: StreamResponse): void {
    this.clients.delete(client)
    if (this.clients.size === 0) {
      this.stopKeepalive()
    }
  }

  private stopKeepalive(): void {
    if (this.keepalive !== null) {
      clearInterval(this.keepalive)
      this.keepalive = null
    }
  }
}

const format = (event: ServerEvent): string =>
  `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`
