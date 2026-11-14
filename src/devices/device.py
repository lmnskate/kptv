from devices import storage
from devices.settings import DeviceSettings
from kinopub.client import KinoPub

# KinoPub device-setting keys by our settings attribute (synced upstream)
KP_SETTING_KEYS = {
    'uhd': 'support4k',
    'hdr': 'supportHdr',
    'hevc': 'supportHevc',
}


class Device:
    """A client device (TV/browser): identity, OAuth tokens, settings and a
    KinoPub API client. Backed by the `devices` SQLite table."""

    def __init__(
        self,
        data
    ):
        self.id = data.get('id')
        self.code = data.get('code')
        self.token = data.get('token')
        self.refresh = data.get('refresh')
        self.kp = KinoPub(
            self.token,
            self.refresh,
            self.id
        )
        self.settings = DeviceSettings(data.get('settings'))
        self.user_agent = data.get('user_agent')

    def registered(
        self
    ):
        return self.token is not None

    @classmethod
    def by_id(
        cls,
        device_id
    ):
        entry = storage.get_device_by_id(device_id)
        if entry is None:
            return None

        return cls(entry)

    @classmethod
    def create(
        cls,
        device_id
    ):
        entry = storage.create_device({'id': device_id})
        if entry is None:
            entry = storage.get_device_by_id(device_id)

        return cls(entry)

    def update_code(
        self,
        code
    ):
        storage.update_device_code(
            self.id,
            code
        )

    async def update_tokens(
        self,
        token,
        refresh
    ):
        if self.kp is not None:
            await self.kp.close_session()

        storage.update_device_tokens(
            self.id,
            token,
            refresh
        )
        self.token = token
        self.refresh = refresh
        self.kp = KinoPub(
            token,
            refresh,
            self.id
        )

    def update_settings(
        self
    ):
        storage.update_device_settings(
            self.id,
            self.settings.to_dict()
        )

    async def notify(
        self
    ):
        await self.kp.api(
            '/device/notify',
            {
                'title': 'KPTV',
                'hardware': 'unknown',
                'software': self.id
            },
            method='POST'
        )

    async def sync_settings_to_kp(
        self,
        attrs
    ):
        """Best-effort push of the given settings attrs to the KinoPub device
        settings; the local value is the source of truth even if it fails."""
        device_info = await self.kp.api('/device/info')
        if device_info is None:
            return

        kp_device_id = (device_info.get('device') or {}).get('id')
        if kp_device_id is None:
            return

        for attr in attrs:
            key = KP_SETTING_KEYS.get(attr)
            if key is None:
                continue
            await self.kp.api(
                f'/device/{kp_device_id}/settings',
                {key: getattr(self.settings, attr)},
                'POST'
            )

    def update_user_agent(
        self,
        user_agent
    ):
        storage.update_device_user_agent(
            self.id,
            user_agent
        )
