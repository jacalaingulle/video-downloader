// Recognises the video links Spectra accepts and rebuilds each one as a clean canonical URL, so nothing
// from the visitor's input other than the video's own id ever reaches yt-dlp.

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

const FACEBOOK_HOSTS = new Set([
  'facebook.com',
  'www.facebook.com',
  'm.facebook.com',
  'web.facebook.com',
  'mbasic.facebook.com',
  'touch.facebook.com',
  'fb.com',
  'www.fb.com',
  'fb.watch',
  'www.fb.watch',
]);

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const NUMERIC_ID = /^\d{5,25}$/;
const SHARE_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{3,39}$/;

function toUrl(input) {
  if (typeof input !== 'string') return null;
  try {
    const trimmed = input.trim();
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function youtube(url, host) {
  const parts = url.pathname.split('/').filter(Boolean);
  let id = null;
  if (host.endsWith('youtu.be')) id = parts[0];
  else if (url.searchParams.has('v')) id = url.searchParams.get('v');
  else if (['shorts', 'embed', 'live', 'v', 'e'].includes(parts[0])) id = parts[1];
  if (!id || !YOUTUBE_ID.test(id)) return null;
  return { platform: 'youtube', key: `yt:${id}`, url: `https://www.youtube.com/watch?v=${id}` };
}

function facebook(url, host) {
  const parts = url.pathname.split('/').filter(Boolean);
  const watch = (id) => ({ platform: 'facebook', key: `fb:${id}`, url: `https://www.facebook.com/watch/?v=${id}` });

  // fb.watch/AbC123
  if (host.endsWith('fb.watch')) {
    return SHARE_CODE.test(parts[0] ?? '')
      ? { platform: 'facebook', key: `fbw:${parts[0]}`, url: `https://fb.watch/${parts[0]}/` }
      : null;
  }
  // /watch?v=123, /watch/?v=123, /video.php?v=123
  if ((parts[0] === 'watch' || parts[0] === 'video.php') && NUMERIC_ID.test(url.searchParams.get('v') ?? '')) {
    return watch(url.searchParams.get('v'));
  }
  // /reel/123
  if (parts[0] === 'reel' && NUMERIC_ID.test(parts[1] ?? '')) {
    return { platform: 'facebook', key: `fbr:${parts[1]}`, url: `https://www.facebook.com/reel/${parts[1]}` };
  }
  // /share/v/AbC123 (video) and /share/r/AbC123 (reel), the links the Share button copies
  if (parts[0] === 'share' && ['v', 'r'].includes(parts[1]) && SHARE_CODE.test(parts[2] ?? '')) {
    return {
      platform: 'facebook',
      key: `fbs:${parts[1]}:${parts[2]}`,
      url: `https://www.facebook.com/share/${parts[1]}/${parts[2]}/`,
    };
  }
  // /PageName/videos/123 and /PageName/videos/some-title/123
  const videos = parts.indexOf('videos');
  if (videos > 0) {
    const id = parts.slice(videos + 1).find((p) => NUMERIC_ID.test(p));
    if (id) return watch(id);
  }
  return null;
}

/**
 * Returns `{ platform, key, url }` for a supported video link, or null. `key` identifies the video for
 * caching; `url` is the canonical address passed to yt-dlp.
 */
export function parseLink(input) {
  const url = toUrl(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(host)) return youtube(url, host);
  if (FACEBOOK_HOSTS.has(host)) return facebook(url, host);
  return null;
}
