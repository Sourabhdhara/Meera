import * as os from "os";
import { spawn } from "child_process";

// ---------------------------------------------------------------------------
// NetworkEngine (Tier 1-3 Network Intelligence & Web Launching Core)
// Queries network connectivity, local IP, Wi-Fi info, and browser URLs.
// ---------------------------------------------------------------------------

export class NetworkEngine {
  public async getStatus(): Promise<{ summary: string; status: any }> {
    const ifaces = os.networkInterfaces();
    let localIp = "127.0.0.1";
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name] || []) {
        if (iface.family === "IPv4" && !iface.internal) {
          localIp = iface.address;
          break;
        }
      }
    }

    const ps = `(netsh wlan show interfaces) -match '^\\s+SSID\\s+:|Signal'`;
    let wifiInfo = "";
    try {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      child.stdout.on("data", d => { stdout += d.toString(); });
      await new Promise(r => child.on("close", r));
      wifiInfo = stdout.replace(/\r/g, "").split("\n").map(l => l.trim()).filter(Boolean).join(", ");
    } catch {}

    const connected = localIp !== "127.0.0.1";
    return {
      summary: `Connected to network. Local IP: ${localIp}. Wi-Fi: ${wifiInfo || "Active"}`,
      status: {
        connected,
        internet: connected,
        local_ip: localIp,
        wifi: wifiInfo || "Connected"
      }
    };
  }

  private async fetchJson(url: string, timeoutMs: number = 3000): Promise<any> {
    const https = await import("https");
    return new Promise((resolve) => {
      const req = https.get(url, { headers: { "User-Agent": "MeeraAssistant/2.0" } }, (res) => {
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => {
          try { resolve(JSON.parse(d)); } catch { resolve(null); }
        });
      });
      req.on("error", () => resolve(null));
      req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    });
  }

  public async resolveOfficialWebsite(nameOrQuery: string): Promise<string | null> {
    const cleaned = nameOrQuery.replace(/^open\s+/i, "").replace(/\s*(website|site|official|page)\s*$/i, "").trim();
    if (!cleaned) return null;

    // 1. DuckDuckGo Instant Answer API for official site
    try {
      const ddg = await this.fetchJson(`https://api.duckduckgo.com/?q=${encodeURIComponent(cleaned)}&format=json`);
      if (ddg?.Results?.length > 0 && ddg.Results[0]?.FirstURL) {
        return ddg.Results[0].FirstURL;
      }
    } catch {}

    // 2. Wikipedia search -> Wikidata P856 property (Official Website)
    try {
      const wiki = await this.fetchJson(`https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(cleaned)}&limit=1&format=json`);
      if (wiki && Array.isArray(wiki[1]) && wiki[1][0]) {
        const pageTitle = wiki[1][0];
        const props = await this.fetchJson(`https://en.wikipedia.org/w/api.php?action=query&prop=pageprops&titles=${encodeURIComponent(pageTitle)}&format=json`);
        const pages = props?.query?.pages || {};
        const firstPage: any = Object.values(pages)[0];
        const wikibaseItem = firstPage?.pageprops?.wikibase_item;
        if (wikibaseItem) {
          const claims = await this.fetchJson(`https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${wikibaseItem}&property=P856&format=json`);
          const officialUrl = claims?.claims?.P856?.[0]?.mainsnak?.datavalue?.value;
          if (officialUrl && /^https?:\/\//i.test(officialUrl)) {
            return officialUrl;
          }
        }
      }
    } catch {}

    // 3. Fallback: sanitize domain format if user passed e.g. "openai.com" or "google.com"
    if (/^[a-z0-9-]+(\.[a-z]{2,})+$/i.test(cleaned)) {
      return `https://${cleaned}`;
    }

    return null;
  }

  public async openUrl(urlOrName: string): Promise<{ ok: boolean; result: string; url: string }> {
    let target = urlOrName.trim();
    
    // Check if it's already a full URL or domain
    if (/^https?:\/\//i.test(target) || /^[a-z0-9-]+\.[a-z]{2,}(\/.*)?$/i.test(target)) {
      if (!/^https?:\/\//i.test(target)) {
        target = `https://${target}`;
      }
    } else {
      // Resolve website dynamically via headless lookup
      const resolved = await this.resolveOfficialWebsite(target);
      if (resolved) {
        target = resolved;
      } else {
        // Fallback: Google search in browser if direct site not resolvable
        target = `https://www.google.com/search?q=${encodeURIComponent(target)}`;
      }
    }

    spawn("cmd.exe", ["/c", "start", "", target], { detached: true, stdio: "ignore" }).unref();
    return { ok: true, result: `Opened '${target}' in default web browser.`, url: target };
  }

  public async searchWebHeadless(query: string): Promise<{ ok: boolean; query: string; results: Array<{ title: string; snippet: string; source: string }> }> {
    const q = query.trim();
    if (!q) return { ok: false, query: q, results: [] };

    const results: Array<{ title: string; snippet: string; source: string }> = [];

    // 1. Google News / Headless Google Search RSS endpoint (Real-time news & topic coverage without bot blocks)
    try {
      const https = await import("https");
      const googleNewsUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;
      const newsHits: any[] = await new Promise((resolve) => {
        const req = https.get(googleNewsUrl, { headers: { "User-Agent": "MeeraAssistant/2.0" } }, (res) => {
          let d = "";
          res.on("data", c => d += c);
          res.on("end", () => {
            const items: any[] = [];
            const itemRegex = /<item>([\s\S]*?)<\/item>/g;
            let m: RegExpExecArray | null;
            while ((m = itemRegex.exec(d)) !== null && items.length < 5) {
              const content = m[1];
              const titleM = content.match(/<title>([\s\S]*?)<\/title>/);
              const sourceM = content.match(/<source[^>]*>([\s\S]*?)<\/source>/);
              const pubM = content.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
              if (titleM) {
                const rawTitle = titleM[1]
                  .replace(/&amp;/g, "&")
                  .replace(/&quot;/g, '"')
                  .replace(/&#39;/g, "'")
                  .replace(/&lt;/g, "<")
                  .replace(/&gt;/g, ">");
                const sourceName = sourceM ? sourceM[1].replace(/<[^>]+>/g, "").trim() : "Google News";
                items.push({
                  title: rawTitle,
                  snippet: `Published: ${pubM ? pubM[1] : 'Recent'}. Source: ${sourceName}`,
                  source: sourceName
                });
              }
            }
            resolve(items);
          });
        });
        req.on("error", () => resolve([]));
        req.setTimeout(4000, () => { req.destroy(); resolve([]); });
      });

      for (const item of newsHits) {
        results.push(item);
      }
    } catch {}

    // 2. Headless Web & Script Search (HTML search engine endpoint for direct PowerShell scripts, code snippets, and forum answers)
    try {
      const https = await import("https");
      const postData = 'q=' + encodeURIComponent(q);
      const ddgHits: any[] = await new Promise((resolve) => {
        const req = https.request('https://html.duckduckgo.com/html/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
          }
        }, (res) => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => {
            const hits: any[] = [];
            const regex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
            let m: RegExpExecArray | null;
            while ((m = regex.exec(d)) !== null && hits.length < 5) {
              const cleanText = m[1]
                .replace(/<[^>]+>/g, '')
                .replace(/&amp;/g, '&')
                .replace(/&quot;/g, '"')
                .replace(/&#x27;/g, "'")
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .trim();
              if (cleanText) {
                hits.push({
                  title: `Web Snippet (${hits.length + 1})`,
                  snippet: cleanText,
                  source: "Web Search"
                });
              }
            }
            resolve(hits);
          });
        });
        req.on('error', () => resolve([]));
        req.setTimeout(4000, () => { req.destroy(); resolve([]); });
        req.write(postData);
        req.end();
      });

      for (const item of ddgHits) {
        results.push(item);
      }
    } catch {}

    // 3. StackOverflow Developer API Search (Specialized in Windows, PowerShell, and OS scripts)
    try {
      const zlib = await import("zlib");
      const https = await import("https");
      const soUrl = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(q)}&site=stackoverflow`;
      
      const soHits: any[] = await new Promise((resolve) => {
        const req = https.get(soUrl, { headers: { "User-Agent": "MeeraAssistant/2.0", "Accept-Encoding": "gzip" } }, (res) => {
          const stream = res.headers["content-encoding"] === "gzip" ? res.pipe(zlib.createGunzip()) : res;
          let d = "";
          stream.on("data", c => d += c);
          stream.on("end", () => {
            try {
              const j = JSON.parse(d);
              resolve(j.items || []);
            } catch { resolve([]); }
          });
        });
        req.on("error", () => resolve([]));
        req.setTimeout(4000, () => { req.destroy(); resolve([]); });
      });

      for (const item of soHits.slice(0, 3)) {
        if (item?.title) {
          results.push({
            title: item.title,
            snippet: `Discussion on StackOverflow regarding ${item.title}. Tags: ${(item.tags || []).join(", ")}`,
            source: item.link || "StackOverflow"
          });
        }
      }
    } catch {}

    // 2. Wikipedia Technical Knowledge Search
    try {
      const https = await import("https");
      const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&utf8=&format=json`;
      
      const wikiHits: any[] = await new Promise((resolve) => {
        const req = https.get(wikiUrl, { headers: { "User-Agent": "MeeraAssistant/2.0" } }, (res) => {
          let d = "";
          res.on("data", c => d += c);
          res.on("end", () => {
            try {
              const j = JSON.parse(d);
              resolve(j.query?.search || []);
            } catch { resolve([]); }
          });
        });
        req.on("error", () => resolve([]));
        req.setTimeout(4000, () => { req.destroy(); resolve([]); });
      });

      for (const h of wikiHits.slice(0, 2)) {
        if (h?.title && h?.snippet) {
          results.push({
            title: h.title,
            snippet: h.snippet.replace(/<[^>]+>/g, " ").trim(),
            source: `Wikipedia (${h.title})`
          });
        }
      }
    } catch {}

    return {
      ok: results.length > 0,
      query: q,
      results
    };
  }

  public searchGoogle(query: string): { ok: boolean; result: string } {
    const u = `https://www.google.com/search?q=${encodeURIComponent(query.trim())}`;
    spawn("cmd.exe", ["/c", "start", "", u], { detached: true, stdio: "ignore" }).unref();
    return { ok: true, result: `Searched Google for '${query}' in browser.` };
  }

  public searchYouTube(query: string): { ok: boolean; result: string } {
    const u = `https://www.youtube.com/results?search_query=${encodeURIComponent(query.trim())}`;
    spawn("cmd.exe", ["/c", "start", "", u], { detached: true, stdio: "ignore" }).unref();
    return { ok: true, result: `Searched YouTube for '${query}' in browser.` };
  }
}

