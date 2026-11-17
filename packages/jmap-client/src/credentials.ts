/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type Credentials =
  | { kind: "basic"; username: string; password: string }
  | { kind: "bearer"; token: string };

function base64Utf8(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** The HTTP Authorization header value for these credentials. */
export function authorizationHeader(c: Credentials): string {
  return c.kind == "basic"
    ? `Basic ${base64Utf8(`${c.username}:${c.password}`)}`
    : `Bearer ${c.token}`;
}
