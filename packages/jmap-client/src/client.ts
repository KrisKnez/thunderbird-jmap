/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { authorizationHeader, type Credentials } from "./credentials.js";
import { JmapError, JmapMethodError } from "./errors.js";
import { checkedFetch } from "./http.js";
import { parseSession, type Session } from "./session.js";
import type { FetchLike, MethodCall, MethodResponse } from "./types.js";

export const DEFAULT_USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];
const MAIL = "urn:ietf:params:jmap:mail";

export class JmapClient {
  readonly sessionUrl: string;
  private readonly credentials: Credentials;
  private readonly fetchImpl: FetchLike;
  private session: Session | null = null;

  constructor(o: { sessionUrl: string; credentials: Credentials; fetch: FetchLike }) {
    this.sessionUrl = o.sessionUrl;
    this.credentials = o.credentials;
    this.fetchImpl = o.fetch;
  }

  /** Headers every authenticated request carries. */
  authHeaders(): Record<string, string> {
    return { Authorization: authorizationHeader(this.credentials) };
  }

  /** fetch with auth headers and JMAP error mapping. */
  async send(url: string, init: RequestInit = {}): Promise<Response> {
    return checkedFetch(this.fetchImpl, url, {
      ...init,
      headers: { ...this.authHeaders(), ...(init.headers as Record<string, string>) },
    });
  }

  async getSession(refresh = false): Promise<Session> {
    if (!this.session || refresh) {
      const res = await this.send(this.sessionUrl, { headers: { Accept: "application/json" } });
      this.session = parseSession(await res.json(), res.url || this.sessionUrl);
    }
    return this.session;
  }

  async primaryMailAccountId(): Promise<string> {
    const id = (await this.getSession()).primaryAccounts[MAIL];
    if (!id) {
      throw new JmapError("The server has no primary mail account");
    }
    return id;
  }

  async request(calls: MethodCall[], using: string[] = DEFAULT_USING): Promise<MethodResponse[]> {
    const { apiUrl } = await this.getSession();
    const res = await this.send(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ using, methodCalls: calls }),
    });
    const body = await res.json();
    return body.methodResponses as MethodResponse[];
  }

  /** Download a blob (by default as a raw message). */
  async downloadBlob(accountId: string, blobId: string, type?: string): Promise<Uint8Array> {
    const { downloadUrl } = await this.getSession();
    const url = expandTemplate(downloadUrl, {
      accountId,
      blobId,
      name: "message.eml",
      type: type ?? "message/rfc822",
    });
    const res = await this.send(url);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Upload a blob; returns the server's blob id. */
  async uploadBlob(
    accountId: string,
    data: Uint8Array | string,
    type: string
  ): Promise<{ blobId: string; size: number; type: string }> {
    const { uploadUrl } = await this.getSession();
    const res = await this.send(expandTemplate(uploadUrl, { accountId }), {
      method: "POST",
      headers: { "Content-Type": type },
      body: data as BodyInit,
    });
    const body = await res.json();
    return { blobId: body.blobId, size: body.size, type: body.type };
  }

  /** Run one method call; throws JmapMethodError for an error response. */
  async call<T>(name: string, args: Record<string, unknown>, using?: string[]): Promise<T> {
    const responses = await this.request([[name, args, "0"]], using);
    const response = responses.find(r => r[2] == "0");
    if (!response) {
      throw new JmapError(`No response to ${name}`);
    }
    const [responseName, result] = response;
    if (responseName == "error") {
      throw new JmapMethodError(
        String(result.type),
        typeof result.description == "string" ? result.description : undefined
      );
    }
    return result as T;
  }
}

/** Fill {name} placeholders of a URL template with URI-encoded values. */
function expandTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? encodeURIComponent(values[key]) : match
  );
}
