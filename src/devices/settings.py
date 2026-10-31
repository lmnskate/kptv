class DeviceSettings:
    """Per-device playback/view preferences (persisted in the devices row)."""

    def __init__(
        self,
        data
    ):
        if data is None:
            data = {}

        self.uhd = data.get('uhd', False)
        self.hevc = data.get('hevc', False)
        self.hdr = data.get('hdr', False)
        self.poster_size = data.get('poster_size')
        if self.poster_size is None:
            self.poster_size = 'small' if data.get('small_posters', False) else 'big'

    def to_dict(
        self
    ):
        return {
            'uhd': self.uhd,
            'hevc': self.hevc,
            'hdr': self.hdr,
            'poster_size': self.poster_size,
        }
