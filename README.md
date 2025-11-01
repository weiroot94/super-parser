# Baymax-parser

Baymax-parser is a Node.js toolchain for turning Widevine-protected DASH live feeds into clean HLS renditions you can restream or archive. It automates manifest discovery, adaptive bitrate selection, key acquisition, segment downloading, decryption, and playlist maintenance in a single loop.

## Highlights
- Automates manifest resolution through service-aware API templates.
- Parses DASH MPDs, flattens multi-period timelines, and tracks rolling live edges.
- Downloads and merges audio/video segments while enforcing a configurable live buffer.
- Decrypts segments via `packager` binaries and emits HLS-compatible assets.
- Supports multi-language audio filtering and bandwidth-tier targeting.
- Handles SOCKS5 proxy routing and configurable output locations.

## Prerequisites
- Node.js 16+ (ES modules enabled).
- Bash-compatible environment for the helper scripts in `bin/`.
- Executable Widevine tooling shipped in `bin/` (`packager-linux-x64`, `mp4decrypt`, etc.).
- Optional: an HTTP server (for example `nginx`) if you plan to serve generated HLS playlists directly from the filesystem.

## Install
1. Install dependencies:

   ```bash
   npm install
   ```

2. Ensure binaries under `bin/` are executable (`chmod +x bin/*.sh bin/packager-linux-x64` on Unix-like systems).

## Configure
Baymax-parser reads defaults from `conf.json` and merges them with CLI flags.

`conf.json` keys:
- `id`: Channel/content identifier consumed by upstream APIs.
- `service`: Provider slug interpolated into API templates.
- `net_itf`: Network interface used when binding sockets.
- `proxy_addr`: SOCKS5 endpoint (leave empty for direct requests).
- `lang`: Comma-separated language priorities (highest priority last for tie-breaking).
- `bandwidth`: One of `low`, `mid`, `high`; selects a tiered range across available variants.
- `apiformat_mpd`: Template URL returning the manifest URL (`{service}`, `{id}` placeholders).
- `apiformat_key`: Template URL returning the Widevine key (`{service}`, `{id}`, `{pssh-box}`).
- `max_segment_num`: Rolling window length for retained segments per track.

### Proxy settings
Adjust `proxy_conf.js` when routing through SOCKS5:

```js
export const proxyConf = {
  use_proxy: true,
  addr: "127.0.0.1",
  port: 10800
};
```

## Run
Invoke the orchestrator with Node:

```bash
node superparser.js [options]
```

Common flags:
- `--id`, `-i`: Channel identifier.
- `--serv`, `-s`: Service slug.
- `--lang`, `-l`: Repeatable language filter (e.g. `-l en -l es`).
- `--bandwidth`, `-b`: `low`, `mid`, `high`.
- `--apiformat_mpd`, `-p`: Override manifest API template.
- `--apiformat_key`, `-k`: Override key API template.
- `--max_segment_num`, `-m`: Override rolling buffer length.
- `--outpath`, `-o`: Absolute or repo-relative folder ending with `/` for HLS output.
- `--help`, `-h`: Print usage summary.

CLI values always take precedence over `conf.json` defaults.

## Output Layout
By default Baymax-parser writes assets to `/var/www/html/{id}/` (override with `--outpath`). Each run builds:
- `master.m3u8`: Master playlist referencing audio/video variants.
- `audio/audioVariant.m3u8`, `video/videoVariant.m3u8`: Live/event playlists with rolling windows.
- `audio/*.mp4`, `video/*.mp4`: Decrypted and muxed CMAF segments.

Working directories inside the repo root:
- `download/`: Raw encrypted segments.
- `output/`: Intermediate merged-but-still-encrypted files.

Both caches are cleaned at the end of each processing cycle.

## How It Works
1. Resolve the DASH MPD URL via `apiformat_mpd`.
2. Parse and combine MPD periods while maintaining manifest timers.
3. Filter variants against language and bandwidth preferences.
4. Refresh Widevine keys when manifests expire.
5. Download, merge, decrypt, and publish segments, trimming older media when `max_segment_num` is reached.
6. Update playlists in place, including media sequence numbers, for compatibility with standard HLS players.

The heart of the loop lives in `superparser.js`, backed by modules in `src/dash/`, `src/stream/`, `src/net/`, and `src/util/`.

## Integrations
- **Decrypt scripts**: `bin/decrypt.sh` wraps `packager-linux-x64` with the proper Widevine arguments. Customize the script if you prefer alternate decrypters.
- **Segment merging**: `bin/merge.sh` concatenates init segments with media chunks—adjust when targeting non-CMAF workflows.
- **FFmpeg restreaming**: See `ffmpeg.txt` for an example command to restream generated playlists.

## Development Notes
- Logging is handled by `src/util/sp_logger.js` (Winston-based). Tail the output to monitor feed health.
- Network requests go through `src/net/network_engine.js`, including SOCKS5 helpers for proxied traffic.
- Many parser utilities originate from the Shaka Player project; expect familiar naming conventions if you need to extend parsing logic.

## Troubleshooting
- Use `--help` to confirm flag spelling; invalid `bandwidth` values abort early.
- Ensure the `download/`, `output/`, and target output directories are writable; the app creates them if missing but will exit on permission errors.
- Widevine failures typically surface as `SEGMENT_MANIPULATION_FAILED`—recheck key API responses and proxy reachability.

## License
Baymax-parser is distributed under the ISC license (see `package.json`).