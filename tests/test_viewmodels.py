"""viewmodels: raw KinoPub dicts -> client payloads. Pure functions — the
tests pin the documented upstream quirks (stream priority, quality fallback,
season picking, pagination-friendly card fields)."""

import pytest
from conftest import kp_item

import viewmodels as vm
from config.settings import KPSettings
from services import proxy


@pytest.fixture()
def prefs(monkeypatch):
    """Deterministic stream preferences regardless of .env values; a fresh
    settings object instead of mutating the shared singleton."""
    monkeypatch.setattr(
        vm,
        'kp',
        KPSettings(
            client_id='x',
            client_secret='y',
            protocol='hls4',
            quality='1080p',
        ),
    )


class TestProgressPct:
    def test_no_duration_means_zero(self):
        assert vm.progress_pct(0, 50) == 0
        assert vm.progress_pct(None, 50) == 0

    def test_nonpositive_time_means_zero(self):
        assert vm.progress_pct(100, 0) == 0
        assert vm.progress_pct(100, -5) == 0

    def test_completed_is_100(self):
        assert vm.progress_pct(100, 100) == 100
        assert vm.progress_pct(100, 150) == 100

    def test_rounded_percentage(self):
        assert vm.progress_pct(120, 50) == 42


class TestPosterUrl:
    def test_prefers_configured_size(self, device_settings):
        item = {'posters': {'small': 'https://cdn.test/s.jpg', 'big': 'https://cdn.test/b.jpg'}}
        device_settings.poster_size = 'small'
        assert vm.poster_url(item, device_settings).endswith(
            'url=https%3A%2F%2Fcdn.test%2Fs.jpg'
        )

    def test_falls_back_to_big(self, device_settings):
        item = {'posters': {'big': 'https://cdn.test/b.jpg'}}
        assert vm.poster_url(item, device_settings).endswith(
            'url=https%3A%2F%2Fcdn.test%2Fb.jpg'
        )

    def test_wide_variant(self, device_settings):
        item = {'posters': {'wide': 'https://cdn.test/w.jpg', 'big': 'https://cdn.test/b.jpg'}}
        assert vm.poster_url(item, device_settings, wide=True).endswith(
            'url=https%3A%2F%2Fcdn.test%2Fw.jpg'
        )

    def test_missing_posters_is_none(self, device_settings):
        assert vm.poster_url({}, device_settings) is None
        assert vm.poster_url({'posters': {}}, device_settings) is None

    def test_result_routed_through_proxy(self, device_settings):
        item = {'posters': {'big': 'https://cdn.test/b.jpg'}}
        assert '/api/v1/proxy?url=' in vm.poster_url(item, device_settings)


class TestCard:
    def test_stamps_and_ratings(self, device_settings):
        card = vm.card(kp_item(7), device_settings)
        assert card['id'] == 7
        assert card['year'] == 2020
        assert card['kinopoisk_rating'] == 7.5
        assert card['is_4k'] is False
        assert card['watched'] is False
        assert '/api/v1/proxy?url=' in card['poster']
        assert 'backdrop' in card

    def test_flags(self, device_settings):
        card = vm.card(kp_item(1, quality=2160, watched=1, new=4), device_settings)
        assert card['is_4k'] is True
        assert card['watched'] is True
        assert card['new_episodes'] == 4

    def test_episode_media_subtitle_and_progress(self, device_settings):
        media = {'season': 1, 'number': 3, 'title': 'Пилот', 'duration': 100, 'time': 50}
        card = vm.card(kp_item(1), device_settings, media=media)
        assert card['subtitle'] == '[S1/E3] Пилот'
        assert card['media'] == {'season': 1, 'number': 3, 'title': 'Пилот'}
        assert card['progress'] == 50

    def test_movie_media_has_no_subtitle(self, device_settings):
        card = vm.card(kp_item(1), device_settings, media={'time': 10, 'duration': 60})
        assert 'subtitle' not in card
        assert 'media' not in card
        assert 'progress' not in card

    def test_unstarted_episode_has_no_progress(self, device_settings):
        media = {'season': 1, 'number': 1, 'duration': 100, 'time': 0}
        card = vm.card(kp_item(1), device_settings, media=media)
        assert 'progress' not in card


def file_entry(quality, **urls):
    return {'quality': quality, 'url': urls}


class TestStreamUrl:
    def test_exact_quality_match_wins(self, prefs):
        playable = {'files': [
            file_entry('720p', hls4='u720'),
            file_entry('1080p', hls4='u1080'),
            file_entry('2160p', hls4='u4k'),
        ]}
        assert vm.stream_url(playable) == 'u1080'

    def test_closest_not_above_target(self, prefs):
        playable = {'files': [
            file_entry('480p', hls4='u480'),
            file_entry('720p', hls4='u720'),
        ]}
        assert vm.stream_url(playable) == 'u720'

    def test_above_target_only_as_last_resort(self, prefs):
        playable = {'files': [
            file_entry('2160p', hls4='u4k'),
            file_entry('720p', hls4='u720'),
        ]}
        assert vm.stream_url(playable) == 'u720'

    def test_only_above_target_takes_it(self, prefs):
        playable = {'files': [file_entry('2160p', hls4='u4k')]}
        assert vm.stream_url(playable) == 'u4k'

    def test_protocol_preferred_within_same_quality(self, prefs):
        playable = {'files': [
            file_entry('1080p', hls2='u2'),
            file_entry('1080p', hls4='u4'),
        ]}
        assert vm.stream_url(playable) == 'u4'

    def test_protocol_fallback_follows_priority(self, prefs):
        playable = {'files': [file_entry('1080p', http='uh', hls='uhls')]}
        assert vm.stream_url(playable) == 'uhls'

    def test_unknown_quality_sorts_last(self, prefs):
        playable = {'files': [
            file_entry('3D', hls4='u3d'),
            file_entry('480p', hls4='u480'),
        ]}
        assert vm.stream_url(playable) == 'u480'

    def test_files_without_urls_are_skipped(self, prefs):
        assert vm.stream_url({'files': [{'quality': '1080p'}]}) is None
        assert vm.stream_url({'files': []}) is None
        assert vm.stream_url({}) is None


def season(number, *episodes):
    return {'number': number, 'episodes': list(episodes)}


def ep(number, watched=0):
    return {'number': number, 'watched': watched}


class TestPickPlayable:
    def test_explicit_season_and_episode(self):
        item = {'seasons': [season(1, ep(1, watched=1)), season(2, ep(1), ep(2))]}
        chosen = vm.pick_playable(item, season=2, episode=2)
        assert chosen['number'] == 2
        assert chosen['season'] == 2

    def test_unknown_season_returns_none(self):
        item = {'seasons': [season(1, ep(1))]}
        assert vm.pick_playable(item, season=9) is None

    def test_unknown_episode_returns_none(self):
        item = {'seasons': [season(1, ep(1))]}
        assert vm.pick_playable(item, season=1, episode=9) is None

    def test_first_unfinished_season_by_default(self):
        item = {'seasons': [
            season(1, ep(1, watched=1), ep(2, watched=1)),
            season(2, ep(1), ep(2)),
        ]}
        chosen = vm.pick_playable(item)
        assert chosen['season'] == 2
        assert chosen['number'] == 1

    def test_first_unfinished_episode_within_season(self):
        item = {'seasons': [season(1, ep(1, watched=1), ep(2), ep(3))]}
        chosen = vm.pick_playable(item, season=1)
        assert chosen['number'] == 2

    def test_all_watched_falls_back_to_first(self):
        item = {'seasons': [season(1, ep(1, watched=1)), season(2, ep(1, watched=1))]}
        chosen = vm.pick_playable(item)
        assert chosen['season'] == 1
        assert chosen['number'] == 1

    def test_season_without_episodes_is_none(self):
        item = {'seasons': [season(1)]}
        assert vm.pick_playable(item) is None

    def test_single_video_returned_as_is(self):
        item = {'videos': [{'number': 1, 'watched': 1}]}
        assert vm.pick_playable(item) == {'number': 1, 'watched': 1}

    def test_video_explicit_number(self):
        item = {'videos': [ep(1), ep(2)]}
        assert vm.pick_playable(item, episode=2) == ep(2)

    def test_first_unwatched_video(self):
        item = {'videos': [ep(1, watched=1), ep(2)]}
        assert vm.pick_playable(item) == ep(2)

    def test_no_videos_or_seasons_is_none(self):
        assert vm.pick_playable({}) is None
        assert vm.pick_playable({'seasons': [], 'videos': []}) is None


class TestPlayableInfo:
    def test_payload_shaping(self, device_settings):
        playable = {
            'number': 3,
            'title': 'Серия 3',
            'duration': 3000,
            'watching': {'time': 600},
            'watched': 0,
            'thumbnail': 'https://cdn.test/thumb.jpg',
            'files': [file_entry('1080p', hls4='https://cdn.test/v.m3u8')],
            'subtitles': [
                {'lang': 'rus', 'url': 'https://subs.test/1.srt'},
                {'lang': 'eng', 'url': 'https://subs.test/2.srt'},
            ],
        }
        info = vm.playable_info(kp_item(9), playable)
        assert info['content_id'] == 9
        assert info['title'] == 'Серия 3'
        assert info['episode'] == 3
        assert info['duration'] == 3000
        assert info['position'] == 600
        assert info['watched'] is False
        assert '/api/v1/proxy?url=' in info['url']
        assert 'cdn.test%2Fv.m3u8' in info['url']
        assert '/api/v1/proxy?url=' in info['thumbnail']
        assert [s['label'] for s in info['subtitles']] == ['RUS #01', 'ENG #02']
        assert all('/api/v1/subtitle?url=' in s['url'] for s in info['subtitles'])

    def test_subtitle_domains_registered_in_allowlist(self, fresh_db, device_settings):
        playable = {
            'files': [file_entry('1080p', hls4='https://cdn.test/v.m3u8')],
            'subtitles': [{'lang': 'rus', 'url': 'https://subs.test/1.srt'}],
        }
        vm.playable_info(kp_item(1), playable)
        assert proxy.domain_exists('subs.test')

    def test_defaults_when_optional_fields_missing(self, device_settings):
        playable = {'files': [file_entry('1080p', hls4='u')]}
        info = vm.playable_info(kp_item(2), playable)
        assert info['position'] == 0
        assert info['watched'] is False
        assert info['subtitles'] == []
        assert 'thumbnail' not in info
