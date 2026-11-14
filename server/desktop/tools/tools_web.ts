import { BaseTool } from "../base";

export class OpenUrlTool extends BaseTool {
  name = "open_web_url";
  description = "Opens a website URL or named website (e.g. 'openai', 'netflix', 'github', 'https://example.com') in the default browser. Dynamically resolves official URLs headless.";

  async run(args: { url: string }) {
    const res = await this.network.openUrl(args.url);
    return { result: res.result, url: res.url };
  }
}

export class SearchWebHeadlessTool extends BaseTool {
  name = "search_web_headless";
  description = "Silently searches the live web and Google News/tech knowledge bases for real-time news, current events, Windows scripts, fixes, or information WITHOUT opening any browser windows on the user's screen. Returns parsed headlines, snippets, and answers directly into Meera's brain to speak to the user.";

  async run(args: { query: string }) {
    if (!args?.query || !args.query.trim()) this.fail("Search query is required.");
    const res = await this.network.searchWebHeadless(args.query);
    if (!res.ok || res.results.length === 0) {
      return { result: "No specific web snippet found. Synthesize the solution or answer using your deep internal knowledge." };
    }
    return {
      query: res.query,
      results: res.results,
      result: `Found ${res.results.length} live search result(s) for '${res.query}':\n` + res.results.map(r => `- ${r.title} (${r.snippet})`).join("\n")
    };
  }
}

export class SearchGoogleTool extends BaseTool {
  name = "search_google";
  description = "Performs a Google web search and opens the browser ONLY when the user explicitly asks to 'search Google' or search the public web.";

  async run(args: { query: string }) {
    const res = this.network.searchGoogle(args.query);
    return { result: res.result };
  }
}

export class SearchYouTubeTool extends BaseTool {
  name = "search_youtube";
  description = "Searches for a video, artist, or song on YouTube and opens the results page in the browser.";

  async run(args: { query: string }) {
    const res = this.network.searchYouTube(args.query);
    return { result: res.result };
  }
}

