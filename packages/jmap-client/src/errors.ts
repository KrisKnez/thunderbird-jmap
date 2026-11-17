/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Base class for every error this package throws. */
export class JmapError extends Error {
  override name = "JmapError";
}

/** The server rejected the credentials (HTTP 401/403). */
export class JmapAuthError extends JmapError {
  override name = "JmapAuthError";
  /** @param url - the final URL that answered (after redirects), if known. */
  constructor(
    readonly status: number,
    readonly url?: string
  ) {
    super(`Authentication failed (HTTP ${status})`);
  }
}

/** A non-success HTTP status without a JMAP problem-details body. */
export class JmapHttpError extends JmapError {
  override name = "JmapHttpError";
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** A request-level error (RFC 8620 §3.6.1 problem details). */
export class JmapRequestError extends JmapError {
  override name = "JmapRequestError";
  constructor(
    readonly type: string,
    readonly status: number,
    readonly detail?: string
  ) {
    super(detail ? `${type}: ${detail}` : type);
  }
}

/** A method-level error response (`["error", {type}, callId]`). */
export class JmapMethodError extends JmapError {
  override name = "JmapMethodError";
  constructor(
    readonly type: string,
    readonly description?: string
  ) {
    super(description ? `${type}: ${description}` : type);
  }
}

/** fetch itself failed (DNS, connection refused, TLS, …). */
export class JmapNetworkError extends JmapError {
  override name = "JmapNetworkError";
  constructor(readonly cause: unknown) {
    super(`Network error: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
