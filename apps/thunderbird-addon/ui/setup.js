/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const MESSAGES = {
  success: "Account added — your folders will appear in the folder pane.",
  https: "Use an https:// address.",
  JmapAuthError: "The server rejected the email or password.",
  JmapNetworkError: "Couldn't reach the server. Check the address and your connection.",
  JmapHttpError:
    "Couldn't find a JMAP server for this address. Enter the session URL under Advanced.",
};

const form = document.getElementById("setup-form");
const status = document.getElementById("status");
const authKind = document.getElementById("auth-kind");
const secretLabel = document.getElementById("secret-label");

function showStatus(state, text) {
  status.dataset.state = state;
  status.textContent = text;
}

function setBusy(busy) {
  for (const element of form.elements) {
    element.disabled = busy;
  }
}

function isAllowedUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol == "https:" || (url.protocol == "http:" && LOCAL_HOSTS.has(url.hostname));
  } catch {
    return false;
  }
}

/** Errors arrive as "<ErrorName>: <message>" from the Experiment API. */
function describeError(error) {
  const text = String(error?.message ?? error);
  const name = /^(\w+):/.exec(text)?.[1];
  if (name && MESSAGES[name]) {
    return MESSAGES[name];
  }
  return text.replace(/^\w+:\s*/, "");
}

authKind.addEventListener("change", () => {
  secretLabel.textContent = authKind.value == "bearer" ? "API token" : "Password";
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  const email = form.email.value.trim();
  const secret = form.secret.value;
  const sessionUrl = form.sessionUrl.value.trim();
  const username = form.username.value.trim();

  if (!email || !secret) {
    showStatus("error", "Enter your email address and password or token.");
    return;
  }
  if (sessionUrl && !isAllowedUrl(sessionUrl)) {
    showStatus("error", MESSAGES.https);
    return;
  }

  const details = { email, secret, authKind: authKind.value };
  if (sessionUrl) {
    details.sessionUrl = sessionUrl;
  }
  if (username) {
    details.username = username;
  }

  setBusy(true);
  showStatus("busy", "Checking your account…");
  try {
    await browser.jmap.createAccount(details);
    showStatus("success", MESSAGES.success);
  } catch (error) {
    showStatus("error", describeError(error));
    setBusy(false);
  }
});
