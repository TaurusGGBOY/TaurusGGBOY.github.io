# SearXNG Quark and Baidu compatibility patches

These files accompany the article [把 SearXNG 变成可靠的本地搜索服务](https://taurusggboy.github.io/posts/self-hosted-searxng-for-agents/).

They capture a working local configuration from July 2026. The source patches were produced against SearXNG commit `277d8469c` (`2026.7.18+277d8469c`) and correspond to local commit `cbfdb64bd`.

## Files

- `settings-quark-baidu.yml`: sanitized `settings.yml` fragments. Replace every `<...>` placeholder before merging it into your own configuration.
- `patches/quark-captcha-proxy-rotation.patch`: retry a Quark CAPTCHA through the next engine proxy.
- `patches/baidu-mobile-fallback-cache.patch`: prefer Baidu mobile HTML, try isolated JSON fallbacks, then use a 15-minute successful-result cache.

## Apply the patches

Run these commands from a SearXNG source checkout:

```bash
git apply --check \
  /path/to/patches/quark-captcha-proxy-rotation.patch \
  /path/to/patches/baidu-mobile-fallback-cache.patch

git apply \
  /path/to/patches/quark-captcha-proxy-rotation.patch \
  /path/to/patches/baidu-mobile-fallback-cache.patch
```

Always run `git apply --check` first. If your checkout is newer than `277d8469c` and the check fails, compare the current `searx/engines/quark.py` and `searx/engines/baidu.py` with the patch and port the hunks manually. Do not force-apply a patch across changed parser code.

The Quark patch currently retries up to four times. Keep that number aligned with the number of genuinely isolated proxy exits in `settings-quark-baidu.yml`.

The `baidu_fallback_proxies` setting is introduced by the Baidu patch. Upstream SearXNG does not use this field without the corresponding source change.

## Validate each engine

Restart SearXNG after merging the configuration and applying the patches, then test the engines independently:

```bash
SEARXNG_URL="http://127.0.0.1:8888"

for engine in quark baidu; do
  curl -fsS --get \
    --data-urlencode 'q=SearXNG configuration' \
    --data 'format=json' \
    --data-urlencode "engines=$engine" \
    "$SEARXNG_URL/search" \
    | jq -c --arg engine "$engine" \
      '{engine: $engine, results: (.results | length), unresponsive_engines}'
done
```

Use more than one stable query. A healthy SearXNG process does not guarantee that an upstream engine is available; CAPTCHA, rate limits and HTML changes can still produce failures.

## License and maintenance

The patches modify files from SearXNG and retain its `SPDX-License-Identifier: AGPL-3.0-or-later` context. Treat the derived engine changes as AGPL-3.0-or-later.

These are compatibility examples, not a promise of permanent access. Respect upstream service policies, keep request volume low, and review the patches after every SearXNG upgrade.
