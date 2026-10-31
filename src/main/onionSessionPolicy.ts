import type { Session } from "electron";

// Chromium sends loopback and link-local hosts DIRECT even under a SOCKS proxy. A remote
// redirect must never reach them, so the onion session proxies loopback and refuses redirects.
export const ONION_SESSION_BYPASS_RULES = "<-loopback>";

export const configureOnionSessionProxy = (target: Pick<Session, "setProxy">, proxyUrl: string | null) =>
  target.setProxy(proxyUrl ? { proxyRules: proxyUrl, proxyBypassRules: ONION_SESSION_BYPASS_RULES } : { proxyRules: "" });

// Hunspell dictionaries otherwise come from Google's CDN (redirector.gvt1.com) outside Tor.
export const SPELLCHECKER_DICTIONARY_BLACKHOLE = "http://127.0.0.1:9/";

export const blockSpellcheckerDownloads = (target: Pick<Session, "setSpellCheckerDictionaryDownloadURL" | "setSpellCheckerEnabled">) => {
  target.setSpellCheckerDictionaryDownloadURL(SPELLCHECKER_DICTIONARY_BLACKHOLE);
  target.setSpellCheckerEnabled(false);
};

export const onionSessionFetch = (target: Pick<Session, "fetch">, url: string, init?: RequestInit) =>
  target.fetch(url, {
    method: init?.method,
    // SAFETY: callers pass headers already validated as string pairs by validateOnionFetchRequest.
    headers: init?.headers as Record<string, string> | undefined,
    body: init?.body,
    signal: init?.signal ?? undefined,
    redirect: "error",
  });
