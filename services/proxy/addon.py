"""mitmproxy entry point: `mitmdump -s addon.py`."""

from proxy_addon.forwarder import TremurexAddon

addons = [TremurexAddon()]
