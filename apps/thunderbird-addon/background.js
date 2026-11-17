/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The toolbar button opens the account setup page.
browser.action.onClicked.addListener(() => {
  browser.tabs.create({ url: "ui/setup.html" });
});
