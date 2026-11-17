/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { FetchLike } from "./types.js";
import {
  JmapAuthError,
  JmapHttpError,
  JmapNetworkError,
  JmapRequestError,
} from "./errors.js";

/** fetch with JMAP error mapping. Resolves only for 2xx responses. */
export async function checkedFetch(
  fetch: FetchLike,
  url: string,
  init: RequestInit
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new JmapNetworkError(e);
  }
  if (res.status == 401 || res.status == 403) {
    throw new JmapAuthError(res.status, res.url || url);
  }
  if (!res.ok) {
    let problem: { type?: unknown; detail?: unknown } | null = null;
    try {
      problem = await res.json();
    } catch {
      // Not JSON.
    }
    if (problem && typeof problem.type == "string") {
      throw new JmapRequestError(
        problem.type,
        res.status,
        typeof problem.detail == "string" ? problem.detail : undefined
      );
    }
    throw new JmapHttpError(res.status);
  }
  return res;
}
