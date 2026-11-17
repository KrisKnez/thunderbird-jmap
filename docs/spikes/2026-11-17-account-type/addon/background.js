// Throwaway spike: proves the Experiment API is wired to the extension.
browser.jmapSpike.ping().then(r => console.log("jmap-spike background ping:", r));
