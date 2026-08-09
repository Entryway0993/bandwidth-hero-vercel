const config = {
  headers,
  dnsLookup: safeLookup,
  timeout: {
    request: 15000,
    response: 20000
  },
  responseType: 'buffer',
  decompress: true,
  throwHttpErrors: false,
  followRedirect: true,
  retry: {
    limit: 0
  },
  hooks: {
    // 🛑 PHASE 2 FIX: DEFUSE THE RAM BOMB
    beforeResponse: [
      (response) => {
        const contentLength = parseInt(response.headers['content-length'], 10);
        // 20MB limit. If the file is bigger than this, we abort before it hits RAM.
        if (contentLength > 20 * 1024 * 1024) {
          const error = new Error('BODY_TOO_LARGE');
          error.code = 'BODY_TOO_LARGE';
          throw error;
        }
      }
    ],
    beforeRedirect: [
      (options) => {
        const redirectUrl = options?.url?.href || String(options?.url || '');
        
        if (!parseSafeUrl(redirectUrl)) {
          const error = new Error('SSRF_BLOCKED_REDIRECT');
          error.code = 'SSRF_BLOCKED_REDIRECT';
          throw error;
        }
      }
    ]
  }
};