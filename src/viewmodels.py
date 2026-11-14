"""View-model shaping: raw KinoPub response dicts -> render-ready payloads
for the web client. All media/poster URLs are routed through the allowlist
proxy (see services/proxy.py)."""

import config.globals as g
from config.settings import kp
from services import proxy


def progress_pct(
    duration,
    time
):
    duration = duration or 0
    time = time or 0
    if not duration or time <= 0:
        return 0
    if time >= duration:
        return 100

    return round(time / duration * 100)


def poster_url(
    item,
    settings,
    wide=False
):
    posters = item.get('posters') or {}
    url = posters.get('wide') if wide else (posters.get(settings.poster_size) or posters.get('big'))
    if not url:
        return None

    return proxy.make_proxy_url(url)


def card(
    item,
    settings,
    media=None
):
    """A list card: poster, ratings, stamps and (for in-progress items) the
    resume subtitle/percentage."""
    result = {
        'id': item.get('id'),
        'type': item.get('type'),
        'title': item.get('title'),
        'year': item.get('year'),
        'kinopoisk_rating': item.get('kinopoisk_rating'),
        'imdb_rating': item.get('imdb_rating'),
        'poster': poster_url(item, settings),
        'is_4k': item.get('quality') == 2160,
        'new_episodes': item.get('new'),
        'watched': item.get('watched') == 1,
    }
    backdrop = poster_url(item, settings, wide=True)
    if backdrop:
        result['backdrop'] = backdrop

    if media is not None and media.get('season'):
        season = media['season']
        number = media.get('number')
        title = media.get('title')
        result['subtitle'] = f'[S{season}/E{number}] {title}'
        result['media'] = {
            'season': season,
            'number': number,
            'title': title,
        }
        pct = progress_pct(media.get('duration'), media.get('time'))
        if pct:
            result['progress'] = pct

    return result


def _quality_rank(
    quality
):
    try:
        return g.QUALITY_ORDER.index(quality)
    except ValueError:
        return -1


def _file_url(
    file_entry
):
    urls = file_entry.get('url') or {}
    if not urls:
        return None

    if urls.get(kp.protocol):
        return urls[kp.protocol]

    for protocol in g.PROTOCOL_PRIORITY:
        if urls.get(protocol):
            return urls[protocol]

    return None


def stream_url(
    playable
):
    """Pick the best file of a video/episode dict: closest quality not above
    the configured target, preferring the configured protocol."""
    files = [
        f for f in playable.get('files') or []
        if f.get('url')
    ]
    if not files:
        return None

    target_rank = _quality_rank(kp.quality)

    def sort_key(
        file_entry
    ):
        rank = _quality_rank(file_entry.get('quality'))
        if rank < 0:
            # Unknown quality goes to the very end
            group, distance = 2, 0
        elif rank <= target_rank:
            # Closest quality not above the target
            group, distance = 0, target_rank - rank
        else:
            # Above the target, prefer the closest one
            group, distance = 1, rank - target_rank
        has_target_protocol = bool((file_entry.get('url') or {}).get(kp.protocol))

        return (
            group,
            distance,
            0 if has_target_protocol else 1
        )

    files = sorted(files, key=sort_key)

    return _file_url(files[0])


def _season_watched(
    season
):
    episodes = season.get('episodes') or []

    return bool(episodes) and all(
        e.get('watched') == 1
        for e in episodes
    )


def pick_playable(
    item,
    season=None,
    episode=None
):
    """Choose the video/episode dict to play: explicit season/episode when
    given, otherwise the first unfinished, otherwise the first."""
    seasons = item.get('seasons') or []
    if seasons:
        if season is not None:
            season_obj = next(
                (s for s in seasons if s.get('number') == season),
                None
            )
        else:
            season_obj = next(
                (s for s in seasons if not _season_watched(s)),
                None
            ) or seasons[0]
        if not season_obj or not season_obj.get('episodes'):
            return None

        episodes = season_obj['episodes']
        if episode is not None:
            chosen = next(
                (e for e in episodes if e.get('number') == episode),
                None
            )
        else:
            chosen = next(
                (e for e in episodes if e.get('watched') != 1),
                None
            ) or episodes[0]
        if chosen is not None:
            chosen['season'] = season_obj.get('number')

        return chosen

    videos = item.get('videos') or []
    if videos:
        if len(videos) == 1:
            return videos[0]

        if episode is not None:
            return next(
                (v for v in videos if v.get('number') == episode),
                None
            )

        return next(
            (v for v in videos if v.get('watched') != 1),
            None
        ) or videos[0]

    return None


def playable_info(
    item,
    playable
):
    """Playback payload for the client player."""
    watching = playable.get('watching') or {}
    watched = playable.get('watched') == 1

    subtitles = []
    for index, track in enumerate(playable.get('subtitles') or [], start=1):
        proxy.remember_url(track.get('url'))
        subtitles.append({
            'lang': track.get('lang'),
            # Same style as the KinoPub HLS manifest track names ("RUS #01")
            'label': f"{track.get('lang', '').upper()} #{index:02d}",
            'url': proxy.make_subtitle_url(track.get('url')),
        })

    result = {
        'content_id': item.get('id'),
        'title': playable.get('title') or item.get('title'),
        'season': playable.get('season'),
        'episode': playable.get('number'),
        'duration': playable.get('duration'),
        'position': watching.get('time') or 0,
        'watched': watched,
        'url': proxy.make_proxy_url(stream_url(playable)),
        'subtitles': subtitles,
    }
    if playable.get('thumbnail'):
        result['thumbnail'] = proxy.make_proxy_url(playable['thumbnail'])

    return result
