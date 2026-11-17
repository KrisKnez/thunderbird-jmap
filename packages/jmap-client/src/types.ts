/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type MethodCall = [name: string, args: Record<string, unknown>, callId: string];
export type MethodResponse = [name: string, result: Record<string, unknown>, callId: string];
